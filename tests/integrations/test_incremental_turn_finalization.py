"""Normal turn completion persists first; only an actual handoff prepares full context."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from cleo.desktop.service import DesktopService
from cleo.harnesses.context import ContextReader
from cleo.harnesses.models import AgentEvent
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.harnesses.service import AgentService
from cleo.sessions.store import SessionStore


class Provider:
    provider_type = "codex_sdk"

    def __init__(self, name):
        self.name = name
        self.calls = []
        self.closed = []

    async def create_session(self, project_path, model=None):
        return ProviderSession(f"{self.name}-session", f"{self.name}-native")

    async def resume_session(self, native_session_id, project_path, model=None):
        return ProviderSession(native_session_id, native_session_id)

    async def prompt(self, session_id, prompt, on_event=None):
        self.calls.append(prompt)
        answer = f"Answer: {prompt}"
        event = AgentEvent(provider=self.name, type="agent_message", text=answer)
        if on_event is not None:
            await on_event(event)
        return ProviderTurn(f"{self.name}-native", f"turn-{len(self.calls)}", "completed",
                            response=answer, events=(event,))

    async def close(self, session_id):
        self.closed.append(session_id)


def harness(tmp_path):
    store = SessionStore(tmp_path / "memory")
    service = AgentService(tmp_path, session_store=store)
    first, second = Provider("first"), Provider("second")
    service.register(first)
    service.register(second)
    return service, store, first, second


def test_normal_turn_does_not_prepare_full_context_snapshot(tmp_path, monkeypatch):
    async def scenario():
        service, store, _, _ = harness(tmp_path)
        session = await service.create_session("first", str(tmp_path))
        prepare = Mock(side_effect=AssertionError("normal completion prepared full context"))
        monkeypatch.setattr(service._context, "prepare", prepare)
        for prompt in ("Initial request", "Later correction"):
            result = await service.prompt(session.id, prompt)
            assert result.status == "completed"
        prepare.assert_not_called()
        assert not list(store.memory_root.glob("**/context-v1/*.json"))
        manifest = store.load_manifest(session.id)
        assert manifest["last_compacted_seq"] == manifest["last_event_seq"]
        assert [event["content"] for event in store.read_events(session.id)
                if event["type"] == "user_message"] == ["Initial request", "Later correction"]
    asyncio.run(scenario())


def test_actual_switch_prepares_latest_history_and_preserves_bound_snapshot(tmp_path, monkeypatch):
    async def scenario():
        service, store, _, second = harness(tmp_path)
        session = await service.create_session("first", str(tmp_path))
        prepare = Mock(wraps=service._context.prepare)
        monkeypatch.setattr(service._context, "prepare", prepare)
        await service.prompt(session.id, "Keep the existing files")
        await service.prompt(session.id, "New constraint: review before publishing")
        latest = store.read_events(session.id)
        prepare.assert_not_called()

        await service.switch_session(session.id, "second")
        prepare.assert_called_once_with(session.id, latest)
        route = service._sessions[session.id]
        binding = route.context_binding
        reader = ContextReader(store, binding)
        snapshot = service._context.load(binding)
        assert snapshot["source_seq"] == latest[-1]["seq"]
        assert reader.search_context("review before publishing")["results"]
        assert second.calls == []

        await service.prompt(session.id, "Continue with these constraints")
        assert "Keep the existing files" in second.calls[-1]
        assert "review before publishing" in second.calls[-1]
        assert "Continue with these constraints" in second.calls[-1]
        assert prepare.call_count == 1
        assert not reader.search_context("Continue with these constraints")["results"]
    asyncio.run(scenario())


@pytest.mark.parametrize("cancel_stage", ["none", "final_publish"])
def test_desktop_done_waits_for_incremental_compact_publication(
    tmp_path, monkeypatch, cancel_stage,
):
    async def scenario():
        adapter, store, _, _ = harness(tmp_path)
        session = await adapter.create_session("first", str(tmp_path))
        desktop = DesktopService(
            settings_model=SimpleNamespace(MEMORY_DIR=store.memory_root),
            store=store, runtime=SimpleNamespace(), adapter=adapter,
        )
        desktop._activate = lambda _manifest: None
        desktop._turn_hooks = lambda: []
        desktop._workspace_root = lambda _manifest: str(tmp_path)
        desktop._steer_mode = lambda _manifest: "boundary"
        desktop._ensure_productivity_session = AsyncMock()
        desktop._is_evolution = lambda _manifest: False
        desktop._evolution_prompt = lambda _manifest, prompt: prompt
        desktop._runtime_profile = lambda _manifest: {"contextWindow": 64000}
        desktop._session_provider_type = lambda _manifest: "codex_sdk"
        desktop._debug = lambda *_args: None
        monkeypatch.setattr("cleo.desktop.service.create_git_checkpoint", Mock(
            side_effect=ValueError("synthetic non-Git workspace"),
        ))
        monkeypatch.setattr("cleo.desktop.service.read_git_diff", lambda *_args: "")
        monkeypatch.setattr(adapter._context, "prepare", Mock(
            side_effect=AssertionError("normal completion prepared full context"),
        ))
        started, release, published = threading.Event(), threading.Event(), threading.Event()
        event_loop_thread = threading.get_ident()
        refresh = store.refresh_compact
        publish_calls = []
        blocked_call = 2 if cancel_stage == "final_publish" else 1

        def publish(session_id, *, materialize=True):
            assert session_id == session.id and materialize is False
            assert threading.get_ident() != event_loop_thread
            publish_calls.append(session_id)
            blocked = len(publish_calls) == blocked_call
            if blocked:
                started.set()
                assert release.wait(10), "test did not release compact publication"
            result = refresh(session_id, materialize=materialize)
            if blocked:
                published.set()
            return result

        monkeypatch.setattr(store, "refresh_compact", publish)
        shown = []

        async def emit(event):
            if event["type"] == "done":
                assert published.is_set()
            shown.append(event)

        task = asyncio.create_task(desktop.stream_turn(
            thread_id=session.id, prompt="Save this answer", attachments=[], emit=emit,
        ))
        try:
            writing = await asyncio.to_thread(started.wait, 5)
            if task.done():
                task.result()
            assert writing
            assert not task.done()
            assert any(event["type"] == "upsert-item" for event in shown)
            assert not any(event["type"] == "done" for event in shown)
            assert any(event["type"] == "session_completed"
                       for event in store.read_events(session.id))
            if cancel_stage == "final_publish":
                assert len(publish_calls) == 2
                for _ in range(2):
                    task.cancel()
                    await asyncio.sleep(0)
                    assert not task.done(), "final publication must survive repeated cancellation"
                    assert not published.is_set()
                    assert not any(event["type"] in {"done", "error"} for event in shown)
            release.set()
            await asyncio.wait_for(task, 5)
            assert published.is_set()
            assert len(publish_calls) == 2
            assert [event["type"] for event in shown].count("done") == 1
            assert store.load_manifest(session.id)["status"] == "completed"
            assert not any(event["type"] == "session_cancelled"
                           for event in store.read_events(session.id))
        finally:
            release.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())
