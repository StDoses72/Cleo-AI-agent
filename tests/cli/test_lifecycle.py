from __future__ import annotations

import asyncio
import json
from contextlib import nullcontext
from types import SimpleNamespace

import cleo.agents as agents_module
import cleo.cli.lifecycle as lifecycle
import cleo.config.settings as settings_module
import cleo.integrations.background as background
from cleo.cli.dream_worker import _parse_jobs
from cleo.sessions.store import SessionStore


def _session_store(tmp_path) -> SessionStore:
    store = SessionStore(tmp_path / "memory", tmp_path / "memory" / "sessions.sqlite3")
    store.create_session(
        session_id="session-test",
        space="non_productivity",
        project="cleo",
        provider="cleo",
        owner_type="user",
    )
    return store


def _configure_lifecycle_store(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        settings_module,
        "settings",
        SimpleNamespace(
            MEMORY_DIR=tmp_path / "memory",
            SESSION_INDEX_PATH=tmp_path / "memory" / "sessions.sqlite3",
        ),
    )


def test_dream_agent_is_not_created_without_user_interaction(tmp_path, monkeypatch) -> None:
    store = _session_store(tmp_path)
    store.append_event(
        space="non_productivity",
        project="cleo",
        session_id="session-test",
        event_type="user_message",
        actor="user",
        content="  \n ",
    )
    _configure_lifecycle_store(tmp_path, monkeypatch)

    class UnexpectedDreamAgent:
        def __init__(self) -> None:
            raise AssertionError("DreamAgent must not be created for an empty session")

    monkeypatch.setattr(agents_module, "DreamAgent", UnexpectedDreamAgent)

    asyncio.run(
        lifecycle._run_dream_agent("session-test", "cleo", "non_productivity")
    )


def test_dream_agent_runs_after_meaningful_user_interaction(tmp_path, monkeypatch) -> None:
    store = _session_store(tmp_path)
    store.append_event(
        space="non_productivity",
        project="cleo",
        session_id="session-test",
        event_type="user_message",
        actor="user",
        content=[{"type": "text", "text": "Help me build a personal site"}],
    )
    _configure_lifecycle_store(tmp_path, monkeypatch)
    calls: list[tuple[str, str, str]] = []

    class FakeDreamAgent:
        async def invoke(self, *, session_id: str, project: str, space: str) -> None:
            calls.append((session_id, project, space))

    monkeypatch.setattr(agents_module, "DreamAgent", FakeDreamAgent)
    monkeypatch.setattr(lifecycle.cli, "status", lambda _message: nullcontext())
    monkeypatch.setattr(lifecycle.cli, "success", lambda _message: None)

    asyncio.run(
        lifecycle._run_dream_agent("session-test", "cleo", "non_productivity")
    )

    assert calls == [("session-test", "cleo", "non_productivity")]


def test_detached_dream_worker_deduplicates_and_serializes_jobs(monkeypatch) -> None:
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_popen(command, **kwargs):
        calls.append((command, kwargs))
        return object()

    monkeypatch.setattr(background.subprocess, "Popen", fake_popen)
    launched = lifecycle._launch_dream_agent_worker(
        [
            ("agent-one", "cleo", "productivity"),
            ("agent-one", "cleo", "productivity"),
            ("agent-two", "site", "productivity"),
        ]
    )

    assert launched is True
    assert len(calls) == 1
    command, kwargs = calls[0]
    assert command[1:3] == ["-m", "cleo.cli.dream_worker"]
    payload = json.loads(command[3])
    assert payload == [
        ["agent-one", "cleo", "productivity"],
        ["agent-two", "site", "productivity"],
    ]
    assert kwargs["stdin"] is background.subprocess.DEVNULL
    assert kwargs["stdout"] is background.subprocess.DEVNULL
    assert kwargs["stderr"] is background.subprocess.DEVNULL
    assert _parse_jobs(command[3]) == [
        ("agent-one", "cleo", "productivity"),
        ("agent-two", "site", "productivity"),
    ]


def test_detached_dream_worker_is_not_started_for_empty_session(
    tmp_path,
    monkeypatch,
) -> None:
    store = _session_store(tmp_path)

    def unexpected_popen(*_args, **_kwargs):
        raise AssertionError("an empty session must not start a worker process")

    monkeypatch.setattr(background.subprocess, "Popen", unexpected_popen)

    launched = lifecycle._launch_dream_agent_worker(
        [("session-test", "cleo", "non_productivity")],
        store=store,
    )

    assert launched is False
