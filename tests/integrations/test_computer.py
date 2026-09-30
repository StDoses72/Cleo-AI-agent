import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

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


@pytest.mark.parametrize("saved", [None, '{"runtime":"isolated","future":1}', '{"runtime":"host"}'])
def test_built_in_targets_use_the_desktop_broker_and_never_rewrite_settings(
    tmp_path, monkeypatch, saved,
):
    """Old runtime values never select Docker or grant local control; the broker decides."""
    path = tmp_path / "computer-use.json"
    if saved is not None:
        path.write_text(saved, encoding="utf-8")
    requests = []

    async def fake_request(payload, *, bridge=None, timeout=None):
        requests.append((payload, bridge))
        return [{"type": "text", "text": "broker"}]

    monkeypatch.setattr(computer.bridge, "request", fake_request)
    listed = asyncio.run(computer.invoke({"client_key": "k"}, path=path))
    assert listed == [{"type": "text", "text": "broker"}]
    asyncio.run(computer.invoke("thread-1", "browser_screenshot", {"tab_id": "t1"}, path,
                                bridge_file="d.json"))
    assert requests[0][0] == {"op": "tools", "identity": {"client_key": "k"}}
    assert requests[1] == ({"op": "call", "identity": {"thread_id": "thread-1"},
                            "name": "browser_screenshot", "arguments": {"tab_id": "t1"}}, "d.json")
    assert (path.read_text(encoding="utf-8") if path.exists() else None) == saved


def test_missing_desktop_app_is_reported_without_claiming_success(tmp_path, monkeypatch):
    monkeypatch.delenv(computer.bridge.ENVIRONMENT, raising=False)
    settings = tmp_path / "computer-use.json"
    result = asyncio.run(computer.invoke("task", "browser_click", {}, settings))
    assert result[0]["text"].startswith("电脑操作未完成") and "桌面应用" in result[0]["text"]
    broken = tmp_path / "bridge.json"
    broken.write_text('{"version": 9}')
    result = asyncio.run(computer.invoke("task", path=settings, bridge_file=broken))
    assert "桌面应用" in result[0]["text"]


def test_server_configuration_carries_the_session_key_and_descriptor_path(tmp_path, monkeypatch):
    path = tmp_path / "computer-use.json"
    monkeypatch.setenv(computer.bridge.ENVIRONMENT, str(tmp_path / "bridge.json"))
    args = computer.server_configuration(path, "ab" * 16)["cleo_computer"]["args"]
    assert args[args.index("--client-key") + 1] == "ab" * 16
    assert args[args.index("--bridge") + 1] == str(tmp_path / "bridge.json")
    monkeypatch.delenv(computer.bridge.ENVIRONMENT)
    plain = computer.server_configuration(path)["cleo_computer"]["args"]
    assert "--client-key" not in plain and "--bridge" not in plain
    memory = MemoryMcp(tmp_path / "memory", computer_config_path=path)
    overrides = memory.codex_config(computer_client="cd" * 16).config_overrides
    assert "mcp_servers.cleo_computer.tool_timeout_sec=660" in overrides
    prefix = "mcp_servers.cleo_computer.args="
    computer_args = [item for item in overrides if item.startswith(prefix)]
    assert any("cd" * 16 in item for item in computer_args)
    assert "cd" * 16 in memory.claude_servers("cd" * 16)["cleo_computer"]["args"]
    acp = next(item for item in memory.acp_servers("cd" * 16) if item.name == "cleo_computer")
    assert "cd" * 16 in acp.args
    # Reconnect comparisons use key-free configuration, so they stay stable.
    assert memory.codex_config().config_overrides == memory.codex_config().config_overrides


def test_bridge_client_round_trip_and_cancellation(tmp_path):
    from cleo.computer import bridge

    received = []
    closed = asyncio.Event()

    class Protocol(asyncio.Protocol):
        def connection_made(self, transport):
            self.transport, self.buffer = transport, b""

        def data_received(self, data):
            self.buffer += data
            if b"\n" not in self.buffer:
                return
            message = json.loads(self.buffer.split(b"\n", 1)[0])
            received.append(message)
            if message["name"] == "slow":
                return  # never answers; the client cancels
            reply = {"ok": message["token"] == "secret", "error": "bad token",
                     "content": [{"type": "text", "text": message["name"]}]}
            self.transport.write((json.dumps(reply) + "\n").encode())
            self.transport.close()

        def connection_lost(self, _exc):
            closed.set()

    async def scenario():
        loop = asyncio.get_running_loop()
        if sys.platform == "win32":
            address = r"\\.\pipe\cleo-test-" + os.urandom(6).hex()
            servers = await loop.start_serving_pipe(Protocol, address)
            descriptor = {"version": 1, "transport": "pipe", "address": address, "token": "secret"}
        else:
            address = str(tmp_path / "bridge.sock")
            servers = [await loop.create_unix_server(Protocol, address)]
            descriptor = {"version": 1, "transport": "unix", "address": address, "token": "secret"}
        path = tmp_path / "bridge.json"
        path.write_text(json.dumps(descriptor))
        try:
            content = await bridge.request(
                {"op": "call", "name": "browser_screenshot"}, bridge=path)
            assert content == [{"type": "text", "text": "browser_screenshot"}]
            assert received[0]["token"] == "secret" and received[0]["op"] == "call"
            closed.clear()
            task = asyncio.create_task(bridge.request({"op": "call", "name": "slow"}, bridge=path))
            await asyncio.sleep(0.3)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            # Closing the connection is how the broker learns the call was cancelled.
            await asyncio.wait_for(closed.wait(), 5)
            descriptor["token"] = "wrong"
            path.write_text(json.dumps(descriptor))
            with pytest.raises(bridge.BridgeError, match="bad token"):
                await bridge.request({"op": "call", "name": "x"}, bridge=path)
        finally:
            for server in servers:
                server.close()

    asyncio.run(scenario())


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


def test_each_harness_session_records_its_computer_client_key(tmp_path, monkeypatch):
    from cleo.integrations.harnesses.acp import AcpProvider
    from cleo.integrations.harnesses.claude import ClaudeProvider
    from cleo.integrations.harnesses.codex import CodexProvider
    from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker

    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path)
    memory = MemoryMcp(tmp_path / "memory", computer_config_path=tmp_path / "computer-use.json")
    provider = CodexProvider(None, memory_mcp=memory)
    client = provider._client_with_approvals(CodexApprovalBroker("codex"))
    key = client._cleo_computer_client
    assert len(key) == 32
    assert any(key in item for item in client._client._sync.config.config_overrides)
    provider._sessions["native"] = SimpleNamespace(client=client)
    assert provider.computer_session(key) == "native"
    assert provider.computer_session("0" * 32) is None
    for cls in (ClaudeProvider, AcpProvider):
        other = cls.__new__(cls)
        other._sessions = {"session": SimpleNamespace(computer_client="k" * 32)}
        assert other.computer_session("k" * 32) == "session"
        assert other.computer_session("x" * 32) is None
