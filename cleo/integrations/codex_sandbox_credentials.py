"""Coordinate Cleo's copy of the shared Windows sandbox account credentials.

Codex's elevated Windows sandbox uses two fixed local accounts, ``CodexSandboxOffline`` and
``CodexSandboxOnline``, for every ``CODEX_HOME`` on the machine. Each home stores its own
DPAPI-protected copy of their passwords in ``.sandbox-secrets/sandbox_users.json``. Full
setup always sets new random passwords, and a logon failure makes Codex delete that file and
run full setup. When Cleo and a standalone Codex Desktop both use the sandbox, each setup
invalidates the other home's copy, so the two keep resetting the shared accounts.

Cleo's home stays separate (chats, config, plugins, capability SIDs, workspace ACLs and
setup marker are untouched). Only the password records are coordinated, one way:

- The accounts' current passwords are the single authority. A stored record is trusted only
  after ``LogonUserW`` accepts it; nothing is inferred from a missing setup record.
- Before a turn, Cleo re-checks its own records. If they no longer log on and the standalone
  Codex home holds records that do, Cleo adopts those encrypted records into its own users
  file. Cleo never writes the other home, never changes accounts, ACLs, firewall or marker,
  and never starts setup; when no valid record exists, Codex's own setup runs as before.
- The re-read, validation and commit run inside Codex's machine-wide
  ``Global\\CodexSandboxSetup`` mutex (created with Codex's own DACL when absent), so no
  Codex setup can rotate the passwords in between. If a setup holds it, Cleo defers.
- Secrets stay inside Cleo's ``.sandbox-secrets``, whose inherited DENY entry keeps sandboxed
  processes from reading them; Cleo refuses to write if that entry is missing. Passwords are
  decrypted only in memory for the logon check and are never logged or persisted in plaintext.
- Known-invalid records are remembered by ciphertext fingerprint, so each stale record costs
  at most one failed logon (the machine's lockout policy counts failed logons).

Additive state lives in ``.sandbox-secrets/cleo-coordination``: ``state.json`` (validation
cache and history) and ``backups/`` (previous users files, restorable with ``restore``).
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

SETUP_VERSION = 5
ROLES = {"offline": "CodexSandboxOffline", "online": "CodexSandboxOnline"}
SANDBOX_GROUP = "CodexSandboxUsers"
COORDINATION_DIR = "cleo-coordination"
STATE_VERSION = 1
MAX_KNOWN_INVALID = 64
MAX_HISTORY = 20
MAX_BACKUPS = 10
# Account password timestamps are derived from a whole-second age; allow small drift.
PASSWORD_TIME_TOLERANCE = 3.0

UF_ACCOUNTDISABLE = 0x0002
UF_LOCKOUT = 0x0010
UF_PASSWORD_EXPIRED = 0x800000

LOGON_RESULTS = {
    0: "valid",
    1326: "password_invalid",  # ERROR_LOGON_FAILURE
    1909: "account_locked",  # ERROR_ACCOUNT_LOCKED_OUT
    1331: "account_disabled",  # ERROR_ACCOUNT_DISABLED
    1330: "password_expired",  # ERROR_PASSWORD_EXPIRED
    1907: "password_expired",  # ERROR_PASSWORD_MUST_CHANGE
    1385: "logon_type_denied",  # ERROR_LOGON_TYPE_NOT_GRANTED
    1327: "account_restricted",  # ERROR_ACCOUNT_RESTRICTION
}
# A given encrypted record can never become valid again once these are observed.
PERMANENT_FAILURES = {"password_invalid", "dpapi_failed", "record_invalid"}

# Codex setup error codes (setup_error.rs) mapped to user-facing categories.
SETUP_ERROR_CATEGORIES = {
    "orchestrator_helper_launch_canceled": "uac_canceled",
    "orchestrator_elevation_required": "elevation_required",
    "helper_sandbox_lock_failed": "sandbox_directory_lock_failed",
    "helper_sandbox_dir_create_failed": "sandbox_directory_access_failed",
    "orchestrator_sandbox_dir_create_failed": "sandbox_directory_access_failed",
    "helper_dpapi_protect_failed": "dpapi_failed",
    "helper_users_file_write_failed": "credential_store_write_failed",
    "helper_setup_marker_write_failed": "setup_marker_write_failed",
    "helper_user_create_or_update_failed": "account_update_failed",
    "helper_user_provision_failed": "account_update_failed",
}


class CoordinatorBusy(RuntimeError):
    """A lock could not be acquired in time; nothing was changed."""


class CredentialApi(Protocol):
    """Platform operations; the Windows implementation is :class:`Win32CredentialApi`."""

    def unprotect(self, blob: bytes) -> bytes: ...

    def logon(self, username: str, password: str) -> int: ...

    def password_last_set(self, username: str) -> float | None: ...

    def account_flags(self, username: str) -> int | None: ...

    def setup_lock(self, timeout: float) -> contextlib.AbstractContextManager[None]: ...

    def secrets_dir_protected(self, path: Path) -> bool: ...

    def file_protected(self, path: Path) -> bool: ...

    def is_reparse_point(self, path: Path) -> bool: ...


@dataclass
class StoreCheck:
    """Validation result for one users file; never contains secrets."""

    # missing | busy | unreadable | corrupt | incompatible | newer | checked | reparse_point
    state: str
    accounts: dict[str, str] = field(default_factory=dict)
    fingerprint: str | None = None

    def valid(self, role: str) -> bool:
        return self.accounts.get(role) == "valid"

    @property
    def all_valid(self) -> bool:
        return self.state == "checked" and all(self.valid(role) for role in ROLES)


@dataclass
class ReconcileResult:
    action: str  # skipped | current | adopted | no_valid_source | deferred
    reason: str
    cleo: StoreCheck | None = None
    external: StoreCheck | None = None
    adopted_roles: list[str] = field(default_factory=list)
    backup: str | None = None
    external_setup: dict[str, Any] = field(default_factory=dict)
    cleo_setup_error: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --- paths --------------------------------------------------------------------------------


def users_path(home: Path) -> Path:
    return home / ".sandbox-secrets" / "sandbox_users.json"


def marker_path(home: Path) -> Path:
    return home / ".sandbox" / "setup_marker.json"


def setup_error_path(home: Path) -> Path:
    return home / ".sandbox" / "setup_error.json"


def coordination_dir(home: Path) -> Path:
    return home / ".sandbox-secrets" / COORDINATION_DIR


# --- file reading -------------------------------------------------------------------------


def _read_bytes(path: Path) -> tuple[str, bytes | None]:
    try:
        return "ok", path.read_bytes()
    except FileNotFoundError:
        return "missing", None
    except PermissionError as error:
        # ERROR_SHARING_VIOLATION (32) / ERROR_LOCK_VIOLATION (33): another writer holds it.
        busy = getattr(error, "winerror", None) in (32, 33)
        return ("busy" if busy else "unreadable"), None
    except OSError:
        return "unreadable", None


def _json_object(data: bytes | None) -> dict[str, Any] | None:
    if not data:
        return None
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def marker_status(home: Path) -> str:
    """Return ``valid``, ``missing``, ``empty``, ``corrupt``, ``incompatible`` or a read error."""
    status, data = _read_bytes(marker_path(home))
    if status != "ok":
        return status
    if not data:
        return "empty"
    marker = _json_object(data)
    if marker is None:
        return "corrupt"
    if (
        marker.get("version") != SETUP_VERSION
        or str(marker.get("offline_username", "")).lower() != ROLES["offline"].lower()
        or str(marker.get("online_username", "")).lower() != ROLES["online"].lower()
    ):
        return "incompatible"
    return "valid"


def read_setup_error(home: Path) -> dict[str, Any] | None:
    """Codex's last setup error report for a home, mapped to a category (no secrets)."""
    status, data = _read_bytes(setup_error_path(home))
    report = _json_object(data) if status == "ok" else None
    if report is None:
        return None
    code = str(report.get("code") or "")
    return {"code": code, "category": SETUP_ERROR_CATEGORIES.get(code, "setup_failed")}


