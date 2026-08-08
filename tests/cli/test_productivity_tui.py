from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from cleo.cli import productivity as productivity_cli
from cleo.cli.productivity_tui import (
    DiffBlock,
    ProductivityApp,
    ProjectChoice,
    ProjectPicker,
    SessionPicker,
)
from cleo.harnesses import (
    AgentEvent,
    AgentResult,
    AgentSession,
    HarnessModel,
    NativeSession,
    NativeSessionDetail,
    NativeSessionPage,
    SessionOptions,
)
from cleo.runtime.usage import RateLimitWindowUsage


class FakeRuntime:
    def __init__(self) -> None:
        self.current_project: str | None = "cleo"
        self.current_thread_id: str | None = "agent-initial"
        self.recent: list[str] = []

    def update_current_project(self, value) -> None:
        self.current_project = value

    def update_current_thread_id(self, value) -> None:
        self.current_thread_id = value

    def append_recent_threads(self, session_id, _space) -> None:
        self.recent.append(session_id)

    def update_runtime_json(self) -> None:
        return None


class EmptyStore:
    def list_sessions(self, **_kwargs):
        return []


class StreamingAdapter:
    def __init__(self) -> None:
        self.options = SessionOptions(model="gpt-test", effort="medium")
        self.changes: list[dict[str, str]] = []

    async def list_models(self, _provider):
        return (
            HarnessModel(
                id="gpt-test",
                display_name="GPT Test",
                description="",
                is_default=True,
                default_effort="medium",
                supported_efforts=("medium", "high"),
            ),
        )

    async def list_native_sessions(self, _provider, limit=50):
        assert limit == 50
        return NativeSessionPage(())

    async def account_rate_limits(self, _session_id):
        return (
            RateLimitWindowUsage(used_percent=20, window_minutes=300),
            RateLimitWindowUsage(used_percent=35, window_minutes=10_080),
        )

    def session_options(self, _session_id):
        return self.options

    async def update_session_options(self, _session_id, **changes):
        self.changes.append(changes)
        self.options = SessionOptions(
            model=changes.get("model", self.options.model),
            effort=changes.get("effort", self.options.effort),
            sandbox=changes.get("sandbox", self.options.sandbox),
            approval_mode=changes.get("approval_mode", self.options.approval_mode),
        )
        return self.options

    async def prompt(self, session_id, _prompt, on_event):
        await on_event(
            AgentEvent(
                provider="codex",
                type="status",
                data={
                    "provider_event_type": "thread/tokenUsage/updated",
                    "payload": {
                        "tokenUsage": {
                            "total": {"totalTokens": 40_000},
                            "last": {"inputTokens": 8_000, "outputTokens": 1_000},
                            "modelContextWindow": 100_000,
                        }
                    },
                },
            )
        )
        await on_event(
            AgentEvent(
                provider="codex",
                type="assistant_message_chunk",
                text="Implemented the change.",
            )
        )
        await on_event(
            AgentEvent(
                provider="codex",
                type="file_change",
                text=(
                    "diff --git a/app.py b/app.py\n"
                    "--- a/app.py\n"
                    "+++ b/app.py\n"
                    "-old value\n"
                    "+new value\n"
                ),
                data={"provider_event_type": "turn/diff/updated"},
            )
        )
        return AgentResult(
            session_id=session_id,
            provider="codex",
            native_session_id="native-1",
            turn_id="turn-1",
            status="completed",
            response="Implemented the change.",
        )


def test_history_fallback_does_not_hide_programming_errors(tmp_path) -> None:
    class BrokenHistoryAdapter(StreamingAdapter):
        async def read_native_session(self, _provider, _native_session_id):
            raise TypeError("unexpected response shape")

    app = ProductivityApp(
        BrokenHistoryAdapter(),
        AgentSession(
            id="agent-initial",
            provider="codex",
            native_session_id="native-1",
            project_path=str(tmp_path),
            project="cleo",
        ),
        FakeRuntime(),
        EmptyStore(),
        model="gpt-test",
    )

    with pytest.raises(TypeError, match="unexpected response shape"):
        asyncio.run(
            app._load_session_history(
                provider="codex",
                native_session_id="native-1",
                managed_session_id=None,
            )
        )


