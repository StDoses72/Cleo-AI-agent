"""Opt-in native resume verification; fixtures never contact a model or user account."""

import os
from dataclasses import replace
from pathlib import Path

import pytest
from openai_codex import CodexConfig
from openai_codex.client import CodexClient

from cleo.integrations.codex_home import isolated_codex_config
from cleo.integrations.harness_migration import REPORT


@pytest.mark.skipif(not os.environ.get("CLEO_TEST_CODEX_BIN"), reason="Requires opt-in Codex CLI")
def test_migrated_native_id_resumes_after_restart_without_copying_sqlite(tmp_path, monkeypatch):
    shared = tmp_path / "shared"
    legacy = tmp_path / "cleo/data/codex"
    workspace = tmp_path / "workspace"
    for folder in (shared, legacy, workspace):
        folder.mkdir(parents=True)
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    monkeypatch.setenv("CODEX_HOME", str(shared))
    monkeypatch.setenv("CODEX_SQLITE_HOME", str(shared))
    config = CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(workspace),
        env={"OPENAI_API_KEY": ""},
        config_overrides=(
            'model_provider="migration_test"',
            'model_providers.migration_test.name="Local storage test"',
            'model_providers.migration_test.base_url="http://127.0.0.1:1/v1"',
            'model_providers.migration_test.wire_api="responses"',
            "model_providers.migration_test.requires_openai_auth=false",
            "features.apps=false", "features.plugins=false", "features.shell_snapshot=false",
        ),
    )
    retired_config = replace(config, env={"OPENAI_API_KEY": "", "CODEX_HOME": str(legacy),
                                          "CODEX_SQLITE_HOME": str(legacy)})
    with CodexClient(config=retired_config) as client:
        client.initialize()
        started = client._request_raw("thread/start", {
            "cwd": str(workspace), "model": "test-model", "ephemeral": False,
            "approvalPolicy": "never", "sandbox": "read-only",
        })
        identifier = started["thread"]["id"]
        client._request_raw("thread/inject_items", {"threadId": identifier, "items": [{
            "type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "Native migration fixture"}],
        }]})
    native = isolated_codex_config(config)
    assert native.env["CODEX_HOME"] == str(shared.resolve())
    assert not list(shared.glob("*.sqlite*"))
    assert (legacy / REPORT).exists()
    for _ in range(2):
        with CodexClient(config=native) as client:
            client.initialize()
            resumed = client._request_raw("thread/resume", {"threadId": identifier})
            assert resumed["thread"]["id"] == identifier
            rollout = Path(resumed["thread"]["path"])
            assert rollout.is_relative_to(shared)
            assert "Native migration fixture" in rollout.read_text(encoding="utf-8")
            assert resumed["thread"]["cwd"] == str(workspace)
    assert list((legacy / "sessions").rglob("*.jsonl"))
