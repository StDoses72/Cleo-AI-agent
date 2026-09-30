"""Behavioral model of Codex 0.157.1 Windows sandbox account handling, for tests only.

The model ports the decisions of ``codex-rs/windows-sandbox-rs`` that matter when two
``CODEX_HOME`` directories share the fixed ``CodexSandboxOffline``/``CodexSandboxOnline``
accounts (identical in 0.157.1 and 0.158.0-alpha.2.1):

- ``identity.rs::require_sandbox_account_with_setup``: marker and users files are read on
  every command; a missing/incompatible file triggers full setup.
- ``elevated_impl.rs`` + ``identity.rs::refresh_logon_sandbox_creds``: a logon failure
  deletes this home's users file and runs full setup.
- ``setup_provisioning.rs::run_setup`` / ``run_provision_only``: the marker is recreated
  empty first, both passwords are rotated and written, then ``.sandbox-bin`` is locked, and
  only then is the marker committed.
- The LocalSystem service path (ProvisionOnly) cannot reopen an already locked
  ``.sandbox-bin`` because its protected DACL grants SYSTEM no WRITE_DAC, so it fails with
  ``helper_sandbox_lock_failed`` after the rotation. The UAC helper runs as the user and
  succeeds; a cancelled UAC prompt fails before anything changes.

Files use Codex's exact JSON formats, so Cleo's coordinator reads and writes real files.
"""

from __future__ import annotations

import base64
import json
import secrets
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from cleo.integrations.codex_sandbox_credentials import CoordinatorBusy

OFFLINE, ONLINE = "CodexSandboxOffline", "CodexSandboxOnline"
ROLE_USER = {"offline": OFFLINE, "online": ONLINE}
SETUP_VERSION = 5