def _record_key(role: str, record: dict[str, Any]) -> str:
    material = f"{role}\0{record.get('username', '')}\0{record.get('password', '')}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


def _users_document(data: bytes | None) -> tuple[str, dict[str, Any] | None]:
    document = _json_object(data)
    if document is None:
        return "corrupt", None
    version = document.get("version")
    if isinstance(version, int) and not isinstance(version, bool) and version > SETUP_VERSION:
        return "newer", None  # written by a newer Codex: never overwrite
    if version != SETUP_VERSION:
        return "incompatible", None
    for role, username in ROLES.items():
        record = document.get(role)
        if (
            not isinstance(record, dict)
            or not isinstance(record.get("password"), str)
            or str(record.get("username", "")).lower() != username.lower()
        ):
            return "incompatible", None
    return "checked", document


# --- core ---------------------------------------------------------------------------------


class _Validator:
    """Checks records with at most one logon per record and none after a lockout."""

    def __init__(self, api: CredentialApi, state: dict[str, Any], now: float):
        self.api, self.state, self.now = api, state, now
        self.locked: set[str] = set()

    def check_record(self, role: str, record: dict[str, Any]) -> str:
        known = self.state.setdefault("known_invalid", {}).get(_record_key(role, record))
        if isinstance(known, dict):
            return str(known.get("result", "password_invalid"))
        username = ROLES[role]
        if username in self.locked:
            return "account_locked"
        try:
            blob = base64.b64decode(record["password"].encode("ascii"), validate=True)
        except (binascii.Error, UnicodeEncodeError, ValueError):
            return self._remember(role, record, "record_invalid")
        try:
            decrypted = bytearray(self.api.unprotect(blob))
        except OSError:
            return self._remember(role, record, "dpapi_failed")
        try:
            try:
                password = decrypted.decode("utf-8")
            except UnicodeDecodeError:
                return self._remember(role, record, "record_invalid")
            code = self.api.logon(username, password)
            del password
        finally:
            decrypted[:] = b"\0" * len(decrypted)
        result = LOGON_RESULTS.get(code, f"logon_error_{code}")
        if result == "account_locked":
            self.locked.add(username)
        if result in PERMANENT_FAILURES:
            self._remember(role, record, result)
        return result

    def _remember(self, role: str, record: dict[str, Any], result: str) -> str:
        known = self.state.setdefault("known_invalid", {})
        known[_record_key(role, record)] = {"result": result, "at": self.now}
        while len(known) > MAX_KNOWN_INVALID:
            oldest = min(known, key=lambda key: known[key].get("at", 0))
            known.pop(oldest)
        return result

    def check_store(self, path: Path) -> tuple[StoreCheck, dict[str, Any] | None]:
        if self.api.is_reparse_point(path) or self.api.is_reparse_point(path.parent):
            return StoreCheck("reparse_point"), None
        status, data = _read_bytes(path)
        if status != "ok":
            return StoreCheck(status), None
        fingerprint = hashlib.sha256(data or b"").hexdigest()
        state, document = _users_document(data)
        if document is None:
            return StoreCheck(state, fingerprint=fingerprint), None
        accounts = {role: self.check_record(role, document[role]) for role in ROLES}
        return StoreCheck("checked", accounts, fingerprint), document


