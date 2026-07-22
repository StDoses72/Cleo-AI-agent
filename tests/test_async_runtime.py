from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessageChunk

import main
from core.agent import Agent, DreamAgent
from core.integrations.agent_adapter import AgentResult, AgentSession
from core.integrations.codex import CodexAdapter, CodexResult


def test_primary_runtime_boundaries_are_async() -> None:
    assert inspect.iscoroutinefunction(main.amain)
    assert not inspect.iscoroutinefunction(main.main)
    assert inspect.isasyncgenfunction(Agent.stream_text)
    assert inspect.iscoroutinefunction(DreamAgent.invoke)
    assert inspect.iscoroutinefunction(CodexAdapter.start)
    assert inspect.iscoroutinefunction(CodexAdapter.reply)


def test_agent_stream_text_uses_async_graph_streaming() -> None:
    class FakeGraph:
        async def astream(self, payload, *, config, stream_mode):
            assert payload["messages"][-1]["content"] == "hello"
            assert config == {"configurable": {"thread_id": "thread-1"}}
            assert stream_mode == "messages"
            yield AIMessageChunk(content="hello"), {}
            yield AIMessageChunk(content=" world"), {}

    agent = Agent.__new__(Agent)
    agent.deepagent = FakeGraph()

    async def collect() -> list[str]:
        return [text async for text in agent.stream_text("hello", thread_id="thread-1")]

    assert asyncio.run(collect()) == ["hello", " world"]


def test_codex_facade_uses_async_unified_adapter(tmp_path, monkeypatch) -> None:
    adapter = CodexAdapter(default_model="test-model", project_root=tmp_path)

    async def fake_run(**kwargs) -> AgentResult:
        assert kwargs == {
            "provider": "codex",
            "prompt": "hello",
            "project_path": ".",
            "model": "test-model",
        }
        await asyncio.sleep(0.05)
        return AgentResult(
            session_id="agent-1",
            provider="codex",
            native_session_id="thread-1",
            turn_id="turn-1",
            status="completed",
            response="done",
        )

    monkeypatch.setattr(adapter._adapter, "run", fake_run)

    async def exercise() -> CodexResult:
        task = asyncio.create_task(adapter.start("hello", ".", "test-model"))
        await asyncio.sleep(0.01)
        assert not task.done()
        return await task

    result = asyncio.run(exercise())
    assert result.thread_id == "thread-1"
    assert result.status == "completed"


def test_main_routes_productivity_mode(tmp_path, monkeypatch) -> None:
    import config.settings as settings_module
    import core.memory.session_store as session_store_module
    import core.runtime.model as runtime_module

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
    monkeypatch.setattr(main, "_run_productivity_mode", fake_productivity)
    monkeypatch.setattr(
        sys,
        "argv",
        ["main.py", "--productivity", "--project", "cleo", "inspect this repo"],
    )

    asyncio.run(main.amain())

    assert received["runtime"] is fake_runtime
    assert received["store"] is fake_store
    assert received["settings"] is fake_settings
    assert received["args"].productivity is True
    assert received["args"].message == "inspect this repo"


def test_chat_productivity_command_restores_cleo_context(tmp_path, monkeypatch) -> None:
    import builtins

    import config.settings as settings_module
    import core.memory.session_store as session_store_module

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
    monkeypatch.setattr(main, "_run_productivity_mode", fake_productivity)
    monkeypatch.setattr(main, "_sync_session_events", fake_sync)
    monkeypatch.setattr(main, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(main, "clear_screen", lambda: None)
    monkeypatch.setattr(builtins, "input", fake_input)

    asyncio.run(
        main._run_chat_loop(
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

    resolved_target = main._resolve_productivity_cwd("nested", str(current))
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
        main._resume_productivity_session(
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
    import core.agent as agent_module

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
    monkeypatch.setattr(main.cli, "prompt", lambda *_args, **_kwargs: next(prompts))
    monkeypatch.setattr(main, "_sync_session_events", fake_sync)
    monkeypatch.setattr(main, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(main, "clear_screen", lambda: None)

    runtime = FakeRuntime()
    asyncio.run(
        main._run_chat_loop(
            SimpleNamespace(),
            runtime,
            "local-current",
            store=FakeStore(),
        )
    )

    assert created_agents == [("saved-project", "non_productivity")]
    assert synced_threads == ["local-current", "local-saved"]
    assert "local-saved" in runtime.thread_updates


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
                "provider": "codex",
                "native_session_id": "native-saved",
                "cwd": str(current),
            }

    class FakeAdapter:
        def __init__(self):
            self.closed: list[str] = []
            self.created_cwd: str | None = None

        async def resume_session(
            self,
            provider,
            native_session_id,
            project_path,
            model,
            project,
        ):
            return AgentSession(
                id="agent_saved",
                provider=provider,
                native_session_id=native_session_id,
                project_path=project_path,
                project=project,
            )

        async def create_session(self, provider, project_path, model, project):
            self.created_cwd = project_path
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

    monkeypatch.setattr(main.cli, "prompt", lambda *_args, **_kwargs: next(prompts))
    monkeypatch.setattr(main, "_run_dream_agent", fake_dream)
    monkeypatch.setattr(main, "clear_screen", lambda: None)

    adapter = FakeAdapter()
    asyncio.run(
        main._run_productivity_loop(
            adapter,
            initial,
            FakeRuntime(),
            FakeStore(),
            model="test-model",
        )
    )

    assert Path(adapter.created_cwd or "") == target
    assert adapter.closed == ["agent_initial", "agent_saved", "agent_cd"]
