"""Cleo's shared sandbox credential coordinator, driven through Codex's decision model."""

import asyncio
import base64
import json
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest
from codex_sandbox_model import OFFLINE, ONLINE, CodexHome, FakeApi, Machine, SetupFailure

from cleo.integrations import codex_sandbox_credentials as coordinator
from cleo.integrations.codex_sandbox_credentials import (
    ReconcileResult,
    dacl_denies_read,
    reconcile,
    restore,
    windows_sandbox_mode,
)


class World:
    def __init__(self, tmp_path: Path, *, standalone: bool = True):
        self.machine = Machine()
        self.api = FakeApi(self.machine)
        self.cleo = CodexHome(self.machine, tmp_path / "cleo", "cleo", setup_path="uac")
        self.standalone = CodexHome(self.machine, tmp_path / "standalone", "standalone",
                                    setup_path="service")
        self.external = self.standalone.path if standalone else tmp_path / "absent"

    def turn(self, **kwargs) -> ReconcileResult:
        """One Cleo turn: coordinate, then run a sandboxed command with Codex's rules."""
        result = reconcile(self.cleo.path, self.external, api=self.api, now=self.machine.clock,
                           **kwargs)
        self.cleo.run_command()
        return result

    def standalone_run(self) -> None:
        try:
            self.standalone.run_command()
        except SetupFailure:
            pass

    def failed_logons(self) -> int:
        return sum(1 for _, ok in self.machine.logons if not ok)


def _snapshot(root: Path, *, skip: tuple[str, ...] = ()) -> dict[str, bytes]:
    files = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_file() and not relative.startswith(skip):
            files[relative] = path.read_bytes()
    return files


def _codex_parse_users(path: Path) -> dict:
    """Codex's serde reader: required fields, unknown fields ignored."""
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value["version"], int)
    for role in ("offline", "online"):
        assert isinstance(value[role]["username"], str)
        base64.b64decode(value[role]["password"])
    return value


# 1. Only Cleo is installed -----------------------------------------------------------------


def test_only_cleo_sets_up_once_and_then_uses_the_fast_path(tmp_path):
    world = World(tmp_path, standalone=False)
    first = world.turn()
    assert first.action == "skipped" and first.reason == "cleo_setup_marker_missing"
    assert world.machine.rotations == 1  # Codex's own first setup
    assert world.turn().action == "current"
    logons = len(world.machine.logons)
    for _ in range(10):
        assert world.turn().action == "current"
    # Only the command logons remain; the coordinator re-validates nothing unchanged.
    assert len(world.machine.logons) == logons + 10
    assert world.machine.rotations == 1 and world.failed_logons() == 0


# 2 + 5. Standalone initialized first; one side re-initializes; no reset loop ---------------


def test_cleo_adopts_standalone_credentials_instead_of_resetting(tmp_path):
    world = World(tmp_path)
    world.standalone_run()
    world.turn()  # Cleo's first setup cannot be avoided (no marker yet)
    assert world.machine.rotations == 2 and world.cleo.full_setups == 1
    world.standalone_run()  # standalone service path: rotates, then lock failure
    assert world.standalone.setup_errors == ["helper_sandbox_lock_failed"]
    assert world.standalone.marker.read_bytes() == b""

    result = world.turn()
    assert result.action == "adopted" and result.adopted_roles == ["offline", "online"]
    assert result.external_setup == {"marker": "empty"}
    assert world.cleo.full_setups == 1  # no Cleo reset, no UAC prompt

    # While the standalone service path stays broken, every standalone run rotates; Cleo
    # follows each time instead of resetting back, so the loop no longer feeds itself.
    for _ in range(3):
        world.standalone_run()
        assert world.turn().action == "adopted"
    assert world.cleo.full_setups == 1

    # Standalone re-initialization through the UAC helper (the official CLI) ends it.
    world.standalone.setup_path = "uac"
    world.standalone.full_setup()
    world.standalone.setup_path = "service"
    rotations = world.machine.rotations
    assert world.turn().action == "adopted"
    for _ in range(10):  # 3. alternating use
        world.standalone_run()
        assert world.turn().action == "current"
    assert world.machine.rotations == rotations
    assert world.cleo.full_setups == 1


