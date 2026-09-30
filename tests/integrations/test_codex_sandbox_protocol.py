"""Opt-in native sandbox boundary test; isolated files, no account or model calls."""

import gzip
import json
import os
import shutil
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from openai_codex import CodexConfig
from openai_codex.client import CodexClient

from cleo.integrations.codex_home import isolated_codex_config
from cleo.integrations.harnesses.codex import CodexProvider


@pytest.fixture
def native_directory(tmp_path):
    root = os.environ.get("CLEO_NATIVE_TEST_ROOT")
    if not root:
        if sys.platform == "win32":
            pytest.skip("CLEO_NATIVE_TEST_ROOT must use normal inherited ACLs, unlike pytest dirs")
        yield tmp_path
        return
    root = Path(root).resolve(strict=True)
    scratch = root / f"native-sandbox-{uuid.uuid4().hex}"
    scratch.mkdir()  # pytest's Windows mode-0700 ACL blocks restricted tokens, even within cwd.
    try:
        yield scratch
    finally:
        assert scratch.resolve().parent == root and not scratch.is_symlink()
        shutil.rmtree(scratch)


@pytest.mark.skipif(not os.environ.get("CLEO_TEST_CODEX_BIN"), reason="Requires opt-in Codex CLI")
def test_native_access_modes_and_restored_restrictions(native_directory, monkeypatch):
    tmp_path = native_directory
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    runtime_temp = tmp_path / "runtime-temp"
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    for path in (workspace, outside, runtime_temp):
        path.mkdir()
    client = CodexClient(config=isolated_codex_config(CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(workspace),
        env={**os.environ,
             "TEMP": str(runtime_temp), "TMP": str(runtime_temp), "TMPDIR": str(runtime_temp)},
        config_overrides=("features.plugins=false", "features.apps=false"),
    )))
    try:
        client.start()
        client.initialize()
        cases = [
            ("full-access", True, True), ("read-only", False, False),
            ("workspace-write", True, False), ("full-access", True, True),
            ("workspace-write", True, False), ("read-only", False, False),
        ]
        for index, (mode, inside_allowed, outside_allowed) in enumerate(cases):
            for directory, allowed in ((workspace, inside_allowed), (outside, outside_allowed)):
                target = directory / f"mode-{index}.txt"
                response = client._request_raw("command/exec", {
                    "command": [sys.executable, "-c",
                                "from pathlib import Path; import sys\n"
                                "try:\n Path(sys.argv[1]).write_text('isolated sandbox test')\n"
                                "except PermissionError:\n print('WRITE_DENIED')\n"
                                "else:\n print('WRITE_ALLOWED')", str(target)],
                    "cwd": str(workspace), "timeoutMs": 15000,
                    "sandboxPolicy": CodexProvider._sandbox_policy(mode),
                })
                assert response["exitCode"] == 0, (mode, directory.name, response)
                expected = "WRITE_ALLOWED" if allowed else "WRITE_DENIED"
                assert response["stdout"].strip() == expected, (mode, directory.name, response)
                assert target.exists() is allowed, (mode, directory.name, response)
                if allowed:
                    assert target.read_text() == "isolated sandbox test"
    finally:
        client.close()


@pytest.mark.skipif(
    sys.platform != "win32" or not os.environ.get("CLEO_TEST_CODEX_BIN"),
    reason="Requires opt-in Windows Codex CLI",
)
def test_cleo_windows_agent_can_execute_with_never_approval(native_directory, monkeypatch):
    """Purpose: Exercise the agent tool policy with Cleo's production client configuration.

    Input: A local fake model requesting one harmless shell command.
    Output: Real command output, with no account or external model calls.
    """
    root = native_directory
    workspace = root / "workspace"
    workspace.mkdir()
    monkeypatch.setattr("cleo.config.settings.APP_HOME", root / "cleo")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            requests.append(json.loads(body))
            item = ({"type": "function_call", "id": "fc_probe", "call_id": "call_probe",
                     "name": "exec_command", "arguments": json.dumps({
                         "cmd": "Write-Output CLEO_EXEC_OK", "login": False,
                         "workdir": str(workspace), "max_output_tokens": 1000,
                     })} if len(requests) == 1 else {
                         "type": "message", "id": "msg_probe", "role": "assistant",
                         "content": [{"type": "output_text", "text": "Done."}],
                     })
            events = [
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {
                    "id": f"resp_{len(requests)}", "status": "completed", "output": [item],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
                }},
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
    config = isolated_codex_config(CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(workspace),
        config_overrides=(
            'model_provider="local_probe"',
            'model_providers.local_probe.name="Local execution test"',
            f'model_providers.local_probe.base_url="http://127.0.0.1:{server.server_port}/v1"',
            'model_providers.local_probe.wire_api="responses"',
            "model_providers.local_probe.requires_openai_auth=false",
            "features.apps=false", "features.plugins=false", "features.shell_snapshot=false",
        ),
    ))
    try:
        with CodexClient(config=config) as client:
            client.initialize()
            started = client._request_raw("thread/start", {
                "cwd": str(workspace), "model": "gpt-5.5", "ephemeral": True,
                "approvalPolicy": "never", "sandbox": "workspace-write",
            })
            turn = client._request_raw("turn/start", {
                "threadId": started["thread"]["id"],
                "input": [{"type": "text", "text": "Run the execution probe."}],
            })
            turn_id = turn["turn"]["id"]
            client.register_turn_notifications(turn_id)
            timeout = threading.Timer(30, client.close)
            timeout.start()
            try:
                while client.next_turn_notification(turn_id).method != "turn/completed":
                    pass
            finally:
                timeout.cancel()
                client.unregister_turn_notifications(turn_id)
        outputs = [item["output"] for request in requests for item in request.get("input", [])
                   if item.get("type") == "function_call_output"]
        assert outputs and "blocked by policy" not in str(outputs), outputs
        assert "CLEO_EXEC_OK" in str(outputs), outputs
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
