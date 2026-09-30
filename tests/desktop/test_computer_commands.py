import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.desktop.service import CHAT_COMMANDS, PRODUCTIVITY_COMMANDS, DesktopService


def test_legacy_computer_messages_are_concise_without_changing_saved_content():
    from cleo.desktop.projection import timeline_from_events

    prompt = ("使用 computer_tools 和 computer_call 完成下面的电脑操作任务。内部说明。"
              "\n用户任务：打开浏览器\n用户任务：保留用户自己的文字")
    event = {"id": "legacy", "type": "user_message", "content": prompt}
    assert timeline_from_events([event])[0]["content"] == (
        "Computer use：打开浏览器\n用户任务：保留用户自己的文字"
    )
    assert event["content"] == prompt


def test_computeruse_dispatches_without_switch_or_configuration_write(tmp_path, monkeypatch):
    service = DesktopService.__new__(DesktopService)
    service.settings = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json")
    service.settings.PROFILE_DIR.write_text('{"model":"original"}')
    config = tmp_path / "computer-use.json"
    config.write_text('{"enabled":false,"future":9}')
    service._notice = AsyncMock()
    monkeypatch.setattr("cleo.desktop.service.sys", SimpleNamespace(platform="win32"))
    manifest = {"id": "chat", "runtime_options": {"model": "original"}}

    async def run():
        for commands in (CHAT_COMMANDS, PRODUCTIVITY_COMMANDS):
            assert "/computeruse" in commands
            assert not {"/computer", "/computer on", "/computer off"} & set(commands)
        prompt = await service._computer_command(manifest, "/computeruse 打开记事本", AsyncMock())
        assert prompt.endswith("用户任务：打开记事本") and "computer_call" in prompt
        assert await service._computer_command(manifest, "/computeruse", AsyncMock()) is None
        assert "on" not in service._notice.call_args.args[2]

    asyncio.run(run())
    assert manifest["runtime_options"]["model"] == "original"
    assert config.read_text() == '{"enabled":false,"future":9}'
    assert service.settings.PROFILE_DIR.read_text() == '{"model":"original"}'


def test_computeruse_prompt_targets_the_built_in_browser_by_default(tmp_path):
    service = DesktopService.__new__(DesktopService)
    service.settings = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json")
    manifest = {"id": "task"}
    prompt = asyncio.run(service._computer_command(manifest, "/computeruse 查询天气", AsyncMock()))
    assert "内置浏览器" in prompt and "授权" in prompt and prompt.endswith("用户任务：查询天气")
    assert "Docker" not in prompt and "Snapshot" not in prompt
    (tmp_path / "computer-use.json").write_text('{"command":"custom-mcp"}')
    custom = asyncio.run(service._computer_command(manifest, "/computeruse 查询天气", AsyncMock()))
    assert "自定义" in custom
    assert not hasattr(service, "computer_desktop")


def test_computer_owner_maps_harness_keys_to_threads_and_scope_reads_cwd(tmp_path):
    service = DesktopService.__new__(DesktopService)
    owners = {"k1": "agent_1", "k2": "thread-2"}
    service._adapter_instance = SimpleNamespace(computer_owner=owners.get)
    service._productivity_sessions = {"thread-1": SimpleNamespace(id="agent_1")}
    manifest = {"cwd": str(tmp_path), "title": "任务"}
    service.store = SimpleNamespace(load_manifest=lambda _thread: manifest)
    assert asyncio.run(service.computer_owner("k1")) == "thread-1"
    assert asyncio.run(service.computer_owner("k2")) == "thread-2"
    assert asyncio.run(service.computer_owner("missing")) is None
    service._adapter_instance = None
    assert asyncio.run(service.computer_owner("k1")) is None
    assert asyncio.run(service.computer_scope("thread-1")) == manifest


def test_computer_host_reports_refusals_and_stop_releases(monkeypatch):
    from cleo.computer import host
    from cleo.computer.host import HostError

    class Fake:
        async def run(self, op, arguments):
            if op == "type":
                raise HostError("当前前台窗口是 Cleo")
            return {"op": op, "arguments": arguments}

        async def stop(self, reason):
            return {"stopped": True, "reason": reason}

    monkeypatch.setattr(host, "_controller", Fake())
    service = DesktopService.__new__(DesktopService)
    clicked = asyncio.run(service.computer_host("click", {"x": 1}))
    assert clicked == {"op": "click", "arguments": {"x": 1}}
    with pytest.raises(ValueError, match="前台窗口是 Cleo"):
        asyncio.run(service.computer_host("type", {"text": "x"}))
    stopped = asyncio.run(service.computer_host_stop("cancel"))
    assert stopped == {"stopped": True, "reason": "cancel"}


def test_agent_service_maps_provider_keys_to_session_handles():
    from cleo.harnesses.service import AgentService

    service = AgentService.__new__(AgentService)
    provider = SimpleNamespace(computer_session=lambda key: "native-1" if key == "k" else None)
    service._sessions = {
        "agent_1": SimpleNamespace(provider=provider, provider_session_id="native-1"),
        "agent_2": SimpleNamespace(provider=SimpleNamespace(), provider_session_id="native-2"),
    }
    assert service.computer_owner("k") == "agent_1"
    assert service.computer_owner("other") is None