def test_standalone_reinitialization_after_cleo_is_followed_without_prompt(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.standalone.setup_path = "uac"
    world.standalone_run()  # standalone initializes second and rotates once
    rotations = world.machine.rotations
    assert world.turn().action == "adopted"
    world.standalone_run()
    world.turn()
    assert world.machine.rotations == rotations and world.cleo.full_setups == 1


def test_cleo_records_that_no_longer_log_on_cost_one_failed_logon_each(tmp_path):
    world = World(tmp_path, standalone=False)
    world.turn()
    world.machine.rotate()  # an outside reset with no readable replacement
    result = reconcile(world.cleo.path, world.external, api=world.api, now=world.machine.clock)
    assert result.action == "no_valid_source"
    assert result.cleo.accounts == {"offline": "password_invalid", "online": "password_invalid"}
    failed = world.failed_logons()
    for _ in range(5):
        reconcile(world.cleo.path, world.external, api=world.api, now=world.machine.clock)
    assert world.failed_logons() == failed  # remembered, lockout budget preserved


# 4. Concurrent start and lock handling -----------------------------------------------------


def test_running_codex_setup_defers_without_touching_files(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.machine.rotate()
    world.standalone.full_setup()
    before = _snapshot(world.cleo.path)
    world.machine.lock_holder = "standalone-setup"
    result = reconcile(world.cleo.path, world.external, api=world.api, now=world.machine.clock)
    assert result.action == "deferred" and "setup lock held" in result.reason
    world.machine.lock_holder = None
    after = _snapshot(world.cleo.path, skip=(".sandbox-secrets/cleo-coordination/lock",))
    before.pop(".sandbox-secrets/cleo-coordination/lock", None)
    assert {k: v for k, v in after.items() if "cleo-coordination" not in k} == {
        k: v for k, v in before.items() if "cleo-coordination" not in k}


def test_concurrent_cleo_processes_serialize_and_time_out(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.turn()  # first coordinated turn after Cleo's setup creates the directory
    directory = coordinator.coordination_dir(world.cleo.path)
    world.machine.rotate()  # force the slow path, which needs the lock
    entered, release = threading.Event(), threading.Event()

    def hold():
        with coordinator._file_lock(directory, 1.0):
            entered.set()
            release.wait(5)

    worker = threading.Thread(target=hold)
    worker.start()
    assert entered.wait(5)
    try:
        result = reconcile(world.cleo.path, world.external, api=world.api, lock_timeout=0.2)
        assert result.action == "deferred" and "another Cleo process" in result.reason
    finally:
        release.set()
        worker.join()
    assert reconcile(world.cleo.path, world.external, api=world.api).action in {
        "adopted", "no_valid_source"}


def test_simultaneous_first_start_leaves_one_consistent_credential(tmp_path):
    world = World(tmp_path)
    world.standalone_run()
    world.turn()
    world.standalone_run()
    results = []
    threads = [threading.Thread(target=lambda: results.append(
        reconcile(world.cleo.path, world.external, api=world.api, lock_timeout=5)))
        for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    actions = sorted(result.action for result in results)
    assert actions.count("adopted") == 1, actions
    assert set(actions) <= {"adopted", "current", "deferred"}
    world.cleo.run_command()
    assert world.cleo.full_setups == 1


# 6. Missing, corrupt, partial and interrupted state ----------------------------------------


@pytest.mark.parametrize("content", [None, b"", b"{\"version\": 5, \"offline\": ", b"[]"])
def test_missing_or_corrupt_cleo_users_file_is_backed_up_and_replaced(tmp_path, content):
    world = World(tmp_path)
    world.turn()
    world.standalone.setup_path = "uac"
    world.standalone_run()
    if content is None:
        world.cleo.users.unlink()
    else:
        world.cleo.users.write_bytes(content)
    result = world.turn()
    assert result.action == "adopted"
    assert world.cleo.full_setups == 1
    assert _codex_parse_users(world.cleo.users)["version"] == 5
    if content:
        backup = coordinator.coordination_dir(world.cleo.path) / result.backup
        assert backup.read_bytes() == content
    else:
        assert result.backup is None


def test_interrupted_cleo_setup_is_left_to_codex(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.cleo.marker.write_bytes(b"")  # setup interrupted before marker commit
    users = world.cleo.users.read_bytes()
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.action == "skipped" and result.reason == "cleo_setup_marker_empty"
    assert world.cleo.users.read_bytes() == users
    assert world.cleo.marker.read_bytes() == b""  # never faked


def test_interrupted_commit_leaves_previous_file_and_is_cleaned_up(tmp_path, monkeypatch):
    world = World(tmp_path)
    world.turn()
    world.standalone.setup_path = "uac"
    world.standalone_run()
    original = world.cleo.users.read_bytes()

    def crash(*_args):
        raise OSError(5, "simulated crash before replace")

    monkeypatch.setattr(coordinator.os, "replace", crash)
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.action == "deferred"
    assert world.cleo.users.read_bytes() == original
    monkeypatch.undo()
    stray = world.cleo.users.parent / ".sandbox_users.json.cleo-crashed.tmp"
    stray.write_bytes(b"partial")
    assert world.turn().action == "adopted"
    assert not stray.exists()
    assert world.cleo.full_setups == 1


def test_newer_format_users_file_is_never_overwritten(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.standalone.setup_path = "uac"
    world.standalone_run()
    newer = json.dumps({"version": 6, "offline": {}, "future": True}).encode()
    world.cleo.users.write_bytes(newer)
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.action == "deferred" and result.reason == "cleo_store_newer"
    assert world.cleo.users.read_bytes() == newer


def test_dpapi_failure_is_distinguished_and_not_retried(tmp_path):
    world = World(tmp_path, standalone=False)
    world.turn()
    document = json.loads(world.cleo.users.read_text())
    document["offline"]["password"] = base64.b64encode(b"foreign machine blob").decode()
    world.cleo.users.write_text(json.dumps(document))
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.cleo.accounts == {"offline": "dpapi_failed", "online": "valid"}
    calls = world.api.unprotect_calls
    reconcile(world.cleo.path, world.external, api=world.api)
    assert world.api.unprotect_calls == calls + 1  # only the still-valid online record


# 7. UAC cancel, directory access and trust boundary ----------------------------------------


def test_uac_cancel_and_lock_failure_reports_are_classified(tmp_path):
    world = World(tmp_path, standalone=False)
    world.machine.uac_cancel = True
    with pytest.raises(SetupFailure, match="canceled"):
        world.turn()
    error = world.cleo.path / ".sandbox" / "setup_error.json"
    error.parent.mkdir(parents=True, exist_ok=True)
    error.write_text(json.dumps({"code": "orchestrator_helper_launch_canceled",
                                 "message": "user declined"}))
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.action == "skipped"
    assert result.cleo_setup_error == {"code": "orchestrator_helper_launch_canceled",
                                       "category": "uac_canceled"}
    error.write_text(json.dumps({"code": "helper_sandbox_lock_failed"}))
    assert coordinator.read_setup_error(world.cleo.path)["category"] == (
        "sandbox_directory_lock_failed")


def test_unprotected_or_redirected_secrets_directory_is_never_written(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.standalone.setup_path = "uac"
    world.standalone_run()
    before = world.cleo.users.read_bytes()
    world.api.protected = False
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert (result.action, result.reason) == ("skipped", "cleo_secrets_dir_unprotected")
    world.api.protected = True
    world.api.is_reparse_point = lambda path: path.name == ".sandbox-secrets"
    assert reconcile(world.cleo.path, world.external, api=world.api).action == "skipped"
    assert world.cleo.users.read_bytes() == before


def test_unreadable_users_file_defers(tmp_path, monkeypatch):
    world = World(tmp_path)
    world.turn()
    world.machine.rotate()
    real = coordinator._read_bytes
    monkeypatch.setattr(coordinator, "_read_bytes", lambda path: (
        ("busy", None) if path.name == "sandbox_users.json" else real(path)))
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert (result.action, result.reason) == ("deferred", "cleo_store_busy")


def test_locked_or_disabled_accounts_are_not_hammered(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.machine.rotate()
    world.api.logon = lambda username, password: 1909
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.cleo.accounts == {"offline": "account_locked", "online": "account_locked"}
    assert result.external is None or result.external.state != "checked" or all(
        value == "account_locked" for value in result.external.accounts.values())
    world.machine.flags[ONLINE] = 0x10  # UF_LOCKOUT: no logon attempt at all
    attempts = len(world.machine.logons)
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert (result.action, result.reason) == ("deferred", "account_locked_out")
    assert len(world.machine.logons) == attempts
    world.machine.flags[OFFLINE] = 0x2
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.action == "skipped" and "disabled" in result.reason


# 8. Restart, compatibility and rollback ----------------------------------------------------


def test_restart_reuses_validation_and_other_homes_are_read_only(tmp_path):
    world = World(tmp_path)
    world.standalone.setup_path = "uac"
    world.standalone_run()
    world.turn()
    world.standalone_run()
    world.turn()
    standalone_before = _snapshot(world.standalone.path)
    cleo_before = _snapshot(world.cleo.path, skip=(".sandbox-secrets/",))
    logons = len(world.machine.logons)
    restarted = FakeApi(world.machine)  # new process, same persisted state
    assert reconcile(world.cleo.path, world.external, api=restarted).action == "current"
    assert len(world.machine.logons) == logons
    assert _snapshot(world.standalone.path) == standalone_before
    # Marker, config, cap SIDs and all other Cleo data are untouched by coordination.
    assert _snapshot(world.cleo.path, skip=(".sandbox-secrets/",)) == cleo_before


def test_users_file_round_trip_with_codex_reader_and_writer(tmp_path):
    world = World(tmp_path)
    world.turn()
    document = json.loads(world.cleo.users.read_text())
    document["future_field"] = {"keep": [1, 2]}
    document["online"]["note"] = "record extension"
    world.cleo.users.write_text(json.dumps(document))
    world.standalone.setup_path = "uac"
    world.standalone_run()  # old data + outside rotation
    assert world.turn().action == "adopted"  # new read/write
    adopted = json.loads(world.cleo.users.read_text())
    assert adopted["future_field"] == {"keep": [1, 2]}
    assert _codex_parse_users(world.cleo.users)["offline"]["username"] == OFFLINE
    world.cleo.users.unlink()
    world.machine.rotate()
    world.cleo.full_setup()  # old (Codex) writer replaces the file with its own schema
    assert _codex_parse_users(world.cleo.users)["online"]["username"] == ONLINE
    assert world.turn().action == "current"  # new read after the old writer


def test_state_keeps_unknown_fields_and_refuses_newer_versions(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.turn()
    state_path = coordinator.coordination_dir(world.cleo.path) / "state.json"
    state = json.loads(state_path.read_text())
    state["extension"] = "kept"
    state_path.write_text(json.dumps(state))
    world.machine.rotate()
    world.standalone.setup_path = "uac"
    world.standalone.full_setup()
    world.turn()
    assert json.loads(state_path.read_text())["extension"] == "kept"
    newer = json.dumps({"version": 99, "validated": {}}).encode()
    state_path.write_bytes(newer)
    result = reconcile(world.cleo.path, world.external, api=world.api)
    assert result.action == "deferred" and state_path.read_bytes() == newer
    state_path.write_bytes(b"{not json")
    world.machine.rotate()
    reconcile(world.cleo.path, world.external, api=world.api)
    corrupt = list(state_path.parent.glob("state.json.corrupt-*"))
    assert [path.read_bytes() for path in corrupt] == [b"{not json"]


def test_restore_rolls_back_to_a_backup(tmp_path):
    world = World(tmp_path)
    world.turn()
    world.standalone.setup_path = "uac"
    world.standalone_run()
    original = world.cleo.users.read_bytes()
    result = world.turn()
    assert result.action == "adopted"
    restored = restore(world.cleo.path, api=world.api)
    assert restored == result.backup
    assert world.cleo.users.read_bytes() == original
    history = json.loads((coordinator.coordination_dir(world.cleo.path) / "state.json")
                         .read_text())["history"]
    assert [entry["action"] for entry in history][-2:] == ["adopted", "restored"]


# Helpers and provider integration -----------------------------------------------------------


def test_dacl_check_requires_an_inherited_read_deny():
    group = "S-1-5-21-1-2-3-1010"
    assert dacl_denies_read(f"D:AI(D;OICI;0x1301bf;;;{group})(A;OICI;FA;;;SY)", group)
    assert dacl_denies_read(f"D:AI(D;OICIID;GA;;;{group})", group)
    assert not dacl_denies_read(f"D:AI(D;OICI;0x2;;;{group})", group)  # write-only deny
    assert not dacl_denies_read(f"D:AI(A;OICI;FA;;;{group})", group)
    assert not dacl_denies_read(f"D:AI(D;CI;FA;;;{group})", group)
    assert dacl_denies_read(f"D:AI(D;ID;0x1301bf;;;{group})", group, container=False)


def test_windows_sandbox_mode_prefers_last_override(tmp_path):
    (tmp_path / "config.toml").write_text('[windows]\nsandbox = "elevated"\n')
    assert windows_sandbox_mode(tmp_path, ()) == "elevated"
    assert windows_sandbox_mode(tmp_path, ('windows.sandbox="unelevated"',)) == "unelevated"
    assert windows_sandbox_mode(tmp_path, ('windows.sandbox="unelevated"', 'x=1',
                                           'windows.sandbox="elevated"')) == "elevated"
    assert windows_sandbox_mode(tmp_path / "missing", ()) is None


@pytest.mark.parametrize(("home", "legacy", "sandbox", "expected"), [
    ("C:/cleo/codex", False, "workspace-write", True),
    ("C:/cleo/codex", False, "read-only", True),
    ("C:/cleo/codex", True, "workspace-write", False),
    ("C:/cleo/codex", False, "full-access", False),
    (None, False, "workspace-write", False),
])
def test_provider_coordinates_before_sandboxed_turns(monkeypatch, home, legacy, sandbox,
                                                     expected):
    from cleo.integrations.harnesses.codex import CodexProvider

    calls = []
    monkeypatch.setattr(coordinator, "prepare_for_turn", lambda path: calls.append(path))
    client = SimpleNamespace(**({"_cleo_sandbox_credentials_home": Path(home)} if home else {}))
    runtime = SimpleNamespace(client=client, legacy_home=legacy,
                              options=SimpleNamespace(sandbox=sandbox))
    asyncio.run(CodexProvider._prepare_sandbox_credentials(runtime))
    assert calls == ([Path(home)] if expected else [])


def test_prepare_for_turn_never_raises(tmp_path, monkeypatch):
    class Broken(FakeApi):
        def account_flags(self, username):
            raise RuntimeError("boom")

    monkeypatch.setattr("cleo.integrations.harness_home.external_home", lambda _: tmp_path)
    home = tmp_path / "cleo"
    world = World(tmp_path)
    world.cleo.path = home
    world.turn()
    result = coordinator.prepare_for_turn(home, api=Broken(world.machine))
    assert result.action == "deferred" and "RuntimeError" in result.reason


@pytest.mark.parametrize(("platform", "saved", "legacy", "expected"), [
    ("win32", '[windows]\nsandbox = "elevated"\n', False, True),
    ("win32", "", False, False),  # Cleo's default is the unelevated sandbox
    ("win32", '[windows]\nsandbox = "elevated"\n', True, False),
    ("linux", '[windows]\nsandbox = "elevated"\n', False, False),
])
def test_client_marks_only_isolated_elevated_homes(tmp_path, monkeypatch, platform, saved,
                                                   legacy, expected):
    from cleo.integrations.harnesses.codex import CodexProvider

    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path)
    monkeypatch.setattr("cleo.integrations.codex_home.sys.platform", platform)
    monkeypatch.setattr("cleo.integrations.harnesses.codex.sys.platform", platform)
    home = tmp_path / "data" / "codex"
    home.mkdir(parents=True)
    (home / "config.toml").write_text(saved, encoding="utf-8")
    client = CodexProvider._client(legacy=legacy)
    marked = getattr(client, "_cleo_sandbox_credentials_home", None)
    assert (marked == home.resolve()) is expected
