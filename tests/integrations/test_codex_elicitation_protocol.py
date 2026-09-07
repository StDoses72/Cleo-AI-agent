"""Opt-in wire test against an installed app-server; no model or browser calls."""

import asyncio
import json
import os
import sys

import pytest
from openai_codex import CodexConfig
from openai_codex.client import CodexClient

from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker

MCP_SERVER = '''
import json, sys
def send(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)
call_id = None
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        send({"id": request["id"], "result": {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "approval-test", "version": "1"},
        }})
    elif method == "tools/list":
        send({"id": request["id"], "result": {"tools": [{
            "name": "confirm", "description": "Test explicit confirmation",
            "inputSchema": {"type": "object", "properties": {}},
        }]}})
    elif method == "tools/call":
        call_id = request["id"]
        send({"id": "confirmation", "method": "elicitation/create", "params": {
            "mode": "form", "message": "Confirm the isolated protocol test?",
            "requestedSchema": {"type": "object", "properties": {}},
        }})
    elif request.get("id") == "confirmation":
        send({"id": call_id, "result": {"content": [{
            "type": "text", "text": json.dumps(request["result"]),
        }]}})
    elif "id" in request:
        send({"id": request["id"], "result": {}})
'''


@pytest.mark.skipif(not os.environ.get("CLEO_TEST_CODEX_BIN"), reason="Requires opt-in Codex CLI")
def test_installed_app_server_accepts_mcp_approval_responses(tmp_path):
    script = tmp_path / "mcp.py"
    script.write_text(MCP_SERVER, encoding="utf-8")
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    client = CodexClient(config=CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(tmp_path),
        env={**os.environ, "CODEX_HOME": str(codex_home)},
        config_overrides=(
            f"mcp_servers.approval_test.command={json.dumps(sys.executable)}",
            f"mcp_servers.approval_test.args={json.dumps([str(script)])}",
            "mcp_servers.approval_test.required=true",
        ),
    ))
    broker = CodexApprovalBroker()
    client._approval_handler = broker.handle

    async def scenario():
        decision = "accept"
        seen = []

        async def emit(event):
            if event.type == "permission_request":
                request = event.data["payload"]
                seen.append(request)
                await broker.resolve(request["id"], decision)

        broker.bind(asyncio.get_running_loop(), emit)
        try:
            await asyncio.wait_for(asyncio.to_thread(client.start), 15)
            await asyncio.wait_for(asyncio.to_thread(client.initialize), 15)
            started = await asyncio.wait_for(asyncio.to_thread(
                client._request_raw, "thread/start", {"cwd": str(tmp_path)},
            ), 15)
            for decision in ("accept", "decline", "cancel"):
                result = await asyncio.wait_for(asyncio.to_thread(
                    client._request_raw, "mcpServer/tool/call", {
                        "threadId": started["thread"]["id"],
                        "server": "approval_test", "tool": "confirm", "arguments": {},
                    },
                ), 15)
                # Compare actual MCP result, not just the broker's in-memory output.
                assert not result.get("isError"), result
                payload = json.loads(result["content"][0]["text"])
                assert payload["action"] == decision
            assert len(seen) == 3
        finally:
            broker.cancel_all()
            await asyncio.to_thread(client.close)

    asyncio.run(scenario())
