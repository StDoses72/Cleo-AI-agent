"""Exercise MCP approval through the real Codex agent with a local scripted model."""

import asyncio
import gzip
import json
import os
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from openai_codex import AsyncCodex
from openai_codex.client import CodexClient

from cleo.integrations.codex_home import isolated_codex_config
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.memory import MemoryMcp


@pytest.mark.skipif(not os.environ.get("CLEO_TEST_CODEX_BIN"), reason="Requires opt-in Codex CLI")
@pytest.mark.parametrize("require_prompt", [False, True])
@pytest.mark.parametrize("session_mode", ["deny_all", "user"])
@pytest.mark.parametrize("desktop_runtime", ["isolated", "host"])
@pytest.mark.parametrize(
    "real_desktop",
    [
        False,
        pytest.param(
            True,
            marks=pytest.mark.skipif(
                not os.environ.get("CLEO_TEST_REAL_DESKTOP"),
                reason="Requires opt-in Docker desktop",
            ),
        ),
    ],
)
def test_agent_can_use_owned_computer_tools_without_approval(
    tmp_path,
    monkeypatch,
    require_prompt,
    real_desktop,
    session_mode,
    desktop_runtime,
):
    """Purpose: Reproduce the actual never-policy MCP rejection without an external model.

    Input: Production MCP configuration and the installed Codex CLI.
    Output: Scoped grants succeed; an explicit prompt policy still blocks both tools.
    Optional Docker validation uses a disposable desktop with no user accounts or files.
    """
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    computer_path = tmp_path / "computer-use.json"
    if real_desktop and desktop_runtime == "host":
        pytest.skip("Host protocol tests use the fake desktop; never operate the user's desktop")
    computer_path.write_text(json.dumps({"runtime": desktop_runtime}))
    memory = MemoryMcp(tmp_path / "memory", computer_config_path=computer_path)
    overrides = memory.codex_config(approval_mode=session_mode).config_overrides
    # Keep production server metadata/configuration, replacing only desktop execution.
    bootstrap = (
        "from pathlib import Path\n"
        "import cleo.mcp.computer_server as bridge\n"
        "async def fake_invoke(*args, **kwargs):\n"
        "    return [{'type': 'text', 'text': 'CLEO_COMPUTER_OK'}]\n"
        "bridge.invoke = fake_invoke\n"
        f"bridge.create_server(Path({str(computer_path)!r})).run(show_banner=False)\n"
    )
    overrides = tuple(
        value for value in overrides if not value.startswith("mcp_servers.cleo_memory.")
    )
    if not real_desktop:
        overrides = tuple(
            value for value in overrides if not value.startswith("mcp_servers.cleo_computer.args=")
        )
        overrides += ("mcp_servers.cleo_computer.args=" + json.dumps(["-c", bootstrap]),)
    if require_prompt:
        overrides += tuple(
            f'mcp_servers.cleo_computer.tools.{name}.approval_mode="prompt"'
            for name in ("computer_tools", "computer_call")
        )
    requests = []
    calls = [("computer_tools", {}), ("computer_call", {"name": "Snapshot", "arguments": {}})]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            requests.append(json.loads(body))
            index = len(requests) - 2
            if index == -1:
                item = {
                    "type": "tool_search_call",
                    "id": "search_probe",
                    "call_id": "search",
                    "execution": "client",
                    "status": "completed",
                    "arguments": {
                        "query": "cleo_computer computer_tools computer_call",
                        "limit": 2,
                    },
                }
            elif index < len(calls):
                name, arguments = calls[index]
                item = {
                    "type": "function_call",
                    "id": f"fc_{index}",
                    "call_id": f"call_{index}",
                    "name": name,
                    "namespace": "mcp__cleo_computer",
                    "arguments": json.dumps(arguments),
                }
            else:
                item = {
                    "type": "message",
                    "id": "msg_done",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Done."}],
                }
            events = [
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {
                    "type": "response.completed",
                    "response": {
                        "id": f"resp_{index}",
                        "status": "completed",
                        "output": [item],
                        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                    },
                },
            ]
            data = "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    config = replace(
        memory.codex_config(),
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"],
        cwd=str(workspace),
        config_overrides=(
            *overrides,
            "mcp_servers.cleo_computer.required=true",
            'model_provider="local_probe"',
            'model_providers.local_probe.name="Local MCP approval test"',
            f'model_providers.local_probe.base_url="http://127.0.0.1:{server.server_port}/v1"',
            'model_providers.local_probe.wire_api="responses"',
            "model_providers.local_probe.requires_openai_auth=false",
            "features.apps=false",
            "features.plugins=false",
            "features.shell_snapshot=false",
        ),
    )
    approvals = []
    def approve(method, params):
        approvals.append((method, params))
        return {"action": "accept", "content": {}}

    async def transition_scenario():
        provider = CodexProvider(None, memory_mcp=memory)
        local_overrides = tuple(value for value in config.config_overrides
                                if '.tools.computer_' not in value
                                and not value.startswith('mcp_servers.cleo_memory.'))
        def local_client(native_config=None, *, legacy=False):
            merged = replace(config, config_overrides=(
                *native_config.config_overrides, *local_overrides,
                'mcp_servers.cleo_memory.enabled=false',
            ))
            return AsyncCodex(config=isolated_codex_config(merged))
        monkeypatch.setattr(provider, '_client', local_client)
        session = await provider.create_session(str(workspace), model='gpt-5.5')
        try:
            await provider.enable_user_approvals(session.id)
            await provider.update_session_options(session.id, approval_mode='user')
            runtime = provider._sessions[session.id]
            current_native = runtime.thread.id
            async def emit(event):
                if event.type == 'permission_request':
                    request = event.data['payload']
                    approvals.append(('mcpServer/elicitation/request', request))
                    assert not request.get('unsupportedReason'), request
                    await provider.resolve_approval(session.id, request['id'], 'accept')
            result = await provider.prompt(session.id, 'Use computer tools for this test.', emit)
            assert result.status == 'completed', result.error
            # Changing the policy after a real turn must retain its native transcript.
            await provider.update_session_options(session.id, approval_mode='deny_all',
                                                  sandbox='full-access')
            assert runtime.thread.id == current_native
            await provider.update_session_options(session.id, approval_mode='user',
                                                  sandbox='workspace-write')
            assert runtime.thread.id == current_native
            assert provider.session_native_id(session.id) == current_native
        finally:
            await provider.close(session.id)

    try:
        if session_mode == 'user':
            asyncio.run(asyncio.wait_for(transition_scenario(), 90))
        else:
            with CodexClient(
                config=isolated_codex_config(config), approval_handler=approve,
            ) as client:
                client.initialize()
                started = client._request_raw(
                    "thread/start",
                    {
                        "cwd": str(workspace),
                        "model": "gpt-5.5",
                        "ephemeral": False,
                        "approvalPolicy": "on-request" if session_mode == "user" else "never",
                        "approvalsReviewer": "user",
                        "sandbox": "workspace-write",
                    },
                )
                turn = client._request_raw(
                    "turn/start",
                    {
                        "threadId": started["thread"]["id"],
                        "input": [{"type": "text", "text": "Use computer tools."}],
                    },
                )
                turn_id = turn["turn"]["id"]
                client.register_turn_notifications(turn_id)
                timeout = threading.Timer(40, client.close)
                timeout.start()
                try:
                    while client.next_turn_notification(turn_id).method != "turn/completed":
                        pass
                finally:
                    timeout.cancel()
                    client.unregister_turn_notifications(turn_id)
        outputs = {
            item["call_id"]: item["output"]
            for request in requests
            for item in request.get("input", [])
            if item.get("type") == "function_call_output"
        }
        assert len(outputs) == 2, outputs
        if session_mode == "user":
            assert len(approvals) == 2, approvals
            assert {method for method, _ in approvals} == {"mcpServer/elicitation/request"}
        if require_prompt and session_mode == "deny_all":
            assert all("requires approval" in str(result) for result in outputs.values())
        else:
            assert all("requires approval" not in str(result) for result in outputs.values())
            if real_desktop:
                assert "Snapshot" in str(outputs["call_0"])
                assert any(block.get("type") == "input_image" for block in outputs["call_1"])
            else:
                assert all("CLEO_COMPUTER_OK" in str(result) for result in outputs.values())
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        if real_desktop:
            from cleo.computer_desktop.runtime import desktop_action, docker, identity, inspect

            # inspect validates ownership; these resources belong only to this pytest directory.
            if inspect(computer_path):
                asyncio.run(desktop_action(computer_path, "stop"))
                docker("rm", identity(computer_path))
                docker("volume", "rm", identity(computer_path) + "-home")
