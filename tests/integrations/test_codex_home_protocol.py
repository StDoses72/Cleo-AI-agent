"""Opt-in local app-server storage check; no account, model, or user data access."""

import os
from pathlib import Path

import pytest
from openai_codex import CodexConfig
from openai_codex.client import CodexClient
from openai_codex.errors import JsonRpcError

from cleo.integrations.codex_home import isolated_codex_config


@pytest.mark.skipif(not os.environ.get("CLEO_TEST_CODEX_BIN"), reason="Requires opt-in Codex CLI")
def test_persisted_cleo_thread_is_not_in_the_shared_codex_home(tmp_path, monkeypatch):
    shared = tmp_path / "shared"
    shared.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    monkeypatch.setenv("CODEX_HOME", str(shared))
    monkeypatch.setenv("CODEX_SQLITE_HOME", str(shared))
    config = CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(workspace),
        env={"OPENAI_API_KEY": ""},
        config_overrides=(
            'model_provider="isolation_test"',
            'model_providers.isolation_test.name="Local storage test"',
            'model_providers.isolation_test.base_url="http://127.0.0.1:1/v1"',
            'model_providers.isolation_test.wire_api="responses"',
            "model_providers.isolation_test.requires_openai_auth=false",
            "features.apps=false", "features.plugins=false", "features.shell_snapshot=false",
        ),
    )
    isolated = isolated_codex_config(config)
    with CodexClient(config=isolated) as client:
        client.initialize()
        started = client._request_raw("thread/start", {
            "cwd": str(workspace), "model": "test-model", "ephemeral": False,
            "approvalPolicy": "never", "sandbox": "read-only",
        })
        identifier = started["thread"]["id"]
        client._request_raw("thread/inject_items", {"threadId": identifier, "items": [{
            "type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "Isolated storage fixture"}],
        }]})
    with CodexClient(config=isolated) as client:
        client.initialize()
        resumed = client._request_raw("thread/resume", {"threadId": identifier})
        assert resumed["thread"]["id"] == identifier
        rollout = Path(resumed["thread"]["path"])
        assert rollout.is_relative_to(Path(isolated.env["CODEX_HOME"]))
        assert "Isolated storage fixture" in rollout.read_text(encoding="utf-8")
    with CodexClient(config=config) as client:
        client.initialize()
        listed = client._request_raw("thread/list", {"sourceKinds": [], "limit": 100})
        assert identifier not in {thread["id"] for thread in listed["data"]}
        with pytest.raises(JsonRpcError, match="no rollout found"):
            client._request_raw("thread/resume", {"threadId": identifier})
