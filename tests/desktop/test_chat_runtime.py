from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage

import cleo.config.settings as settings_module
from cleo.config.service import ConfigService
from cleo.desktop.agent_system import TurnInput
from cleo.desktop.chat_runtime import ChatRuntime
from cleo.desktop.service import DesktopService
from cleo.desktop.turn_hooks import TurnHook
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


def test_reload_during_turn_preparation_rebuilds_agent_on_the_next_turn(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_module, "_current_settings", None)
    config_path, harnesses_path = tmp_path / "cleo.json", tmp_path / "harnesses.json"
    payload = {
        "active_profiles": {"agent": "main"},
        "profiles": {
            "agents": {"main": {"provider": "openai", "model": "test", "api_key": "test"}},
            "directories": {"default": {"root_dir": str(tmp_path)}},
            "tools": {"default": {"browser": {"enabled": False}}},
        },
    }
    config_path.write_text(json.dumps(payload), encoding="utf-8")
    harnesses_path.write_text("{}", encoding="utf-8")
    config = ConfigService(config_path, harnesses_path,
                           initial=settings_module.load_settings(config_path, harnesses_path))
    built = []

    def new_agent(**kwargs):
        browser = settings_module.current_settings().active_tools_profile.browser.enabled
        built.append(browser)
        messages = []

        async def stream_text(prompt, thread_id, *, loaded_info, images, message_id):
            messages[:] = [*(loaded_info or []), HumanMessage(id=message_id, content=prompt),
                           AIMessage(content=f"browser={browser}")]
            yield f"browser={browser}"

        return SimpleNamespace(
            stream_text=stream_text,
            deepagent=SimpleNamespace(aget_state=AsyncMock(
                return_value=SimpleNamespace(values={"messages": messages}))),
            context_usage=SimpleNamespace(used_tokens=1, window_tokens=100,
                                          input_tokens=1, output_tokens=0),
        )

    async def scenario():
        service = DesktopService(config=config, agent_factory=new_agent)
        service.store.create_session(session_id="reload-chat", space="non_productivity",
                                     project="general", provider="cleo", owner_type="user")
        preparing, proceed = asyncio.Event(), asyncio.Event()

        class PausePreparation(TurnHook):
            async def prepare(self, request):
                preparing.set()
                await proceed.wait()
                return True

        monkeypatch.setattr(service, "_turn_hooks", lambda: [PausePreparation()])
        emit = AsyncMock()
        running = asyncio.create_task(service.stream_turn(
            thread_id="reload-chat", prompt="first", attachments=[], emit=emit,
        ))
        try:
            await asyncio.wait_for(preparing.wait(), 5)
            payload["profiles"]["tools"]["default"]["browser"]["enabled"] = True
            config_path.write_text(json.dumps(payload), encoding="utf-8")
            assert config.reload() is True
        finally:
            proceed.set()
            await asyncio.wait_for(running, 5)

        assert built == [False]  # The already-started turn keeps its original configuration.
        await service.stream_turn(thread_id="reload-chat", prompt="second", attachments=[],
                                  emit=emit)
        assert built == [False, True]
        assert service._chat.versions["reload-chat"] == config.snapshot.version
        assert [call.args[0]["summary"] for call in emit.await_args_list
                if call.args[0]["type"] == "done"] == ["browser=False", "browser=True"]

    asyncio.run(scenario())