def _password_times(api: CredentialApi) -> dict[str, float | None]:
    times = {}
    for role, username in ROLES.items():
        try:
            times[role] = api.password_last_set(username)
        except OSError:
            times[role] = None
    return times


def _times_match(recorded: Any, current: dict[str, float | None]) -> bool:
    if not isinstance(recorded, dict):
        return False
    for role in ROLES:
        value, now = recorded.get(role), current.get(role)
        if not isinstance(value, (int, float)) or now is None:
            return False
        if abs(float(value) - now) > PASSWORD_TIME_TOLERANCE:
            return False
    return True


def _accounts_need_codex_repair(api: CredentialApi) -> str | None:
    """Codex itself runs full setup for these; adopting records cannot help."""
    for username in ROLES.values():
        try:
            flags = api.account_flags(username)
        except OSError:
            continue
        if flags is None:
            return f"{username} is missing"
        if flags & UF_ACCOUNTDISABLE:
            return f"{username} is disabled"
        if flags & UF_PASSWORD_EXPIRED:
            return f"{username} password expired"
    return None


def _account_locked_out(api: CredentialApi) -> bool:
    for username in ROLES.values():
        with contextlib.suppress(OSError):
            if (api.account_flags(username) or 0) & UF_LOCKOUT:
                return True
    return False


def _load_state(directory: Path, now: float) -> dict[str, Any]:
    path = directory / "state.json"
    status, data = _read_bytes(path)
    if status == "missing":
        return {"version": STATE_VERSION}
    if status != "ok":
        raise CoordinatorBusy(f"coordination state is {status}")
    state = _json_object(data)
    if state is None or not isinstance(state.get("version"), int):
        # Keep corrupt state for inspection instead of overwriting it silently.
        path.replace(directory / f"state.json.corrupt-{int(now)}-{uuid.uuid4().hex[:6]}")
        return {"version": STATE_VERSION}
    if state["version"] > STATE_VERSION:
        raise CoordinatorBusy("coordination state was written by a newer Cleo")
    return state


