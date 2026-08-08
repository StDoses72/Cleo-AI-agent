from __future__ import annotations

import argparse
import asyncio
from contextlib import nullcontext

from langchain_core.messages import HumanMessage

import cleo.agents as agents_module
import cleo.cli.chat_tui as chat_tui
from cleo.cli.chat_tui import CleoChatApp
from cleo.runtime.usage import ContextWindowUsage


class FakeRuntime:
    def __init__(self) -> None:
        self.current_space = "non_productivity"
        self.current_project: str | None = "general"
        self.current_thread_id: str | None = "local-current"
        self.projects = ["general"]
        self.recent: list[str] = []

    def update_current_space(self, value):
        self.current_space = value

    def update_current_project(self, value):
        self.current_project = value
        if value is not None and value not in self.projects:
            self.projects.append(value)

    def update_current_thread_id(self, value):
        self.current_thread_id = value

    def append_recent_threads(self, thread_id, _space):
        self.recent.append(thread_id)

    def projects_for(self, _space=None):
        return list(self.projects)

    def update_runtime_json(self):
        return None


class FakeStore:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def list_sessions(self, *, space=None, project=None, **_kwargs):
        rows = self.rows
        if space is not None:
            rows = [row for row in rows if row.get("space") == space]
        if project is not None:
            rows = [row for row in rows if row.get("project") == project]
        return list(rows)


class StreamingAgent:
    model_name = "cleo-test"

    def __init__(self, *, project="general", space="non_productivity") -> None:
        self.project = project
        self.space = space
        self.context_usage = ContextWindowUsage(window_tokens=100_000)

    async def stream_text(self, *_args, **_kwargs):
        self.context_usage.update(used_tokens=2_000)
        yield "Hello "
        yield "from Cleo."


async def _no_sync(*_args, **_kwargs) -> None:
    return None


def test_cleo_chat_uses_full_screen_textual_composer_and_streaming(monkeypatch) -> None:
    monkeypatch.setattr(chat_tui, "_sync_session_events", _no_sync)
    app = CleoChatApp(
        StreamingAgent(),
        FakeRuntime(),
        "local-current",
        FakeStore(),
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await app.workers.wait_for_complete()
            await pilot.pause()
            composer = app.query_one("#composer")
            prompt = app.query_one("#prompt")
            assert prompt.region.bottom <= composer.content_region.bottom

            prompt.value = "hello"
            await pilot.press("enter")
            worker = app._active_worker
            assert worker is not None
            await worker.wait()

            cards = list(app.query(".assistant-message"))
            assert any("Hello from Cleo" in str(card.render()) for card in cards)
            assert "2,000 / 100,000" in str(app.query_one("#statusbar").render())

    asyncio.run(scenario())


def test_cleo_project_command_switches_memory_namespace(monkeypatch) -> None:
    monkeypatch.setattr(chat_tui, "_sync_session_events", _no_sync)
    monkeypatch.setattr(chat_tui, "_launch_dream_agent_worker", lambda _jobs: True)
    monkeypatch.setattr(agents_module, "Agent", StreamingAgent)
    runtime = FakeRuntime()
    app = CleoChatApp(
        StreamingAgent(),
        runtime,
        "local-current",
        FakeStore(),
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await app.workers.wait_for_complete()
            app._start_submission("/project research")
            worker = app._active_worker
            assert worker is not None
            await worker.wait()
            assert runtime.current_project == "research"
            assert app.agent.project == "research"
            assert app.thread_id != "local-current"
            assert "MEMORY PROJECT" in str(app.query_one("#control-card").render())
            await pilot.pause()

    asyncio.run(scenario())


def test_cleo_session_picker_click_resumes_conversation(monkeypatch) -> None:
    class SessionStore(FakeStore):
        def __init__(self) -> None:
            super().__init__()
            self.rows = [
                {
                    "id": "local-saved",
                    "space": "non_productivity",
                    "project": "research",
                    "provider": "cleo",
                    "status": "completed",
                    "title": "Saved research",
                }
            ]

        def load_manifest(self, session_id):
            assert session_id == "local-saved"
            return self.rows[0]

        def load_langchain_messages(self, session_id):
            assert session_id == "local-saved"
            return [HumanMessage(content="Existing context")]

    monkeypatch.setattr(chat_tui, "_sync_session_events", _no_sync)
    monkeypatch.setattr(agents_module, "Agent", StreamingAgent)
    app = CleoChatApp(
        StreamingAgent(),
        FakeRuntime(),
        "local-current",
        SessionStore(),
    )

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)) as pilot:
            await app.workers.wait_for_complete()
            app._start_submission("/sessions")
            worker = app._active_worker
            assert worker is not None
            await pilot.pause(0.1)
            options = app.screen.query_one("#chat-session-options")
            for _ in range(20):
                if options.region.width and options.region.bottom <= app.screen.region.bottom:
                    break
                await pilot.pause(0.02)
            await pilot.click(options, offset=(4, 3))
            await worker.wait()
            assert app.thread_id == "local-saved"
            assert app.runtime.current_project == "research"
            assert "Existing context" in str(app.query_one(".user-message").render())

    asyncio.run(scenario())


