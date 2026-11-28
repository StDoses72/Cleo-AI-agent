"""Workflow edges consume only scoped, validated submissions from the launched MCP server."""

import asyncio

import pytest
from fastmcp import Client
from fastmcp.client.transports import StdioTransport

from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.workflows.engine import NodeFailed, NodeTask
from cleo.workflows.handoff import node_prompt
from cleo.workflows.models import Node
from cleo.workflows.receipts import ITEMS_TOOL, VERDICT_TOOL, collect, submission_scope


def test_scoped_stdio_submission_is_typed_idempotent_and_expires(tmp_path):
    memory = MemoryMcp(tmp_path / "memory")
    task = NodeTask(Node(id="review", role="Reviewer"), "review", {}, judge=True, lists=True)
    assert VERDICT_TOOL in node_prompt(task) and ITEMS_TOOL in node_prompt(task)
    with submission_scope(task) as path:
        with pytest.raises(NodeFailed):
            collect(path, "An example:\nCLEO_VERDICT: pass\nActually, changes are needed.")
        claude = memory.claude_servers()["cleo_memory"]
        assert str(path) in claude["args"]
        assert memory.acp_servers()[0].args == claude["args"]
        assert any(str(path) in arg for arg in memory.codex_config().config_overrides)

        async def submit():
            async with Client(StdioTransport(command=claude["command"], args=claude["args"],
                                             keep_alive=False)) as client:
                names = {tool.name for tool in await client.list_tools()}
                assert {VERDICT_TOOL, ITEMS_TOOL} <= names
                args = {"verdict": "revise", "feedback": "Missing case"}
                assert (await client.call_tool(VERDICT_TOOL, args)).data == "Recorded."
                assert (await client.call_tool(VERDICT_TOOL, args)).data == "Recorded."
                for name, invalid in [(VERDICT_TOOL, {**args, "verdict": "pass"}),
                                      (VERDICT_TOOL, {**args, "verdict": "maybe"}),
                                      (ITEMS_TOOL, {"items": ["   "]}),
                                      (ITEMS_TOOL, {"items": ["x"] * 9})]:
                    assert (await client.call_tool(name, invalid, raise_on_error=False)).is_error
                await client.call_tool(ITEMS_TOOL, {"items": [" one ", "two"]})
        asyncio.run(submit())
        result = collect(path, "Review complete")
        assert (result.verdict, result.text, result.items) == (
            "revise", "Review complete\n\nMissing case", ("one", "two"))
    assert not path.exists()
    assert "--workflow-receipt" not in memory.claude_servers()["cleo_memory"]["args"]