class SetupFailure(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code


@dataclass
class Machine:
    """Shared Windows state: two local accounts, their passwords and the setup mutex."""

    passwords: dict[str, str] = field(default_factory=dict)
    password_set_at: dict[str, float] = field(default_factory=dict)
    flags: dict[str, int] = field(default_factory=dict)
    clock: float = 1_000_000.0
    rotations: int = 0
    logons: list[tuple[str, bool]] = field(default_factory=list)
    lock_holder: str | None = None
    uac_cancel: bool = False

    def tick(self, seconds: float = 10.0) -> None:
        self.clock += seconds

    def rotate(self) -> dict[str, str]:
        self.rotations += 1
        self.tick()
        new = {}
        for user in (OFFLINE, ONLINE):
            new[user] = secrets.token_urlsafe(18)
            self.passwords[user] = new[user]
            self.password_set_at[user] = self.clock
            self.flags.setdefault(user, 0)
        return new

    def logon(self, user: str, password: str) -> int:
        ok = user in self.passwords and self.passwords[user] == password
        self.logons.append((user, ok))
        if user not in self.passwords:
            return 1326
        if self.flags.get(user, 0) & 0x2:
            return 1331
        return 0 if ok else 1326

    @contextmanager
    def setup_lock(self, owner: str):
        if self.lock_holder is not None:
            raise CoordinatorBusy(f"setup lock held by {self.lock_holder}")
        self.lock_holder = owner
        try:
            yield
        finally:
            self.lock_holder = None


def protect(password: str) -> str:
    """Stand-in for machine-scope DPAPI: reversible only by ``FakeApi.unprotect``."""
    return base64.b64encode(b"DPAPI\x00" + password.encode()).decode()


class CodexHome:
    """One ``CODEX_HOME`` and the Codex runtime that uses it."""

    def __init__(self, machine: Machine, path: Path, name: str, setup_path: str):
        self.machine, self.path, self.name, self.setup_path = machine, path, name, setup_path
        self.bin_locked = False
        self.setup_errors: list[str] = []
        self.full_setups = 0

    @property
    def marker(self) -> Path:
        return self.path / ".sandbox" / "setup_marker.json"

    @property
    def users(self) -> Path:
        return self.path / ".sandbox-secrets" / "sandbox_users.json"

    def _load(self, path: Path):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) and value.get("version") == SETUP_VERSION else None

    def _select(self, role: str) -> str | None:
        if self._load(self.marker) is None:
            return None
        users = self._load(self.users)
        if users is None:
            return None
        record = users[role]
        blob = base64.b64decode(record["password"])
        if not blob.startswith(b"DPAPI\x00"):
            raise SetupFailure("dpapi_unprotect_failed")
        return blob[len(b"DPAPI\x00"):].decode()

    def full_setup(self) -> None:
        """Codex full setup through this home's path (service ProvisionOnly or UAC helper)."""
        self.full_setups += 1
        if self.setup_path == "uac" and self.machine.uac_cancel:
            self.setup_errors.append("orchestrator_helper_launch_canceled")
            raise SetupFailure("orchestrator_helper_launch_canceled")
        with self.machine.setup_lock(self.name):
            self.marker.parent.mkdir(parents=True, exist_ok=True)
            self.marker.unlink(missing_ok=True)
            self.marker.write_bytes(b"")  # prepare_setup_marker: empty until commit
            new = self.machine.rotate()
            self.users.parent.mkdir(parents=True, exist_ok=True)
            self.users.write_text(json.dumps({
                "version": SETUP_VERSION,
                "offline": {"username": OFFLINE, "password": protect(new[OFFLINE])},
                "online": {"username": ONLINE, "password": protect(new[ONLINE])},
            }, indent=2), encoding="utf-8")
            if self.setup_path == "service" and self.bin_locked:
                code = "helper_sandbox_lock_failed"
                self.setup_errors.append(code)
                raise SetupFailure(code, f"lock sandbox bin dir {self.path / '.sandbox-bin'}")
            self.bin_locked = True
            self.marker.write_text(json.dumps({
                "version": SETUP_VERSION, "offline_username": OFFLINE,
                "online_username": ONLINE, "created_at": str(self.machine.clock),
                "proxy_ports": [], "allow_local_binding": False,
                "read_roots": [], "write_roots": [],
            }, indent=2), encoding="utf-8")

    def run_command(self, role: str = "offline") -> None:
        """One sandboxed command, including Codex's logon-failure refresh."""
        user = ROLE_USER[role]
        password = self._select(role)
        if password is None or self.machine.flags.get(user, 0) & 0x2:
            self.full_setup()
            password = self._select(role)
        if self.machine.logon(user, password or "") == 0:
            return
        # refresh_logon_sandbox_creds: delete users file, then require (full setup) again.
        self.users.unlink(missing_ok=True)
        self.full_setup()
        password = self._select(role)
        if self.machine.logon(user, password or "") != 0:
            raise SetupFailure("logon_failed_after_setup")


class FakeApi:
    """Coordinator platform API backed by :class:`Machine` (no real Windows calls)."""

    def __init__(self, machine: Machine, *, protected: bool = True):
        self.machine = machine
        self.protected = protected
        self.unprotect_calls = 0

    def unprotect(self, blob: bytes) -> bytes:
        self.unprotect_calls += 1
        if not blob.startswith(b"DPAPI\x00"):
            raise OSError(13, "CryptUnprotectData failed: 13")
        return blob[len(b"DPAPI\x00"):]

    def logon(self, username: str, password: str) -> int:
        return self.machine.logon(username, password)

    def password_last_set(self, username: str) -> float | None:
        return self.machine.password_set_at.get(username)

    def account_flags(self, username: str) -> int | None:
        return self.machine.flags.get(username) if username in self.machine.passwords else None

    @contextmanager
    def setup_lock(self, timeout: float):
        with self.machine.setup_lock("cleo-coordinator"):
            yield

    def secrets_dir_protected(self, path: Path) -> bool:
        return self.protected and path.is_dir()

    def file_protected(self, path: Path) -> bool:
        return self.protected and path.is_file()

    def is_reparse_point(self, path: Path) -> bool:
        return path.is_symlink()
