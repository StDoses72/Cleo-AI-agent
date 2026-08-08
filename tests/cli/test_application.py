from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import cleo.cli.application as application
import cleo.cli.productivity as productivity_cli
from cleo.harnesses import AgentSession


def _fake_chat_agent() -> SimpleNamespace:
    """Provide the minimal Agent surface used by the chat loop rendering."""
    return SimpleNamespace(model_name="fake-model", context_usage=None)


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


def test_main_reports_productivity_startup_error_as_cli_exit(tmp_path, monkeypatch) -> None:
    import cleo.config.settings as settings_module
    import cleo.runtime.state as runtime_module
    import cleo.sessions.store as session_store_module

    fake_settings = SimpleNamespace(
        MEMORY_DIR=tmp_path / "memory",
        SESSION_INDEX_PATH=tmp_path / "memory" / "sessions.sqlite3",
    )

    class FakeRuntime:
        pass

    class FakeSessionStore:
        def __init__(self, *_args):
            pass

    async def fake_productivity(*_args, **_kwargs):
        raise productivity_cli.ProductivityStartupError("provider is unavailable")

    monkeypatch.setattr(settings_module, "settings", fake_settings)
    monkeypatch.setattr(runtime_module, "Runtime", FakeRuntime)
    monkeypatch.setattr(session_store_module, "SessionStore", FakeSessionStore)
    monkeypatch.setattr(application, "_run_productivity_mode", fake_productivity)
    monkeypatch.setattr(sys, "argv", ["main.py", "--productivity"])

    with pytest.raises(SystemExit, match="provider is unavailable"):
        asyncio.run(application.amain())


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


def test_productivity_loop_delegates_to_textual_ui(monkeypatch) -> None:
    import cleo.cli.productivity_tui as productivity_tui

    received: dict[str, object] = {}

    async def fake_tui(adapter, session, runtime, store, **kwargs):
        received.update(
            adapter=adapter,
            session=session,
            runtime=runtime,
            store=store,
            kwargs=kwargs,
        )

    monkeypatch.setattr(productivity_tui, "run_productivity_tui", fake_tui)
    adapter = object()
    session = AgentSession(
        id="agent-current",
        provider="codex",
        project_path=".",
        project="cleo",
    )
    runtime = object()
    store = object()

    asyncio.run(
        productivity_cli._run_productivity_loop(
            adapter,
            session,
            runtime,
            store,
            model="gpt-test",
            provider_models={"codex": "gpt-configured"},
            return_to_chat=True,
        )
    )

    assert received == {
        "adapter": adapter,
        "session": session,
        "runtime": runtime,
        "store": store,
        "kwargs": {
            "model": "gpt-test",
            "provider_models": {"codex": "gpt-configured"},
            "return_to_chat": True,
            "restore_initial_history": False,
        },
    }