def _write_atomic(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.cleo-{uuid.uuid4().hex}.tmp")
    try:
        with open(temporary, "xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                # A reader may hold the file briefly without delete sharing.
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        with contextlib.suppress(OSError):
            temporary.unlink()


def _save_state(directory: Path, state: dict[str, Any]) -> None:
    state["version"] = max(int(state.get("version") or 0), STATE_VERSION)
    _write_atomic(directory / "state.json",
                  json.dumps(state, indent=2, sort_keys=True).encode("utf-8"))


def _cleanup_stale_temporaries(directory: Path) -> None:
    for pattern in (".sandbox_users.json.cleo-*.tmp", ".state.json.cleo-*.tmp"):
        for path in directory.glob(pattern):
            with contextlib.suppress(OSError):
                path.unlink()


def _backup(directory: Path, data: bytes, now: float) -> str:
    backups = directory / "backups"
    backups.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now))
    target = backups / f"sandbox_users.{stamp}.{uuid.uuid4().hex[:8]}.json"
    _write_atomic(target, data)
    existing = sorted(backups.glob("sandbox_users.*.json"), key=lambda p: p.stat().st_mtime)
    for old in existing[:-MAX_BACKUPS]:
        with contextlib.suppress(OSError):
            old.unlink()
    return str(target.relative_to(directory))


@contextlib.contextmanager
def _file_lock(directory: Path, timeout: float) -> Iterator[None]:
    """Serializes Cleo processes; the OS drops the lock if a process dies."""
    path = directory / "lock"
    handle = open(path, "a+b")
    deadline = time.monotonic() + timeout
    try:
        if sys.platform == "win32":
            import msvcrt

            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise CoordinatorBusy("another Cleo process is coordinating") from None
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                with contextlib.suppress(OSError):
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise CoordinatorBusy("another Cleo process is coordinating") from None
                    time.sleep(0.05)
            yield
    finally:
        handle.close()


def _history(state: dict[str, Any], entry: dict[str, Any]) -> None:
    history = state.setdefault("history", [])
    history.append(entry)
    del history[:-MAX_HISTORY]


def _external_setup(home: Path) -> dict[str, Any]:
    info: dict[str, Any] = {"marker": marker_status(home)}
    error = read_setup_error(home)
    if error:
        info["error"] = error
    return info


def reconcile(
    cleo_home: Path,
    external_home: Path | None,
    *,
    api: CredentialApi,
    lock_timeout: float = 3.0,
    now: float | None = None,
) -> ReconcileResult:
    """Purpose: Make Cleo's users file hold working credentials without resetting accounts.

    Input: Cleo's isolated ``CODEX_HOME``, the standalone Codex home (read-only source),
    the platform API and a lock timeout in seconds.
    Output: What happened; only Cleo's users file and coordination state may change.
    """
    now = time.time() if now is None else now
    cleo_home = Path(cleo_home)
    if external_home is not None:
        external_home = Path(external_home)
        with contextlib.suppress(OSError):
            if external_home.resolve() == cleo_home.resolve():
                external_home = None
    cleo_error = read_setup_error(cleo_home)
    marker = marker_status(cleo_home)
    if marker != "valid":
        # Codex will run its own setup; never fake or repair its marker.
        return ReconcileResult("skipped", f"cleo_setup_marker_{marker}",
                               cleo_setup_error=cleo_error)
    secrets_dir = users_path(cleo_home).parent
    if api.is_reparse_point(secrets_dir) or not api.secrets_dir_protected(secrets_dir):
        return ReconcileResult("skipped", "cleo_secrets_dir_unprotected",
                               cleo_setup_error=cleo_error)
    repair = _accounts_need_codex_repair(api)
    if repair:
        return ReconcileResult("skipped", f"accounts_need_codex_setup: {repair}",
                               cleo_setup_error=cleo_error)
    if _account_locked_out(api):
        # Every logon attempt would extend the lockout; retry on a later turn.
        return ReconcileResult("deferred", "account_locked_out", cleo_setup_error=cleo_error)
    directory = coordination_dir(cleo_home)
    try:
        directory.mkdir(exist_ok=True)
        with _file_lock(directory, lock_timeout):
            _cleanup_stale_temporaries(secrets_dir)
            _cleanup_stale_temporaries(directory)
            state = _load_state(directory, now)
            result = _reconcile_locked(cleo_home, external_home, api, state, directory,
                                       lock_timeout, now)
            result.cleo_setup_error = cleo_error
            return result
    except CoordinatorBusy as error:
        return ReconcileResult("deferred", str(error), cleo_setup_error=cleo_error)
    except OSError as error:
        return ReconcileResult("deferred", f"coordination_io_error: {error.strerror or error}",
                               cleo_setup_error=cleo_error)


