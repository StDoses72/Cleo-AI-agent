"""Opt-in native sandbox boundary test; isolated files, no account or model calls."""

import os
import shutil
import sys
import uuid
from pathlib import Path

import pytest
from openai_codex import CodexConfig
from openai_codex.client import CodexClient

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
def test_native_access_modes_and_restored_restrictions(native_directory):
    tmp_path = native_directory
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    runtime_temp = tmp_path / "runtime-temp"
    codex_home = tmp_path / "codex-home"
    for path in (workspace, outside, runtime_temp, codex_home):
        path.mkdir()
    client = CodexClient(config=CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(workspace),
        env={**os.environ, "CODEX_HOME": str(codex_home),
             "TEMP": str(runtime_temp), "TMP": str(runtime_temp), "TMPDIR": str(runtime_temp)},
        config_overrides=("features.plugins=false", "features.apps=false")
        + (('windows.sandbox="unelevated"',) if sys.platform == "win32" else ()),
    ))
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
