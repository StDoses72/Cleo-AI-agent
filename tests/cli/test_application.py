from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import HumanMessage

import cleo.cli.application as application
import cleo.cli.chat as chat_cli
import cleo.cli.productivity as productivity_cli
from cleo.harnesses import AgentSession


def test_main_routes_productivity_mode(tmp_path, monkeypatch) -> None:
    import cleo.config.settings as settings_module
    import cleo.runtime.state as runtime_module
    import cleo.sessions.store as session_store_module

    fake_settings = SimpleNamespace(
        MEMORY_DIR=tmp_path / "memory",
        SESSION_INDEX_PATH=tmp_path / "memory" / "sessions.sqlite3",
    )
    fake_runtime = SimpleNamespace()
    fake_store = SimpleNamespace(list_sessions=lambda **_kwargs: [])
    received: dict[str, object] = {}

    class FakeRuntime:
        def __new__(cls):
            return fake_runtime

    class FakeSessionStore:
        def __new__(cls, memory_dir, index_path):
            assert memory_dir == fake_settings.MEMORY_DIR
            assert index_path == fake_settings.SESSION_INDEX_PATH
            return fake_store

    async def fake_productivity(args, runtime, store, settings):
        received.update(
            args=args,
            runtime=runtime,
            store=store,
            settings=settings,
        )

    monkeypatch.setattr(settings_module, "settings", fake_settings)
    monkeypatch.setattr(runtime_module, "Runtime", FakeRuntime)
    monkeypatch.setattr(session_store_module, "SessionStore", FakeSessionStore)
    monkeypatch.setattr(application, "_run_productivity_mode", fake_productivity)
    monkeypatch.setattr(
        sys,
        "argv",
        ["main.py", "--productivity", "--project", "cleo", "inspect this repo"],
    )

    asyncio.run(application.amain())

    assert received["runtime"] is fake_runtime
    assert received["store"] is fake_store
    assert received["settings"] is fake_settings
    assert received["args"].productivity is True
    assert received["args"].message == "inspect this repo"