def _reconcile_locked(cleo_home, external_home, api, state, directory, lock_timeout, now):
    target = users_path(cleo_home)
    times = _password_times(api)
    status, current = _read_bytes(target)
    fingerprint = hashlib.sha256(current).hexdigest() if status == "ok" and current else None
    validated = state.get("validated")
    if (
        fingerprint
        and isinstance(validated, dict)
        and validated.get("fingerprint") == fingerprint
        and _times_match(validated.get("password_last_set"), times)
    ):
        # Same records and no password change since they last logged on.
        return ReconcileResult("current", "unchanged_since_validation")

    with api.setup_lock(lock_timeout):
        # Codex setup cannot change the passwords while this lock is held.
        times = _password_times(api)
        validator = _Validator(api, state, now)
        cleo, cleo_doc = validator.check_store(target)
        if cleo.all_valid:
            state["validated"] = {"fingerprint": cleo.fingerprint, "password_last_set": times,
                                  "at": now}
            _save_state(directory, state)
            return ReconcileResult("current", "cleo_credentials_valid", cleo=cleo)
        if cleo.state in {"busy", "unreadable", "reparse_point", "newer"}:
            _save_state(directory, state)
            return ReconcileResult("deferred", f"cleo_store_{cleo.state}", cleo=cleo)
        external = None
        external_doc = None
        if external_home is not None:
            external, external_doc = validator.check_store(users_path(external_home))
        external_setup = _external_setup(external_home) if external_home is not None else {}
        roles = [
            role for role in ROLES
            if not cleo.valid(role) and external is not None and external.valid(role)
        ]
        if not roles:
            state.pop("validated", None)
            _save_state(directory, state)
            return ReconcileResult("no_valid_source", "no_working_credentials_found",
                                   cleo=cleo, external=external, external_setup=external_setup)
        # Keep Cleo's document (and any fields Codex may add later) when it is readable.
        merged = dict(cleo_doc) if cleo_doc is not None else {"version": SETUP_VERSION}
        for role in ROLES:
            if role in roles:
                merged[role] = dict(external_doc[role])
            elif cleo_doc is None:
                merged[role] = dict(external_doc[role])
        merged["version"] = SETUP_VERSION
        backup = _backup(directory, current, now) if status == "ok" and current else None
        data = json.dumps(merged, indent=2).encode("utf-8")
        _write_atomic(target, data)
        if not api.file_protected(target):
            # Never leave working secrets readable by sandboxed processes.
            target.unlink(missing_ok=True)
            _history(state, {"at": now, "action": "removed_unprotected", "backup": backup})
            _save_state(directory, state)
            return ReconcileResult("deferred", "written_file_unprotected", cleo=cleo,
                                   external=external, backup=backup)
        if hashlib.sha256(target.read_bytes()).hexdigest() != hashlib.sha256(data).hexdigest():
            raise CoordinatorBusy("users file changed during commit")
        all_valid = all(cleo.valid(role) or role in roles for role in ROLES)
        if all_valid:
            state["validated"] = {"fingerprint": hashlib.sha256(data).hexdigest(),
                                  "password_last_set": times, "at": now}
        else:
            state.pop("validated", None)
        _history(state, {"at": now, "action": "adopted", "roles": roles,
                         "source": "standalone_codex", "backup": backup,
                         "previous": cleo.state if cleo.state != "checked" else cleo.accounts})
        _save_state(directory, state)
        return ReconcileResult("adopted", "standalone_credentials_valid", cleo=cleo,
                               external=external, adopted_roles=roles, backup=backup,
                               external_setup=external_setup)


def restore(cleo_home: Path, backup: str | None = None, *, lock_timeout: float = 10.0,
            api: CredentialApi | None = None) -> str:
    """Purpose: Roll Cleo's users file back to a coordinator backup.

    Input: Cleo's ``CODEX_HOME`` and a backup name (latest when omitted).
    Output: The restored backup's relative path; the replaced file is backed up first.
    """
    api = api or Win32CredentialApi()
    directory = coordination_dir(Path(cleo_home))
    backups = sorted((directory / "backups").glob("sandbox_users.*.json"),
                     key=lambda p: p.stat().st_mtime)
    if backup:
        chosen = directory / "backups" / Path(backup).name
        if not chosen.is_file():
            raise FileNotFoundError(backup)
    elif backups:
        chosen = backups[-1]
    else:
        raise FileNotFoundError("no coordinator backups")
    target = users_path(Path(cleo_home))
    with _file_lock(directory, lock_timeout), api.setup_lock(lock_timeout):
        now = time.time()
        state = _load_state(directory, now)
        data = chosen.read_bytes()
        status, current = _read_bytes(target)
        replaced = _backup(directory, current, now) if status == "ok" and current else None
        _write_atomic(target, data)
        state.pop("validated", None)
        _history(state, {"at": now, "action": "restored",
                         "backup": str(chosen.relative_to(directory)), "replaced": replaced})
        _save_state(directory, state)
    return str(chosen.relative_to(directory))


