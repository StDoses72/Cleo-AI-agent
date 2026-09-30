"""Opt-in real Windows check of shared sandbox credential adoption with the real Codex CLI.

Enable with ``CLEO_TEST_SHARED_SANDBOX=1``, ``CLEO_TEST_CODEX_BIN`` (the Codex CLI Cleo
bundles) and ``CLEO_NATIVE_TEST_ROOT`` (a directory with normal inherited ACLs). It requires
an initialized standalone Codex (``~/.codex`` or ``CODEX_HOME``) whose credentials log on.

Impact on the machine: no account, password, firewall or setup change is allowed. Two
throwaway ``CODEX_HOME`` directories adopt the standalone credentials (read-only source);
Codex then grants the sandbox access to their temporary workspaces only. A guard aborts before
Codex starts unless its own readiness checks would pass without setup, and the test fails if
either account's password changed. Copying Cleo's current users file (when present) can cost
one failed logon per account if it is stale; the lockout policy allows more.
"""

import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from cleo.integrations import codex_sandbox_credentials as coordinator

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or os.environ.get("CLEO_TEST_SHARED_SANDBOX") != "1"
    or not os.environ.get("CLEO_TEST_CODEX_BIN") or not os.environ.get("CLEO_NATIVE_TEST_ROOT"),
    reason="Requires opt-in Windows shared sandbox verification",
)

MARKER = """{
  "version": 5,
  "offline_username": "CodexSandboxOffline",
  "online_username": "CodexSandboxOnline",
  "created_at": "fixture",
  "proxy_ports": [],
  "allow_local_binding": false,
  "read_roots": [],
  "write_roots": []
}"""
PROXY_VARIABLES = {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy",
                   "all_proxy", "NO_PROXY", "no_proxy"}


def _standalone_home() -> Path:
    value = os.environ.get("CODEX_HOME")
    return Path(value) if value else Path.home() / ".codex"


def _prepare_home(home: Path, group_sid: str, seed: Path | None) -> None:
    """Reproduce the directory protection Codex setup applies (lock_persistent_sandbox_dirs)."""
    (home / ".sandbox").mkdir(parents=True)
    (home / ".sandbox-secrets").mkdir()
    subprocess.run(["icacls", str(home / ".sandbox"), "/grant", f"*{group_sid}:(OI)(CI)M"],
                   check=True, capture_output=True)
    subprocess.run(["icacls", str(home / ".sandbox-secrets"), "/deny",
                    f"*{group_sid}:(OI)(CI)M"], check=True, capture_output=True)
    coordinator.marker_path(home).write_text(MARKER, encoding="utf-8")
    (home / "config.toml").write_text('[windows]\nsandbox = "elevated"\n', encoding="utf-8")
    if seed is not None and seed.is_file():
        shutil.copyfile(seed, coordinator.users_path(home))  # isolated copy, never the original


def _client(home: Path, workspace: Path, runtime_temp: Path):
    from openai_codex import CodexConfig
    from openai_codex.client import CodexClient

    env = {key: value for key, value in os.environ.items() if key not in PROXY_VARIABLES}
    env.update({"CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home),
                "TEMP": str(runtime_temp), "TMP": str(runtime_temp)})
    return CodexClient(config=CodexConfig(
        codex_bin=os.environ["CLEO_TEST_CODEX_BIN"], cwd=str(workspace), env=env,
        config_overrides=('windows.sandbox="elevated"', "features.plugins=false",
                          "features.apps=false", f'sqlite_home="{home.as_posix()}"'),
    ))


def _run(client, workspace: Path, command: str) -> dict:
    return client._request_raw("command/exec", {
        "command": ["cmd.exe", "/d", "/c", command], "cwd": str(workspace),
        "timeoutMs": 20000, "sandboxPolicy": {"type": "workspaceWrite"},
    })


def _ready_or_abort(api, home: Path, standalone: Path) -> coordinator.ReconcileResult:
    result = coordinator.reconcile(home, standalone, api=api)
    assert result.action in {"adopted", "current"}, result
    check, _ = coordinator._Validator(api, {}, 0).check_store(coordinator.users_path(home))
    if not check.all_valid:
        pytest.fail(f"aborting before Codex could run setup: {check}")
    return result