def test_textual_streams_agent_output_and_click_toggles_diff(tmp_path) -> None:
    adapter = StreamingAdapter()
    app = ProductivityApp(
        adapter,
        AgentSession(
            id="agent-initial",
            provider="codex",
            native_session_id="native-1",
            project_path=str(tmp_path),
            project="cleo",
        ),
        FakeRuntime(),
        EmptyStore(),
        model="gpt-test",
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await app.workers.wait_for_complete()
            await pilot.pause()
            composer = app.query_one("#composer")
            prompt_widget = app.query_one("#prompt")
            assert prompt_widget.region.bottom <= composer.content_region.bottom
            status = str(app.query_one("#statusbar").render())
            assert "5H 80% left" in status
            assert "WEEK 65% left" in status

            prompt = app.query_one("#prompt")
            prompt.value = "implement it"
            await pilot.press("enter")
            await pilot.pause()
            assert app._active_worker is not None
            await app._active_worker.wait()

            blocks = list(app.query(DiffBlock))
            assert len(blocks) == 1
            block = blocks[0]
            assert block.collapsed is True
            assert "new value" not in str(block.render())

            await pilot.click(block.query_one("CollapsibleTitle"))
            await pilot.pause()
            assert block.collapsed is False
            assert app.context_usage.used_tokens == 40_000

            assistant_cards = list(app.query(".assistant-message"))
            assert len(assistant_cards) == 1
            assert "Implemented the change" in str(assistant_cards[0].render())

            app._start_submission("/effort high")
            assert app._active_worker is not None
            await app._active_worker.wait()
            assert adapter.changes[-1] == {"effort": "high"}
            assert "high" in str(app.query_one("#control-card").render())

    asyncio.run(scenario())


def test_textual_resume_then_change_cwd_keeps_backend_lifecycle(tmp_path, monkeypatch) -> None:
    current = tmp_path / "current"
    target = current / "nested"
    target.mkdir(parents=True)
    initial = AgentSession(
        id="agent-initial",
        provider="codex",
        native_session_id="native-initial",
        project_path=str(current),
        project="cleo",
    )

    class Store(EmptyStore):
        def load_manifest(self, session_id):
            assert session_id == "agent-saved"
            return {
                "id": session_id,
                "space": "productivity",
                "project": "cleo",
                "provider": "claude",
                "native_session_id": "native-saved",
                "cwd": str(current),
            }

    class Adapter:
        def __init__(self) -> None:
            self.closed: list[str] = []
            self.models: list[tuple[str, str | None]] = []
            self.created_cwd: str | None = None

        async def list_models(self, _provider):
            return ()

        async def list_native_sessions(self, _provider, limit=50):
            return NativeSessionPage(())

        async def read_native_session(self, _provider, _native_session_id):
            raise NotImplementedError

        def session_options(self, _session_id):
            return SessionOptions()

        async def resume_session(
            self,
            provider,
            native_session_id,
            project_path,
            model,
            project,
        ):
            self.models.append((provider, model))
            return AgentSession(
                id="agent-saved",
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                project=project,
            )

        async def create_session(self, provider, project_path, model, project):
            self.created_cwd = project_path
            self.models.append((provider, model))
            return AgentSession(
                id="agent-cd",
                provider=provider,
                native_session_id="native-cd",
                project_path=project_path,
                project=project,
            )

        async def close(self, session_id):
            self.closed.append(session_id)

    async def fake_dream(*_args, **_kwargs):
        return None

    monkeypatch.setattr(productivity_cli, "_run_dream_agent", fake_dream)
    adapter = Adapter()
    app = ProductivityApp(
        adapter,
        initial,
        FakeRuntime(),
        Store(),
        model=None,
        provider_models={"codex": "gpt-test", "claude": "claude-test"},
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.1)
            app._start_submission("/resume agent-saved")
            assert app._active_worker is not None
            await app._active_worker.wait()
            assert app.session.provider == "claude"
            assert app.active_model == "claude-test"

            app._start_submission("/cd nested")
            assert app._active_worker is not None
            await app._active_worker.wait()
            assert app.session.id == "agent-cd"

    asyncio.run(scenario())

    assert Path(adapter.created_cwd or "") == target
    assert adapter.models == [
        ("claude", "claude-test"),
        ("claude", "claude-test"),
    ]
    assert adapter.closed == ["agent-initial", "agent-saved"]


def test_sessions_picker_click_resumes_saved_productivity_session(
    tmp_path,
    monkeypatch,
) -> None:
    initial = AgentSession(
        id="agent-initial",
        provider="codex",
        native_session_id="native-initial",
        project_path=str(tmp_path),
        project="cleo",
    )

    class Store(EmptyStore):
        def list_sessions(self, **kwargs):
            assert kwargs == {"space": "productivity"}
            return [
                {
                    "id": "agent-saved",
                    "space": "productivity",
                    "project": "cleo",
                    "provider": "codex",
                    "native_session_id": "native-saved",
                    "cwd": str(tmp_path),
                    "status": "closed",
                    "title": "Saved work",
                    "updated_at": "2026-08-05T10:00:00Z",
                }
            ]

        def load_manifest(self, session_id):
            assert session_id == "agent-saved"
            return self.list_sessions(space="productivity")[0]

    class Adapter:
        def __init__(self) -> None:
            self.closed: list[str] = []

        async def list_models(self, _provider):
            return ()

        async def list_native_sessions(self, _provider, limit=50):
            return NativeSessionPage(())

        def session_options(self, _session_id):
            return SessionOptions()

        async def read_native_session(self, provider, native_session_id):
            assert provider == "codex"
            assert native_session_id == "native-saved"
            return NativeSessionDetail(
                session=NativeSession(
                    id=native_session_id,
                    name="Saved work",
                    preview="Earlier request",
                    cwd=str(tmp_path),
                    status="idle",
                    source="cli",
                    model_provider="openai",
                    created_at="2026-08-05T09:00:00Z",
                    updated_at="2026-08-05T10:00:00Z",
                ),
                turns=(
                    {
                        "id": "turn-saved",
                        "items": [
                            {
                                "id": "user-saved",
                                "type": "userMessage",
                                "content": [
                                    {"type": "text", "text": "Earlier request"}
                                ],
                            },
                            {
                                "id": "agent-saved",
                                "type": "agentMessage",
                                "text": "Earlier response",
                            },
                        ],
                    },
                ),
            )

        async def resume_session(
            self,
            provider,
            native_session_id,
            project_path,
            model,
            project,
        ):
            assert native_session_id == "native-saved"
            return AgentSession(
                id="agent-saved",
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                project=project,
            )

        async def close(self, session_id):
            self.closed.append(session_id)

    async def fail_if_dream_runs(*_args, **_kwargs):
        raise AssertionError("interactive navigation must not block on DreamAgent")

    monkeypatch.setattr(productivity_cli, "_run_dream_agent", fail_if_dream_runs)
    adapter = Adapter()
    app = ProductivityApp(
        adapter,
        initial,
        FakeRuntime(),
        Store(),
        model=None,
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.1)
            app._start_submission("/sessions")
            worker = app._active_worker
            assert worker is not None
            await pilot.pause(0.1)
            assert isinstance(app.screen, SessionPicker)
            options = app.screen.query_one("#session-options")
            for _ in range(20):
                if options.region.width and options.region.bottom <= app.screen.region.bottom:
                    break
                await pilot.pause(0.02)
            await pilot.click(options, offset=(4, 1))
            await worker.wait()
            assert app.session.id == "agent-saved"
            assert "Earlier request" in str(app.query_one(".user-message").render())
            assert "Earlier response" in str(
                app.query_one(".assistant-message").render()
            )

    asyncio.run(scenario())
    assert adapter.closed == ["agent-initial"]


def test_sessions_picker_imports_native_codex_thread_with_history(tmp_path) -> None:
    native = NativeSession(
        id="native-external",
        name="Codex app work",
        preview="Native question",
        cwd=str(tmp_path),
        status="idle",
        source="app",
        model_provider="openai",
        created_at="2026-08-05T09:00:00Z",
        updated_at="2026-08-05T10:00:00Z",
    )

    class Adapter:
        def __init__(self) -> None:
            self.closed: list[str] = []

        async def list_models(self, _provider):
            return ()

        async def list_native_sessions(self, _provider, limit=50):
            assert limit == 50
            return NativeSessionPage((native,))

        def session_options(self, _session_id):
            return SessionOptions()

        async def read_native_session(self, provider, native_session_id):
            assert provider == "codex"
            assert native_session_id == native.id
            return NativeSessionDetail(
                session=native,
                turns=(
                    {
                        "id": "native-turn",
                        "items": [
                            {
                                "id": "native-user",
                                "type": "userMessage",
                                "content": [
                                    {"type": "text", "text": "Native question"}
                                ],
                            },
                            {
                                "id": "native-agent",
                                "type": "agentMessage",
                                "text": "Native answer",
                            },
                        ],
                    },
                ),
            )

        async def resume_session(
            self,
            provider,
            native_session_id,
            project_path,
            model,
            project,
        ):
            assert native_session_id == native.id
            return AgentSession(
                id="agent-imported",
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                project=project,
            )

        async def close(self, session_id):
            self.closed.append(session_id)

    adapter = Adapter()
    app = ProductivityApp(
        adapter,
        AgentSession(
            id="agent-initial",
            provider="codex",
            native_session_id="native-initial",
            project_path=str(tmp_path),
            project=tmp_path.name,
        ),
        FakeRuntime(),
        EmptyStore(),
        model=None,
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await app.workers.wait_for_complete()
            app._start_submission("/sessions")
            worker = app._active_worker
            assert worker is not None
            await pilot.pause(0.1)
            options = app.screen.query_one("#session-options")
            await pilot.click(options, offset=(4, 1))
            await worker.wait()

            assert app.session.id == "agent-imported"
            assert app.session.native_session_id == native.id
            assert "Native question" in str(app.query_one(".user-message").render())
            assert "Native answer" in str(
                app.query_one(".assistant-message").render()
            )

    asyncio.run(scenario())
    assert adapter.closed == ["agent-initial"]


def test_initial_managed_resume_restores_saved_event_history(tmp_path) -> None:
    class Store(EmptyStore):
        def read_events(self, session_id):
            assert session_id == "agent-saved"
            return [
                {"type": "user_message", "content": "Saved question"},
                {"type": "assistant_message", "content": "Saved answer"},
            ]

    class Adapter:
        async def list_models(self, _provider):
            return ()

        async def list_native_sessions(self, _provider, limit=50):
            return NativeSessionPage(())

        async def read_native_session(self, _provider, _native_session_id):
            raise NotImplementedError

        def session_options(self, _session_id):
            return SessionOptions()

    app = ProductivityApp(
        Adapter(),
        AgentSession(
            id="agent-saved",
            provider="codex",
            native_session_id="native-saved",
            project_path=str(tmp_path),
            project=tmp_path.name,
        ),
        FakeRuntime(),
        Store(),
        model=None,
        restore_initial_history=True,
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)):
            await app.workers.wait_for_complete()
            assert "Saved question" in str(app.query_one(".user-message").render())
            assert "Saved answer" in str(
                app.query_one(".assistant-message").render()
            )

    asyncio.run(scenario())


def test_project_picker_click_opens_recent_project(tmp_path, monkeypatch) -> None:
    current = tmp_path / "current"
    target = tmp_path / "target"
    current.mkdir()
    target.mkdir()
    initial = AgentSession(
        id="agent-initial",
        provider="codex",
        native_session_id="native-initial",
        project_path=str(current),
        project="current",
    )

    class Store(EmptyStore):
        def list_sessions(self, **kwargs):
            assert kwargs == {"space": "productivity"}
            return [
                {
                    "id": "agent-target",
                    "space": "productivity",
                    "project": "target",
                    "provider": "codex",
                    "native_session_id": "native-target",
                    "cwd": str(target),
                    "status": "closed",
                    "title": "Target work",
                    "updated_at": "2026-08-05T10:00:00Z",
                }
            ]

    class Adapter:
        def __init__(self) -> None:
            self.created: tuple[str, str] | None = None

        async def list_models(self, _provider):
            return ()

        async def list_native_sessions(self, _provider, limit=50):
            return NativeSessionPage(())

        def session_options(self, _session_id):
            return SessionOptions()

        async def create_session(self, provider, project_path, model, project):
            self.created = (project, project_path)
            return AgentSession(
                id="agent-project",
                provider=provider,
                native_session_id=None,
                project_path=project_path,
                project=project,
            )

        async def close(self, _session_id):
            return None

    async def fail_if_dream_runs(*_args, **_kwargs):
        raise AssertionError("project selection must not block on DreamAgent")

    monkeypatch.setattr(productivity_cli, "_run_dream_agent", fail_if_dream_runs)
    adapter = Adapter()
    app = ProductivityApp(
        adapter,
        initial,
        FakeRuntime(),
        Store(),
        model=None,
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await pilot.pause(0.1)
            app._start_submission("/project")
            worker = app._active_worker
            assert worker is not None
            await pilot.pause(0.1)
            assert isinstance(app.screen, ProjectPicker)
            options = app.screen.query_one("#project-options")
            for _ in range(20):
                if options.region.width and options.region.bottom <= app.screen.region.bottom:
                    break
                await pilot.pause(0.02)
            await pilot.click(options, offset=(4, 4))
            await worker.wait()
            assert app.session.project == "target"
            assert Path(app.session.project_path) == target.resolve()

    asyncio.run(scenario())
    assert adapter.created is not None
    assert adapter.created[0] == "target"
    assert Path(adapter.created[1]) == target.resolve()


def test_project_picker_treats_workspace_path_as_project_identity(tmp_path) -> None:
    current = tmp_path / "current"
    current.mkdir()

    class Adapter:
        async def list_models(self, _provider):
            return ()

        async def list_native_sessions(self, _provider, limit=50):
            return NativeSessionPage(())

        def session_options(self, _session_id):
            return SessionOptions()

        async def create_session(self, *_args, **_kwargs):
            raise AssertionError("selecting the open workspace must not create a session")

    app = ProductivityApp(
        Adapter(),
        AgentSession(
            id="agent-initial",
            provider="codex",
            native_session_id="native-initial",
            project_path=str(current),
            project="legacy-memory-label",
        ),
        FakeRuntime(),
        EmptyStore(),
        model=None,
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)):
            await app.workers.wait_for_complete()
            assert "current" in str(app.query_one("#topbar").render())
            assert "legacy-memory-label" not in str(app.query_one("#topbar").render())

            async def choose_current(_screen):
                return ProjectChoice(
                    project="current",
                    cwd=str(current),
                    current=True,
                )

            app.push_screen_wait = choose_current
            await app._command_project()

    asyncio.run(scenario())


def test_quit_restores_terminal_when_provider_close_hangs(tmp_path, monkeypatch) -> None:
    dream_called = False

    class Adapter:
        async def close(self, _session_id):
            await asyncio.Future()

    async def track_dream(*_args, **_kwargs):
        nonlocal dream_called
        dream_called = True

    monkeypatch.setattr(productivity_cli, "_run_dream_agent", track_dream)
    runtime = FakeRuntime()
    session = AgentSession(
        id="agent-initial",
        provider="codex",
        native_session_id="native-initial",
        project_path=str(tmp_path),
        project="cleo",
    )

    async def scenario() -> None:
        await asyncio.wait_for(
            productivity_cli._finish_productivity_session(
                Adapter(),
                session,
                runtime,
                consolidate=False,
                close_timeout_seconds=0.02,
            ),
            timeout=0.5,
        )

    asyncio.run(scenario())
    assert runtime.recent == ["agent-initial"]
    assert dream_called is False


def test_productivity_quit_exits_without_starting_cleanup_worker(tmp_path) -> None:
    app = ProductivityApp(
        object(),
        AgentSession(
            id="agent-initial",
            provider="codex",
            native_session_id="native-initial",
            project_path=str(tmp_path),
            project=tmp_path.name,
        ),
        FakeRuntime(),
        EmptyStore(),
        model=None,
    )

    app._start_submission("/quit")

    assert app._productivity_exit_requested is True
    assert app._closing is False
    assert app._exit is True
    assert app.session_closed is True
    assert app._active_worker is None
    assert app._deferred_consolidations == [
        ("agent-initial", tmp_path.name, "productivity")
    ]
