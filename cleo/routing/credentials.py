"""Local benchmark credentials: user-bound DPAPI on Windows, owner-only files elsewhere."""

import base64
import ctypes
import json
import os
import tempfile
from pathlib import Path


def _dpapi(value: bytes, *, decrypt=False) -> bytes:
    """Purpose: Protect a credential for the current Windows user. Output: protected/plain bytes."""
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypto = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypto.CryptUnprotectData if decrypt else crypto.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ValueError("无法访问本机 benchmark 凭据。")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)


def save_key(path: Path, key: str) -> None:
    """Purpose: Store only a user-entered AA key. Input: secret/path. Output: private local file."""
    raw = key.encode("utf-8")
    protected = _dpapi(raw) if os.name == "nt" else raw
    payload = {"format": "dpapi" if os.name == "nt" else "owner-only",
               "value": base64.b64encode(protected).decode("ascii")}
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".benchmark-key-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream)
        Path(name).replace(path)
    finally:
        Path(name).unlink(missing_ok=True)


def read_key(path: Path | None, env_name: str) -> str | None:
    """Purpose: Resolve server-side credentials. Output: environment override or stored key."""
    if os.environ.get(env_name):
        return os.environ[env_name]
    if path is None or not path.is_file():
        return None
    try:
        if path.stat().st_size > 32_000:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        raw = base64.b64decode(payload["value"], validate=True)
        if payload["format"] == "dpapi" and os.name == "nt":
            raw = _dpapi(raw, decrypt=True)
        elif payload["format"] != "owner-only" or os.name == "nt":
            return None
        elif path.stat().st_mode & 0o077:
            return None
        return raw.decode("utf-8") or None
    except (OSError, ValueError, KeyError, TypeError):
        return None
