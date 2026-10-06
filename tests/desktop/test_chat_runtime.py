from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from cleo.desktop.agent_system import TurnInput
from cleo.desktop.chat_runtime import ChatRuntime
from cleo.sessions.store import SessionStore


def _runtime(tmp_path, version):
    store = SessionStore(tmp_path / "memory")
    store.create_session(session_id="c", space="non_productivity", project="general",
                         provider="cleo", owner_type="user")
    built, synced, loaded = [], [], []

    def new_agent(manifest):
        async def stream_text(prompt, thread_id, *, loaded_info, images, message_id):
            loaded.append(loaded_info)
            yield "hello "
            yield "there"

        agent = SimpleNamespace(stream_text=stream_text, context_usage=SimpleNamespace(
            used_tokens=5, window_tokens=100, input_tokens=3, output_tokens=2))
        built.append(manifest["id"])
        return agent

    async def sync(agent, manifest, status):
        synced.append(status)

    runtime = ChatRuntime(
        store=store, new_agent=new_agent, attachment=None, sync=sync,
        usage=lambda usage: {"used": usage.used_tokens}, config_version=lambda: version[0],
        max_attachments=1,
    )
    return store, runtime, built, synced, loaded


def test_agents_are_cached_per_thread_and_rebuilt_after_a_reload(tmp_path) -> None:
    version = [1]
    store, runtime, built, synced, loaded = _runtime(tmp_path, version)
    events = []

    async def emit(event):
        events.append(event)

    manifest = store.load_manifest("c")
    asyncio.run(runtime.stream(TurnInput(manifest, "hi"), emit))
    asyncio.run(runtime.stream(TurnInput(manifest, "again"), emit))
    assert built == ["c"] and loaded == [None, None] and synced == ["completed"] * 2
    assert [event["type"] for event in events[:4]] == [
        "turn-started", "upsert-item", "upsert-item", "usage"]
    assert events[2]["item"]["content"] == "hello there"
    assert events[4] == {"type": "done", "summary": "hello there"}

    version[0] = 2
    asyncio.run(runtime.stream(TurnInput(manifest, "after reload"), emit))
    assert built == ["c", "c"]
    # The rebuilt agent restores the history from the log (the two user messages).
    assert loaded[-1] is not None and len(loaded[-1]) == 2

    runtime.forget("c")
    assert "c" not in runtime.agents and "c" not in runtime.restored
    with pytest.raises(ValueError, match="at most 1 files"):
        asyncio.run(runtime.stream(TurnInput(manifest, "x", [{}, {}]), emit))