# --- Windows implementation ---------------------------------------------------------------


class Win32CredentialApi:
    """Real Windows calls (ctypes); every method avoids exposing secrets."""

    MUTEX_NAME = "Global\\CodexSandboxSetup"
    # Same DACL Codex's setup_mutex.rs uses, so elevated helpers and the service can open it.
    MUTEX_SDDL = "D:P(A;;GA;;;SY)(A;;GA;;;BA)"

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self.ctypes, self.wintypes = ctypes, wintypes
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        self.crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        self.netapi32 = ctypes.WinDLL("netapi32")
        self.kernel32.CreateMutexW.restype = wintypes.HANDLE
        self.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
        self.kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel32.WaitForSingleObject.restype = wintypes.DWORD

    def _blob_type(self):
        ctypes, wintypes = self.ctypes, self.wintypes

        class DataBlob(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

        return DataBlob

    def unprotect(self, blob: bytes) -> bytes:
        ctypes = self.ctypes
        DataBlob = self._blob_type()
        buffer = ctypes.create_string_buffer(blob, len(blob))
        source = DataBlob(len(blob), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
        output = DataBlob()
        # CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE, as in Codex's dpapi.rs.
        if not self.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None,
                                               0x1 | 0x4, ctypes.byref(output)):
            error = ctypes.get_last_error()
            raise OSError(error, f"CryptUnprotectData failed: {error}")
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            ctypes.memset(output.pbData, 0, output.cbData)
            self.kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))

    def logon(self, username: str, password: str) -> int:
        ctypes, wintypes = self.ctypes, self.wintypes
        secret = ctypes.create_unicode_buffer(password)
        token = wintypes.HANDLE()
        try:
            # LOGON32_LOGON_INTERACTIVE / LOGON32_PROVIDER_DEFAULT, like Codex's runner.
            ok = self.advapi32.LogonUserW(username, ".", secret, 2, 0, ctypes.byref(token))
            error = 0 if ok else ctypes.get_last_error()
        finally:
            ctypes.memset(secret, 0, ctypes.sizeof(secret))
        if ok:
            self.kernel32.CloseHandle(token)
        return error

    def _user_info_1(self, username: str):
        ctypes, wintypes = self.ctypes, self.wintypes

        class UserInfo1(ctypes.Structure):
            _fields_ = [
                ("name", wintypes.LPWSTR), ("password", wintypes.LPWSTR),
                ("password_age", wintypes.DWORD), ("priv", wintypes.DWORD),
                ("home_dir", wintypes.LPWSTR), ("comment", wintypes.LPWSTR),
                ("flags", wintypes.DWORD), ("script_path", wintypes.LPWSTR),
            ]

        pointer = ctypes.c_void_p()
        status = self.netapi32.NetUserGetInfo(None, username, 1, ctypes.byref(pointer))
        if status == 2221:  # NERR_UserNotFound
            return None
        if status != 0:
            raise OSError(status, f"NetUserGetInfo failed: {status}")
        try:
            info = ctypes.cast(pointer, ctypes.POINTER(UserInfo1)).contents
            return int(info.password_age), int(info.flags)
        finally:
            self.netapi32.NetApiBufferFree(pointer)

    def password_last_set(self, username: str) -> float | None:
        info = self._user_info_1(username)
        return None if info is None else round(time.time() - info[0])

    def account_flags(self, username: str) -> int | None:
        info = self._user_info_1(username)
        return None if info is None else info[1]

    @contextlib.contextmanager
    def setup_lock(self, timeout: float) -> Iterator[None]:
        ctypes, wintypes = self.ctypes, self.wintypes

        class SecurityAttributes(ctypes.Structure):
            _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                        ("bInheritHandle", wintypes.BOOL)]

        descriptor = ctypes.c_void_p()
        if not self.advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                self.MUTEX_SDDL, 1, ctypes.byref(descriptor), None):
            raise OSError(ctypes.get_last_error(), "create setup mutex security")
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        deadline = time.monotonic() + timeout
        handle = None
        try:
            while True:
                handle = self.kernel32.CreateMutexW(ctypes.byref(attributes), True,
                                                    self.MUTEX_NAME)
                error = ctypes.get_last_error()
                if handle and error != 183:  # created and owned
                    break
                if handle:  # ERROR_ALREADY_EXISTS but accessible: wait for ownership
                    remaining = max(0, int((deadline - time.monotonic()) * 1000))
                    wait = self.kernel32.WaitForSingleObject(handle, remaining)
                    if wait in (0, 0x80):  # WAIT_OBJECT_0 / WAIT_ABANDONED
                        break
                    self.kernel32.CloseHandle(handle)
                    handle = None
                    raise CoordinatorBusy("Codex sandbox setup is in progress")
                if error != 5:  # not ERROR_ACCESS_DENIED
                    raise OSError(error, f"open Codex setup mutex failed: {error}")
                # A Codex setup holds the mutex; its DACL does not let Cleo wait on it.
                if time.monotonic() >= deadline:
                    raise CoordinatorBusy("Codex sandbox setup is in progress")
                time.sleep(0.1)
        finally:
            self.kernel32.LocalFree(descriptor)
        try:
            yield
        finally:
            self.kernel32.ReleaseMutex(handle)
            self.kernel32.CloseHandle(handle)

    def _sandbox_group_sid(self) -> str | None:
        ctypes, wintypes = self.ctypes, self.wintypes
        sid_size, domain_size, use = wintypes.DWORD(0), wintypes.DWORD(0), wintypes.DWORD()
        self.advapi32.LookupAccountNameW(None, SANDBOX_GROUP, None, ctypes.byref(sid_size),
                                         None, ctypes.byref(domain_size), ctypes.byref(use))
        if not sid_size.value:
            return None
        sid = ctypes.create_string_buffer(sid_size.value)
        domain = ctypes.create_unicode_buffer(domain_size.value)
        if not self.advapi32.LookupAccountNameW(None, SANDBOX_GROUP, sid, ctypes.byref(sid_size),
                                                domain, ctypes.byref(domain_size),
                                                ctypes.byref(use)):
            return None
        text = ctypes.c_wchar_p()
        if not self.advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            return None
        try:
            return text.value
        finally:
            self.kernel32.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    def dacl_sddl(self, path: Path) -> str:
        ctypes = self.ctypes
        descriptor = ctypes.c_void_p()
        # SE_FILE_OBJECT, DACL_SECURITY_INFORMATION
        status = self.advapi32.GetNamedSecurityInfoW(str(path), 1, 0x4, None, None, None, None,
                                                     ctypes.byref(descriptor))
        if status != 0:
            raise OSError(status, f"GetNamedSecurityInfoW failed: {status}")
        text = ctypes.c_wchar_p()
        try:
            if not self.advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor, 1, 0x4, ctypes.byref(text), None):
                raise OSError(ctypes.get_last_error(), "convert security descriptor")
            value = text.value or ""
            self.kernel32.LocalFree(ctypes.cast(text, ctypes.c_void_p))
            return value
        finally:
            self.kernel32.LocalFree(descriptor)

    def secrets_dir_protected(self, path: Path) -> bool:
        """True when the sandbox group is denied reading, as Codex setup configures it."""
        return path.is_dir() and self._denies_sandbox_read(path, container=True)

    def file_protected(self, path: Path) -> bool:
        return path.is_file() and self._denies_sandbox_read(path, container=False)

    def _denies_sandbox_read(self, path: Path, *, container: bool) -> bool:
        group = self._sandbox_group_sid()
        if not group:
            return False
        try:
            sddl = self.dacl_sddl(path)
        except OSError:
            return False
        return dacl_denies_read(sddl, group, container=container)

    def is_reparse_point(self, path: Path) -> bool:
        try:
            attributes = getattr(os.lstat(path), "st_file_attributes", 0)
        except FileNotFoundError:
            return False
        return bool(attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT


_ACE = re.compile(r"\(([^;()]*);([^;()]*);([^;()]*);[^;()]*;[^;()]*;([^;()]*)\)")
_READ_ALIASES = {"GA", "GR", "FA", "FR"}


def dacl_denies_read(sddl: str, sid: str, *, container: bool = True) -> bool:
    """Purpose: Check that an SDDL DACL denies ``sid`` file reads (and, for directories, children).

    Input: SDDL text, a string SID and whether the object is a directory.
    Output: True for a deny entry with FILE_READ_DATA that applies to the object itself and,
    for directories, is inherited by files and subdirectories.
    """
    for kind, flags, rights, trustee in _ACE.findall(sddl):
        if kind != "D" or trustee.upper() != sid.upper() or "IO" in flags:
            continue
        if container and ("OI" not in flags or "CI" not in flags):
            continue
        if rights.lower().startswith("0x"):
            if int(rights, 16) & 0x1:
                return True
        elif any(rights[i:i + 2] in _READ_ALIASES for i in range(0, len(rights), 2)):
            return True
    return False


# --- Cleo integration ---------------------------------------------------------------------


def windows_sandbox_mode(home: Path, overrides: tuple[str, ...] | list[str]) -> str | None:
    """Effective ``windows.sandbox`` for a Codex client: last override, else config.toml."""
    import tomllib

    mode = None
    for override in overrides:
        if not override.startswith("windows.sandbox") and not override.startswith("windows="):
            continue
        with contextlib.suppress(tomllib.TOMLDecodeError):
            value = tomllib.loads(override).get("windows", {})
            if isinstance(value, dict) and isinstance(value.get("sandbox"), str):
                mode = value["sandbox"]
    if mode is not None:
        return mode
    with contextlib.suppress(OSError, tomllib.TOMLDecodeError):
        saved = tomllib.loads((home / "config.toml").read_text(encoding="utf-8"))
        value = saved.get("windows", {})
        if isinstance(value, dict) and isinstance(value.get("sandbox"), str):
            return value["sandbox"]
    return None


def prepare_for_turn(cleo_home: Path, *, api: CredentialApi | None = None) -> ReconcileResult:
    """Purpose: Run before each Codex turn that uses the elevated Windows sandbox.

    Input: Cleo's Codex home. Output: The reconcile result; failures never raise, because
    Codex's own setup remains the fallback.
    """
    if sys.platform != "win32" and api is None:
        return ReconcileResult("skipped", "not_windows")
    try:
        from cleo.integrations.harness_home import external_home

        result = reconcile(Path(cleo_home), external_home("codex"),
                           api=api or Win32CredentialApi())
    except Exception as error:  # noqa: BLE001 - coordination must never block a turn
        logger.warning("Codex sandbox credential coordination failed: %s", type(error).__name__)
        return ReconcileResult("deferred", f"coordinator_error: {type(error).__name__}")
    level = logging.DEBUG if result.action in {"current", "skipped"} else logging.INFO
    logger.log(level, "Codex sandbox credentials: %s (%s) cleo=%s external=%s setup=%s",
               result.action, result.reason,
               result.cleo.accounts or result.cleo.state if result.cleo else None,
               result.external.accounts or result.external.state if result.external else None,
               result.external_setup)
    if result.external_setup.get("error", {}).get("code") == "helper_sandbox_lock_failed":
        logger.warning(
            "Standalone Codex sandbox setup failed with helper_sandbox_lock_failed; its "
            "service cannot re-lock .sandbox-bin. Re-run its sandbox setup from Codex.",
        )
    return result


def _main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m cleo.integrations.codex_sandbox_credentials",
        description="Inspect or roll back Cleo's Codex sandbox credential coordination.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="show file states without any logon attempt")
    sub.add_parser("reconcile", help="validate and adopt now (performs logon checks)")
    restore_parser = sub.add_parser("restore", help="restore a users-file backup")
    restore_parser.add_argument("backup", nargs="?")
    args = parser.parse_args(argv)
    from cleo.integrations.harness_home import external_home, harness_home

    home, external = harness_home("codex", create=False), external_home("codex")
    if args.command == "status":
        directory = coordination_dir(home)
        report = {
            "cleo_home": str(home), "standalone_home": str(external),
            "cleo_marker": marker_status(home), "standalone_marker": marker_status(external),
            "cleo_users": _read_bytes(users_path(home))[0],
            "standalone_users": _read_bytes(users_path(external))[0],
            "cleo_setup_error": read_setup_error(home),
            "standalone_setup_error": read_setup_error(external),
            "backups": sorted(p.name for p in (directory / "backups").glob("*.json")),
            "history": (_json_object(_read_bytes(directory / "state.json")[1]) or {}).get(
                "history", []),
        }
    elif args.command == "reconcile":
        report = reconcile(home, external, api=Win32CredentialApi()).to_dict()
    else:
        report = {"restored": restore(home, args.backup)}
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
