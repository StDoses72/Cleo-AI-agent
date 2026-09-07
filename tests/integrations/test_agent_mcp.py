import asyncio
import json
import os
import sys

import pytest
from fastmcp import Client
from fastmcp.client.transports import StdioTransport
from langchain.tools import ToolRuntime, tool
from mcp.types import CallToolRequest, CallToolRequestParams, ListToolsRequest

from cleo.config.settings import AgentProfile
from cleo.integrations.subscriptions import AgentMcp, runtime_environment
from cleo.mcp import agent_server


def test_runtime_argument_is_hidden_and_injected(monkeypatch):
    @tool
    def probe(runtime: ToolRuntime) -> str:
        """Return the caller's thread for the transport test."""
        return runtime.config["configurable"]["thread_id"]

    monkeypatch.setattr(agent_server, "agent_tools", lambda *_: [probe])
    server = agent_server.create_server("chat", ".", {"session_id": "thread-42"})

    async def exercise():
        listed = await server.request_handlers[ListToolsRequest](
            ListToolsRequest(method="tools/list")
        )
        assert "runtime" not in listed.root.tools[0].inputSchema["properties"]
        result = await server.request_handlers[CallToolRequest](
            CallToolRequest(
                method="tools/call",
                params=CallToolRequestParams(name="probe", arguments={}),
            )
        )
        assert result.root.isError is False
        assert result.root.content[0].text == "thread-42"

    asyncio.run(exercise())


def test_dream_server_rejects_cross_source_tool_arguments(monkeypatch):
    @tool
    def remember(space: str, project: str, session_id: str) -> str:
        """Test a scoped memory write."""
        return "accepted"

    monkeypatch.setattr(agent_server, "agent_tools", lambda *_: [remember])
    scope = {"space": "non_productivity", "project": "alpha", "session_id": "source"}
    server = agent_server.create_server("dream", ".", scope)

    async def exercise():
        for key in scope:
            result = await server.request_handlers[CallToolRequest](
                CallToolRequest(
                    method="tools/call",
                    params=CallToolRequestParams(
                        name="remember",
                        arguments={**scope, key: "elsewhere"},
                    ),
                )
            )
            assert result.root.isError is True
            assert "cannot change" in result.root.content[0].text

    asyncio.run(exercise())


def test_stdio_chat_tools_work_from_unrelated_directory(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "brief.txt").write_text("local brief", encoding="utf-8")
    config = tmp_path / "cleo.json"
    config.write_text(
        json.dumps(
            {
                "active_profiles": {"agent": "subscription"},
                "profiles": {
                    "agents": {
                        "subscription": {
                            "backend": "codex",
                            "provider": "codex",
                            "model": "default",
                        }
                    },
                    "directories": {"default": {"root_dir": str(tmp_path)}},
                },
            }
        ),
        encoding="utf-8",
    )
    mcp = AgentMcp(
        AgentProfile(backend="codex", provider="codex", model="default"),
        project,
        "",
        scope={"session_id": "chat"},
    )
    transport = StdioTransport(
        command=sys.executable,
        args=mcp.args,
        cwd=str(project),
        keep_alive=False,
        env={
            **os.environ,
            "CLEO_CONFIG_PATH": str(config),
            "CLEO_HARNESSES_CONFIG_PATH": str(tmp_path / "harnesses.json"),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )

    async def exercise():
        async with Client(transport) as client:
            tools = await client.list_tools()
            assert "read_file" in {tool.name for tool in tools}
            assert "remember_durable_knowledge" not in {tool.name for tool in tools}
            result = await client.call_tool("read_file", {"path": "/brief.txt"})
            assert result.content[0].text == "local brief"
            with pytest.raises(Exception, match="outside"):
                await client.call_tool("read_file", {"path": "../cleo.json"})

    asyncio.run(exercise())
    assert not (project / ".mcp.json").exists()


def test_runtime_environment_does_not_mutate_parent_or_inherit_api_billing(monkeypatch):
    monkeypatch.setenv("XAI_API_KEY", "do-not-use")
    monkeypatch.setenv("OPENAI_API_KEY", "do-not-use")
    monkeypatch.setenv("COPILOT_PROVIDER_BASE_URL", "https://billing.example")
    result = runtime_environment()
    assert "XAI_API_KEY" not in result
    assert "OPENAI_API_KEY" not in result
    assert "COPILOT_PROVIDER_BASE_URL" not in result
    assert os.environ["XAI_API_KEY"] == "do-not-use"