def test_real_codex_runs_with_adopted_credentials_without_resetting_accounts():
    api = coordinator.Win32CredentialApi()
    standalone = _standalone_home()
    group_sid = api._sandbox_group_sid()
    if not group_sid or coordinator.marker_status(standalone) != "valid":
        pytest.skip("standalone Codex sandbox is not initialized")
    for username in coordinator.ROLES.values():
        flags = api.account_flags(username)
        assert flags is not None and not flags & (0x2 | 0x10 | 0x800000), username
    before = {name: api.password_last_set(name) for name in coordinator.ROLES.values()}
    standalone_users = coordinator.users_path(standalone).read_bytes()

    root = Path(os.environ["CLEO_NATIVE_TEST_ROOT"]).resolve(strict=True)
    scratch = root / f"shared-sandbox-{uuid.uuid4().hex[:8]}"
    homes = {name: scratch / name / "codex-home" for name in ("a", "b")}
    workspaces = {name: scratch / name / "workspace" for name in ("a", "b")}
    outside, runtime_temp = scratch / "outside", scratch / "runtime-temp"
    for path in (*workspaces.values(), outside, runtime_temp):
        path.mkdir(parents=True)
    cleo_users = Path(os.environ.get("LOCALAPPDATA", "")) / "Cleo/data/codex" / \
        ".sandbox-secrets/sandbox_users.json"
    _prepare_home(homes["a"], group_sid, cleo_users)
    _prepare_home(homes["b"], group_sid, None)
    try:
        first = _ready_or_abort(api, homes["a"], standalone)
        assert _ready_or_abort(api, homes["b"], standalone).action == "adopted"
        assert api.file_protected(coordinator.users_path(homes["a"]))

        client = _client(homes["a"], workspaces["a"], runtime_temp)
        client.start()
        client.initialize()
        try:
            identity = _run(client, workspaces["a"], "whoami")
            assert identity["exitCode"] == 0, identity
            account = identity["stdout"].strip().lower().rsplit("\\", 1)[-1]
            assert account == "codexsandboxoffline", identity
            inside = _run(client, workspaces["a"], "echo inside> inside.txt")
            assert inside["exitCode"] == 0 and (workspaces["a"] / "inside.txt").exists(), inside
            denied = _run(client, workspaces["a"], f'echo x> "{outside / "outside.txt"}"')
            assert denied["exitCode"] != 0 and not (outside / "outside.txt").exists(), denied
            secret = _run(client, workspaces["a"],
                          f'type "{coordinator.users_path(homes["a"])}"')
            assert secret["exitCode"] != 0 and "password" not in secret["stdout"], secret
            network = _run(client, workspaces["a"],
                           "curl.exe -s -S -m 5 -o NUL https://example.com")
            assert network["exitCode"] != 0, network
        finally:
            client.close()

        client = _client(homes["b"], workspaces["b"], runtime_temp)
        client.start()
        client.initialize()
        try:
            own = _run(client, workspaces["b"], "echo b> b.txt")
            assert own["exitCode"] == 0 and (workspaces["b"] / "b.txt").exists(), own
            # Same Windows account, different home: A's workspace grant must not apply to B.
            cross = _run(client, workspaces["b"], f'echo b> "{workspaces["a"] / "from-b.txt"}"')
            assert cross["exitCode"] != 0 and not (workspaces["a"] / "from-b.txt").exists(), cross
        finally:
            client.close()

        # Restart: a new app-server process with the same home keeps working.
        assert coordinator.reconcile(homes["a"], standalone, api=api).action == "current"
        client = _client(homes["a"], workspaces["a"], runtime_temp)
        client.start()
        client.initialize()
        try:
            again = _run(client, workspaces["a"], "echo again> again.txt")
            assert again["exitCode"] == 0, again
        finally:
            client.close()

        for home in homes.values():
            assert not coordinator.setup_error_path(home).exists()
            assert coordinator.marker_path(home).read_text(encoding="utf-8") == MARKER
        print("first reconcile:", first.action, first.cleo.accounts if first.cleo else None)
    finally:
        after = {name: api.password_last_set(name) for name in coordinator.ROLES.values()}
        assert coordinator.users_path(standalone).read_bytes() == standalone_users
        assert all(abs((after[name] or 0) - (before[name] or 0)) <= 3 for name in before), (
            before, after)
        shutil.rmtree(scratch, ignore_errors=True)
