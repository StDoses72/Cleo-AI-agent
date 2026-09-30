"""Reproduces the shared-account conflict with Codex's own decision rules (no coordinator)."""

import json

import pytest
from codex_sandbox_model import CodexHome, Machine, SetupFailure


def _homes(tmp_path):
    machine = Machine()
    standalone = CodexHome(machine, tmp_path / "standalone", "standalone", setup_path="service")
    cleo = CodexHome(machine, tmp_path / "cleo", "cleo", setup_path="uac")
    return machine, standalone, cleo


def test_alternating_use_rotates_passwords_on_every_switch(tmp_path):
    machine, standalone, cleo = _homes(tmp_path)
    standalone.run_command()  # first service setup succeeds and locks .sandbox-bin
    cleo.run_command()  # Cleo has no marker: its UAC setup rotates the shared passwords
    assert machine.rotations == 2

    # Standalone's saved password is now wrong. Its logon-failure refresh goes through the
    # LocalSystem service, which rotates first and then cannot reopen the locked bin dir.
    with pytest.raises(SetupFailure, match="helper_sandbox_lock_failed"):
        standalone.run_command()
    assert machine.rotations == 3
    assert standalone.marker.read_bytes() == b""  # the observed 0-byte setup_marker.json

    # Each further standalone attempt rotates again; Cleo then finds its password invalid,
    # deletes its own users file and re-runs setup (another rotation, with a UAC prompt).
    with pytest.raises(SetupFailure, match="helper_sandbox_lock_failed"):
        standalone.run_command()
    cleo.run_command()
    assert machine.rotations == 5
    assert cleo.full_setups == 2
    assert standalone.setup_errors == ["helper_sandbox_lock_failed"] * 2


def test_cli_reinitialization_recovers_until_cleo_uses_the_sandbox_again(tmp_path):
    machine, standalone, cleo = _homes(tmp_path)
    standalone.run_command()
    cleo.run_command()
    with pytest.raises(SetupFailure):
        standalone.run_command()
    # The official CLI re-initialization uses the UAC helper, which runs as the user.
    standalone.setup_path = "uac"
    standalone.full_setup()
    standalone.setup_path = "service"
    standalone.run_command()
    assert json.loads(standalone.marker.read_text())["version"] == 5
    rotations = machine.rotations

    cleo.run_command()  # Cleo's stored password is stale: refresh + rotation
    assert machine.rotations == rotations + 1
    with pytest.raises(SetupFailure, match="helper_sandbox_lock_failed"):
        standalone.run_command()  # the reported recurrence