def test_chat_productivity_command_restores_cleo_context(tmp_path, monkeypatch) -> None:
    import builtins

    import cleo.config.settings as settings_module
    import cleo.sessions.store as session_store_module

    class FakeRuntime:
        current_space = "non_productivity"
        current_project = "cleo"
        current_thread_id = "cleo-thread"

        def update_current_space(self, value):
            self.current_space = value

        def update_current_project(self, value):
            self.current_project = value

        def update_current_thread_id(self, value):
            self.current_thread_id = value

        def append_recent_threads(self, *_args):
            return None

        def projects_for(self, _space=None):
            return ["general", "cleo"]

        def update_runtime_json(self):
            return None

    runtime = FakeRuntime()
    fake_store = SimpleNamespace(list_sessions=lambda **_kwargs: [])
    fake_settings = SimpleNamespace(
        MEMORY_DIR=tmp_path / "memory",
        SESSION_INDEX_PATH=tmp_path / "memory" / "sessions.sqlite3",
        active_directory_profile=SimpleNamespace(root_path=tmp_path),
    )
    productivity_calls: list[bool] = []
    input_count = 0

    class FakeSessionStore:
        def __new__(cls, *_args):
            return fake_store

    async def fake_productivity(_args, active_runtime, store, settings, *, return_to_chat):
        assert store is fake_store
        assert settings is fake_settings
        productivity_calls.append(return_to_chat)
        active_runtime.update_current_space("productivity")
        active_runtime.update_current_project("cleo")
        active_runtime.update_current_thread_id("agent-session")

    async def fake_sync(*_args, **_kwargs):
        return None

    async def fake_dream(*_args, **_kwargs):
        return None

    def fake_input(_prompt=None):
        nonlocal input_count
        input_count += 1
        if input_count == 1:
            return "/productivity"
        assert runtime.current_space == "non_productivity"
        assert runtime.current_project == "cleo"
        assert runtime.current_thread_id == "cleo-thread"
        return "/quit"

    monkeypatch.setattr(settings_module, "settings", fake_settings)
    monkeypatch.setattr(session_store_module, "SessionStore", FakeSessionStore)
    monkeypatch.setattr(chat_cli, "_run_productivity_mode", fake_productivity)
    monkeypatch.setattr(chat_cli, "_sync_session_events", fake_sync)
    monkeypatch.setattr(chat_cli, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(chat_cli, "clear_screen", lambda: None)
    monkeypatch.setattr(builtins, "input", fake_input)

    asyncio.run(
        chat_cli._run_chat_loop(
            SimpleNamespace(),
            runtime,
            "cleo-thread",
        )
    )

    assert productivity_calls == [True]


def test_productivity_cwd_resolution_and_saved_session_resume(tmp_path) -> None:
    current = tmp_path / "current"
    target = current / "nested"
    target.mkdir(parents=True)

    resolved_target = productivity_cli._resolve_productivity_cwd("nested", str(current))
    assert Path(resolved_target) == target

    manifest = {
        "id": "agent_saved",
        "space": "productivity",
        "project": "cleo",
        "provider": "codex",
        "native_session_id": "native-saved",
        "cwd": resolved_target,
    }
    received: dict[str, object] = {}

    class FakeStore:
        def load_manifest(self, session_id):
            assert session_id == "agent_saved"
            return manifest

    class FakeAdapter:
        async def resume_session(
            self,
            provider,
            native_session_id,
            project_path,
            model,
            project,
        ):
            received.update(
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                model=model,
                project=project,
            )
            return AgentSession(
                id="agent_saved",
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                project=project,
            )

    session = asyncio.run(
        productivity_cli._resume_productivity_session(
            FakeAdapter(),
            FakeStore(),
            "agent_saved",
            model="test-model",
        )
    )

    assert session.id == "agent_saved"
    assert received == {
        "provider": "codex",
        "native_session_id": "native-saved",
        "project_path": resolved_target,
        "model": "test-model",
        "project": "cleo",
    }


def test_chat_resume_command_switches_to_saved_thread(monkeypatch) -> None:
    import cleo.agents as agent_module

    class FakeRuntime:
        current_space = "non_productivity"
        current_project = "current"
        current_thread_id = "local-current"

        def __init__(self):
            self.thread_updates: list[str | None] = []

        def update_current_space(self, value):
            self.current_space = value

        def update_current_project(self, value):
            self.current_project = value

        def update_current_thread_id(self, value):
            self.current_thread_id = value
            self.thread_updates.append(value)

        def append_recent_threads(self, *_args):
            return None

        def projects_for(self, _space=None):
            return ["general", "current", "saved-project"]

        def update_runtime_json(self):
            return None

    class FakeStore:
        def list_sessions(self, **_kwargs):
            return []

        def load_manifest(self, session_id):
            assert session_id == "local-saved"
            return {
                "id": session_id,
                "space": "non_productivity",
                "project": "saved-project",
                "provider": "cleo",
            }

        def load_langchain_messages(self, session_id):
            assert session_id == "local-saved"
            return []

    created_agents: list[tuple[str, str]] = []

    class FakeAgent:
        def __init__(self, *, project, space):
            created_agents.append((project, space))

    prompts = iter(["/resume local-saved", "/quit"])
    synced_threads: list[str] = []

    async def fake_sync(_agent, _runtime, thread_id, *_args, **_kwargs):
        synced_threads.append(thread_id)

    async def fake_dream(*_args, **_kwargs):
        return None

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(chat_cli.cli, "prompt", lambda *_args, **_kwargs: next(prompts))
    monkeypatch.setattr(chat_cli, "_sync_session_events", fake_sync)
    monkeypatch.setattr(chat_cli, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(chat_cli, "clear_screen", lambda: None)

    runtime = FakeRuntime()
    asyncio.run(
        chat_cli._run_chat_loop(
            SimpleNamespace(),
            runtime,
            "local-current",
            store=FakeStore(),
        )
    )

    assert created_agents == [("saved-project", "non_productivity")]
    assert synced_threads == ["local-current", "local-saved"]
    assert "local-saved" in runtime.thread_updates


def test_chat_project_command_creates_scoped_thread(monkeypatch) -> None:
    import cleo.agents as agent_module

    class FakeRuntime:
        current_space = "non_productivity"
        current_project = "general"
        current_thread_id = "local-current"

        def __init__(self):
            self.projects = ["general"]
            self.thread_updates: list[str | None] = []

        def update_current_space(self, value):
            self.current_space = value

        def update_current_project(self, value):
            self.current_project = value
            if value is not None and value not in self.projects:
                self.projects.append(value)

        def update_current_thread_id(self, value):
            self.current_thread_id = value
            self.thread_updates.append(value)

        def append_recent_threads(self, *_args):
            return None

        def projects_for(self, _space=None):
            return list(self.projects)

        def update_runtime_json(self):
            return None

    class FakeStore:
        def list_sessions(self, **_kwargs):
            return []

        def load_manifest(self, session_id):
            assert session_id == "local-current"
            return {"last_event_seq": 2}

    created_agents: list[tuple[str, str]] = []

    class FakeAgent:
        def __init__(self, *, project, space):
            created_agents.append((project, space))

    prompts = iter(["/project research", "/project", "/quit"])
    synced_threads: list[tuple[str, str]] = []
    consolidated: list[tuple[str, str, str]] = []

    async def fake_sync(_agent, _runtime, thread_id, *_args, **kwargs):
        synced_threads.append((thread_id, kwargs["status"]))

    async def fake_dream(thread_id, project, space):
        consolidated.append((thread_id, project, space))

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(chat_cli.cli, "prompt", lambda *_args, **_kwargs: next(prompts))
    monkeypatch.setattr(chat_cli, "_sync_session_events", fake_sync)
    monkeypatch.setattr(chat_cli, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(chat_cli, "clear_screen", lambda: None)

    runtime = FakeRuntime()
    asyncio.run(
        chat_cli._run_chat_loop(
            SimpleNamespace(),
            runtime,
            "local-current",
            store=FakeStore(),
        )
    )

    assert created_agents == [("research", "non_productivity")]
    assert runtime.current_project is None
    assert "research" in runtime.projects
    assert synced_threads[0] == ("local-current", "completed")
    assert synced_threads[-1][1] == "completed"
    assert consolidated[0] == ("local-current", "general", "non_productivity")
    assert any(
        thread_id is not None and thread_id != "local-current"
        for thread_id in runtime.thread_updates
    )


def test_chat_can_rename_and_move_current_thread(monkeypatch) -> None:
    import cleo.agents as agent_module

    class FakeRuntime:
        current_space = "non_productivity"
        current_project = "general"
        current_thread_id = "local-current"

        def __init__(self):
            self.projects = ["general"]

        def update_current_space(self, value):
            self.current_space = value

        def update_current_project(self, value):
            self.current_project = value
            if value is not None and value not in self.projects:
                self.projects.append(value)

        def update_current_thread_id(self, value):
            self.current_thread_id = value

        def append_recent_threads(self, *_args):
            return None

        def projects_for(self, _space=None):
            return list(self.projects)

        def update_runtime_json(self):
            return None

    class FakeStore:
        def __init__(self):
            self.project = "general"
            self.title = "Original title"
            self.moved: list[tuple[str, str]] = []

        def list_sessions(self, *, project=None, **_kwargs):
            if project != self.project:
                return []
            return [
                {
                    "id": "local-current",
                    "title": self.title,
                    "status": "active",
                    "updated_at": "2026-07-23T10:00:00+00:00",
                }
            ]

        def rename_session(self, session_id, title):
            assert session_id == "local-current"
            self.title = title
            return {"title": title}

        def load_langchain_messages(self, session_id):
            assert session_id == "local-current"
            return [HumanMessage(content="Existing context")]

        def move_session(self, session_id, project):
            self.moved.append((session_id, project))
            self.project = project
            return {"id": session_id, "project": project}

    created_agents: list[tuple[str, str]] = []

    class FakeAgent:
        def __init__(self, *, project, space):
            created_agents.append((project, space))

    prompts = iter(
        [
            "/rename Research plan",
            "/project",
            "/project move research",
            "/project",
            "/quit",
        ]
    )
    synced: list[tuple[str, object, str]] = []
    rendered: list[tuple[str, list[dict], str]] = []

    async def fake_sync(_agent, _runtime, thread_id, fallback=None, *, status):
        synced.append((thread_id, fallback, status))

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    monkeypatch.setattr(chat_cli.cli, "prompt", lambda *_args, **_kwargs: next(prompts))
    monkeypatch.setattr(
        chat_cli.cli,
        "render_project_sessions",
        lambda project, rows, **kwargs: rendered.append(
            (project, rows, kwargs["current_thread_id"])
        ),
    )
    monkeypatch.setattr(chat_cli, "_sync_session_events", fake_sync)
    monkeypatch.setattr(
        chat_cli,
        "_run_dream_agent",
        lambda *_args, **_kwargs: asyncio.sleep(0),
    )
    monkeypatch.setattr(chat_cli, "clear_screen", lambda: None)

    runtime = FakeRuntime()
    store = FakeStore()
    asyncio.run(
        chat_cli._run_chat_loop(
            SimpleNamespace(),
            runtime,
            "local-current",
            store=store,
        )
    )

    assert store.title == "Research plan"
    assert store.moved == [("local-current", "research")]
    assert created_agents == [("research", "non_productivity")]
    assert [item[0] for item in rendered] == ["general", "research"]
    assert rendered[-1][1][0]["title"] == "Research plan"
    assert synced[-1][1][0].content == "Existing context"
    assert runtime.current_project is None


def test_productivity_loop_resumes_then_changes_cwd(tmp_path, monkeypatch) -> None:
    current = tmp_path / "current"
    target = current / "nested"
    target.mkdir(parents=True)
    initial = AgentSession(
        id="agent_initial",
        provider="codex",
        native_session_id="native-initial",
        project_path=str(current),
        project="cleo",
    )

    class FakeRuntime:
        def update_current_project(self, _value):
            return None

        def update_current_thread_id(self, _value):
            return None

        def append_recent_threads(self, *_args):
            return None

        def update_runtime_json(self):
            return None

    class FakeStore:
        def list_sessions(self, **_kwargs):
            return []

        def load_manifest(self, session_id):
            assert session_id == "agent_saved"
            return {
                "id": session_id,
                "space": "productivity",
                "project": "cleo",
                "provider": "claude",
                "native_session_id": "native-saved",
                "cwd": str(current),
            }

    class FakeAdapter:
        def __init__(self):
            self.closed: list[str] = []
            self.created_cwd: str | None = None
            self.models: list[tuple[str, str | None]] = []

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
                id="agent_saved",
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                project=project,
            )

        async def create_session(self, provider, project_path, model, project):
            self.created_cwd = project_path
            self.models.append((provider, model))
            return AgentSession(
                id="agent_cd",
                provider=provider,
                native_session_id="native-cd",
                project_path=project_path,
                project=project,
            )

        async def close(self, session_id):
            self.closed.append(session_id)

    prompts = iter(["/resume agent_saved", "/cd nested", "/quit"])

    async def fake_dream(*_args, **_kwargs):
        return None

    monkeypatch.setattr(productivity_cli.cli, "prompt", lambda *_args, **_kwargs: next(prompts))
    monkeypatch.setattr(productivity_cli, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(productivity_cli, "clear_screen", lambda: None)

    adapter = FakeAdapter()
    asyncio.run(
        productivity_cli._run_productivity_loop(
            adapter,
            initial,
            FakeRuntime(),
            FakeStore(),
            model=None,
            provider_models={"codex": "gpt-test", "claude": "claude-test"},
        )
    )

    assert Path(adapter.created_cwd or "") == target
    assert adapter.models == [
        ("claude", "claude-test"),
        ("claude", "claude-test"),
    ]
    assert adapter.closed == ["agent_initial", "agent_saved", "agent_cd"]
