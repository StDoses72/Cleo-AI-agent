import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastmcp import Client
from fastmcp.client.transports import StdioTransport

from cleo.integrations import computer
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.mcp.computer_server import create_server


def configure(tmp_path, monkeypatch):
    """Purpose: Run real stdio against a fake desktop. Input: test root. Output: settings path."""
    path = tmp_path / "computer-use.json"
    path.write_text(
        json.dumps(
            {
                "enabled": False,
                "command": sys.executable,
                "args": [str(Path(__file__).parents[1] / "fixtures/computer_mcp.py")],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        computer, "sys", SimpleNamespace(platform="win32", executable=sys.executable)
    )
    return path


def test_lazy_config_preserves_legacy_switch_and_unknown_fields_without_writes(tmp_path):
    path = tmp_path / "computer-use.json"
    old = tmp_path / "cleo.json"
    old.write_text('{"old":true}', encoding="utf-8")
    assert computer.read_settings(path).command == ""
    assert not path.exists()
    path.write_text('{"enabled":false,"future":{"key":9}}', encoding="utf-8")
    assert computer.read_settings(path).model_extra == {"enabled": False, "future": {"key": 9}}
    assert "cleo_computer" in computer.server_configuration(path)
    assert json.loads(path.read_text())["future"] == {"key": 9}
    assert old.read_text() == '{"old":true}'
    path.write_text('{"schema_version":2,"enabled":true}', encoding="utf-8")
    with pytest.raises(ValueError, match="保留"):
        computer.read_settings(path)
    assert json.loads(path.read_text())["schema_version"] == 2


def test_runtime_selection_preserves_fields_and_rejects_bad_config(tmp_path, monkeypatch):
    path = tmp_path / "computer-use.json"
    monkeypatch.setattr(computer, "sys", SimpleNamespace(platform="win32"))
    path.write_text('{"future":{"nested":7},"enabled":false,"timeout_seconds":240}')
    computer.select_runtime("host", path)
    saved = path.read_text()
    assert computer.read_settings(path).runtime == "host"
    assert json.loads(saved)["future"] == {"nested": 7}
    assert json.loads(saved)["timeout_seconds"] == 240
    with pytest.raises(ValueError):
        computer.select_runtime("invalid", path)
    assert path.read_text() == saved
    monkeypatch.setattr(computer, "sys", SimpleNamespace(platform="darwin"))
    with pytest.raises(ValueError, match="仅支持 Windows"):
        computer.select_runtime("host", path)
    assert path.read_text() == saved
    path.write_text('{"command":"custom-server","args":["private"]}')
    with pytest.raises(ValueError, match="自定义"):
        computer.select_runtime("isolated", path)
    assert json.loads(path.read_text())["args"] == ["private"]
    path.write_text("broken")
    with pytest.raises(ValueError, match="保留原文件"):
        computer.select_runtime("isolated", path)
    assert path.read_text() == "broken"
    assert not list(tmp_path.glob("*.tmp"))


def test_host_routing_does_not_fall_back_to_guest_on_failure(tmp_path, monkeypatch):
    path = tmp_path / "computer-use.json"
    path.write_text('{"runtime":"host"}')
    guest = AsyncMock(side_effect=AssertionError("Docker must not be used"))
    monkeypatch.setattr("cleo.computer_desktop.runtime.invoke", guest)
    client = SimpleNamespace(invoke=AsyncMock(return_value=[
        SimpleNamespace(name="Snapshot", description="Inspect host", input_schema={}),
    ]))
    host = AsyncMock(return_value=client)
    monkeypatch.setattr(computer, "connection", host)
    result = asyncio.run(computer.invoke("task", path=path))
    assert json.loads(result[0]["text"])[0]["name"] == "Snapshot"
    assert "真实 Windows" in result[1]["text"]
    host.assert_awaited_once_with("task", path)
    host.side_effect = ValueError("Host unavailable")
    result = asyncio.run(computer.invoke("task", "Click", {}, path))
    assert "Host unavailable" in result[0]["text"] and "未完成" in result[0]["text"]
    guest.assert_not_called()


def test_bridge_retains_snapshot_state_and_native_images(tmp_path, monkeypatch):
    path = configure(tmp_path, monkeypatch)

    async def run():
        async with Client(create_server(path)) as client:
            discovery = await client.call_tool("computer_tools", {})
            assert "Snapshot" in discovery.content[0].text
            snapshot = await client.call_tool(
                "computer_call", {"name": "Snapshot", "arguments": {}}
            )
            assert snapshot.content[1].type == "image"
            assert snapshot.content[1].data == "aW1hZ2U="
            click = await client.call_tool(
                "computer_call", {"name": "Click", "arguments": {"label": 7}}
            )
            assert click.content[0].text == "clicked label 7"
        assert not computer._connections.get(asyncio.get_running_loop())

    asyncio.run(run())


def test_failed_tool_and_missing_server_do_not_claim_success(tmp_path, monkeypatch):
    path = configure(tmp_path, monkeypatch)

    async def run():
        try:
            result = await computer.invoke("task", "Click", {"label": 7}, path)
            assert "操作失败" in result[0]["text"]
            path.write_text(json.dumps({"enabled": True, "command": "missing-cleo-mcp-123.exe"}))
            result = await computer.invoke("task", path=path)
            assert "未完成" in result[0]["text"]
        finally:
            await computer.close_connections()

    asyncio.run(run())


def test_each_task_has_its_own_snapshot(tmp_path, monkeypatch):
    path = configure(tmp_path, monkeypatch)

    async def run():
        try:
            await computer.invoke("first", "Snapshot", {}, path)
            result = await computer.invoke("second", "Click", {"label": 7}, path)
            assert "操作失败" in result[0]["text"]
        finally:
            await computer.close_connections()

    asyncio.run(run())


def test_all_harness_configs_include_lazy_bridge_without_configuration_or_losing_memory(tmp_path):
    path = tmp_path / "computer-use.json"
    memory = MemoryMcp(tmp_path / "memory", computer_config_path=path)
    assert set(memory.claude_servers()) == {"cleo_memory", "cleo_computer"}
    assert {item.name for item in memory.acp_servers()} == {"cleo_memory", "cleo_computer"}
    overrides = memory.codex_config().config_overrides
    assert any("cleo_computer.command=" in item for item in overrides)
    assert any("cleo_memory.command=" in item for item in overrides)
    assert not path.exists()


def test_unsupported_platform_explains_limitation(tmp_path, monkeypatch):
    path = configure(tmp_path, monkeypatch)
    monkeypatch.setattr(computer, "sys", SimpleNamespace(platform="darwin"))
    result = asyncio.run(computer.invoke("task", path=path))
    assert "仅支持 Windows" in result[0]["text"]


def test_bad_optional_configuration_does_not_block_ordinary_chat(tmp_path, monkeypatch):
    from cleo.agents.tools.computer_tools import get_computer_tools
    path = tmp_path / "computer-use.json"
    path.write_text("broken json")
    monkeypatch.setattr(computer, "config_path", lambda: path)
    assert get_computer_tools() == []
    assert computer.server_configuration(path) == {}
    assert path.read_text() == "broken json"


def test_api_tool_node_keeps_image_blocks_and_current_task_context(tmp_path, monkeypatch):
    from langchain_core.messages import AIMessage
    from langgraph.graph import END, START, MessagesState, StateGraph
    from langgraph.prebuilt import ToolNode

    from cleo.agents.tools.computer_tools import get_computer_tools

    path = configure(tmp_path, monkeypatch)
    monkeypatch.setattr(computer, "config_path", lambda: path)
    tools = get_computer_tools()
    assert "runtime" not in tools[1].tool_call_schema.model_json_schema()["properties"]
    builder = StateGraph(MessagesState)
    builder.add_node("tools", ToolNode(tools))
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    graph = builder.compile()

    async def run():
        try:
            result = await graph.ainvoke({"messages": [AIMessage(content="", tool_calls=[
                {"name": "computer_call", "args": {"name": "Snapshot", "arguments": {}},
                 "id": "snapshot", "type": "tool_call"}])]},
                config={"configurable": {"thread_id": "chosen-task"}})
            message = result["messages"][-1]
            assert message.status == "success"
            assert message.content[1]["type"] == "image"
            assert message.content[1]["base64"] == "aW1hZ2U="
            assert (str(path.resolve()), "chosen-task") in computer._connections[
                asyncio.get_running_loop()]
        finally:
            await computer.close_connections()

    asyncio.run(run())


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop integration")
def test_harness_launches_bridge_from_an_unrelated_directory(tmp_path, monkeypatch):
    path = configure(tmp_path, monkeypatch)
    config = computer.server_configuration(path)["cleo_computer"]
    transport = StdioTransport(**config, cwd=str(tmp_path), keep_alive=False)

    async def run():
        async with Client(transport) as client:
            tools = await client.list_tools()
            assert {item.name for item in tools} == {"computer_tools", "computer_call"}
            result = await client.call_tool("computer_call", {"name": "Snapshot", "arguments": {}})
            assert any(block.type == "image" for block in result.content)
        assert transport._connect_task is None

    asyncio.run(run())
