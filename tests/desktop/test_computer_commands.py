import asyncio
import json
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


def test_setup_can_prepare_guest_while_host_remains_selected(tmp_path, monkeypatch):
    service = DesktopService.__new__(DesktopService)
    service.settings = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json")
    config = tmp_path / "computer-use.json"
    config.write_text('{"runtime":"host","future":8}')
    guest = AsyncMock(return_value={"phase": "ready"})
    monkeypatch.setattr("cleo.computer_desktop.runtime.desktop_action", guest)

    async def run():
        assert await service.computer_desktop(action="start", target="isolated") == {
            "phase": "ready",
        }
        guest.assert_awaited_once_with(config, "start", "")
        with pytest.raises(ValueError, match="依赖准备"):
            await service.computer_desktop(action="select", target="isolated", text="host")

    asyncio.run(run())
    assert config.read_text() == '{"runtime":"host","future":8}'


def test_choose_host_persists_and_changes_prompt_without_contacting_docker(tmp_path, monkeypatch):
    service = DesktopService.__new__(DesktopService)
    service.settings = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json")
    service._run_tasks = {}
    monkeypatch.setattr("cleo.integrations.computer.sys", SimpleNamespace(platform="win32"))
    guest = AsyncMock(side_effect=AssertionError("Host selection must not contact Docker"))
    monkeypatch.setattr("cleo.computer_desktop.runtime.desktop_action", guest)

    async def run():
        initial = await service.computer_desktop()
        assert initial["runtime"] == "isolated" and initial["canSwitch"]
        assert "Host selection" in initial["detail"]
        guest.reset_mock()
        state = await service.computer_desktop(action="select", text="host")
        assert state["runtime"] == "host" and state["phase"] == "external"
        assert "viewerUrl" not in state
        assert (await service.computer_desktop())["runtime"] == "host"
        prompt = await service._computer_command({}, "/computeruse 打开浏览器", AsyncMock())
        assert "真实 Windows" in prompt and "独立 Linux" not in prompt
        with pytest.raises(ValueError, match="仅适用于独立桌面"):
            await service.computer_desktop(action="text", text="private login")
        service._run_tasks["other-session"] = object()
        assert not (await service.computer_desktop())["canSwitch"]
        with pytest.raises(ValueError, match="任务结束"):
            await service.computer_desktop(action="select", text="isolated")
        assert json.loads((tmp_path / "computer-use.json").read_text())["runtime"] == "host"
        service._run_tasks.clear()
        guest.side_effect = None
        guest.return_value = {"phase": "stopped"}
        state = await service.computer_desktop(action="select", text="isolated")
        assert state["runtime"] == "isolated"
        guest.assert_awaited_once_with(tmp_path / "computer-use.json", "status", "isolated")
        prompt = await service._computer_command({}, "/computeruse 搜索", AsyncMock())
        assert "独立 Linux" in prompt and "真实 Windows" not in prompt

    asyncio.run(run())