def test_cleo_can_suspend_into_productivity_and_restore_context(monkeypatch) -> None:
    calls: list[argparse.Namespace] = []

    async def fake_productivity(args, runtime, _store, _settings, *, return_to_chat):
        assert return_to_chat is True
        calls.append(args)
        runtime.update_current_space("productivity")
        runtime.update_current_project("workspace")
        runtime.update_current_thread_id("agent-workspace")

    monkeypatch.setattr(chat_tui, "_sync_session_events", _no_sync)
    monkeypatch.setattr(chat_tui, "_run_productivity_mode", fake_productivity)
    runtime = FakeRuntime()
    app = CleoChatApp(
        StreamingAgent(),
        runtime,
        "local-current",
        FakeStore(),
    )
    app.suspend = lambda: nullcontext()

    async def scenario() -> None:
        async with app.run_test(size=(120, 40)):
            await app.workers.wait_for_complete()
            app._start_submission("/productivity")
            worker = app._active_worker
            assert worker is not None
            await worker.wait()

    asyncio.run(scenario())
    assert len(calls) == 1
    assert calls[0].project is None
    assert runtime.current_space == "non_productivity"
    assert runtime.current_project == "general"
    assert runtime.current_thread_id == "local-current"


def test_cleo_quit_exits_without_starting_lifecycle_worker(monkeypatch) -> None:
    sync_called = False

    async def hanging_sync(*_args, **_kwargs):
        nonlocal sync_called
        sync_called = True
        await asyncio.Future()

    launched: list[list[tuple[str, str | None, str]]] = []
    monkeypatch.setattr(chat_tui, "_sync_session_events", hanging_sync)
    monkeypatch.setattr(
        chat_tui,
        "_launch_dream_agent_worker",
        lambda jobs: launched.append(list(jobs)) or True,
    )
    runtime = FakeRuntime()
    app = CleoChatApp(
        StreamingAgent(),
        runtime,
        "local-current",
        FakeStore(),
    )
    app._start_submission("/quit")

    assert app._cleo_exit_requested is True
    assert app._closing is False
    assert app._exit is True
    assert app.session_closed is True
    assert app._active_worker is None
    assert sync_called is False
    assert launched == []
    assert app._deferred_consolidations == [
        ("local-current", "general", "non_productivity")
    ]


def test_cleo_cancelled_turn_is_persisted_as_interrupted(monkeypatch) -> None:
    statuses: list[str] = []

    async def cancelled_turn(_prompt: str) -> None:
        raise asyncio.CancelledError

    async def record_sync(_agent, _runtime, _thread_id, _messages, *, status, store):
        statuses.append(status)

    monkeypatch.setattr(chat_tui, "_sync_session_events", record_sync)
    app = CleoChatApp(
        StreamingAgent(),
        FakeRuntime(),
        "local-current",
        FakeStore(),
    )
    monkeypatch.setattr(app, "_append_user", _no_sync)
    monkeypatch.setattr(app, "_run_agent_turn", cancelled_turn)
    monkeypatch.setattr(app, "_append_notice", _no_sync)
    monkeypatch.setattr(app, "_set_busy", lambda _busy: None)

    asyncio.run(app._dispatch("cancel me"))

    assert statuses == ["interrupted"]
