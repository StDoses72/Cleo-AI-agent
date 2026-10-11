"""One compact.json: immutable v3 batches followed by a replaceable small footer."""

from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from threading import Lock, RLock
from typing import Any
from weakref import WeakValueDictionary

STORAGE_VERSION = 3
_locks: WeakValueDictionary[str, Any] = WeakValueDictionary()
_locks_guard = Lock()


def _encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")


def _signature(stat: os.stat_result) -> tuple[int, int, int]:
    return stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size


def compact_signature(path: Path) -> tuple[int, int, int]:
    return _signature(path.stat())


def _opened_signature(path: Path, stream) -> tuple[int, int, int]:
    opened, named = os.fstat(stream.fileno()), path.stat()
    # Windows stat and fstat expose different ctime values after a rename.
    # Compare their common identity fields before using the path-based signature.
    fields = ("st_dev", "st_ino", "st_mtime_ns", "st_size")
    if any(getattr(opened, field) != getattr(named, field) for field in fields):
        raise ValueError("Compact file was replaced while open")
    return _signature(named)


@contextmanager
def _path_lock(path: Path):
    key = os.path.normcase(str(path.resolve()))
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = RLock()
            _locks[key] = lock
    with lock:
        yield


@contextmanager
def compact_file_lock(path: Path, *, writable: bool = False):
    """Lock byte zero on the same binary handle used for IO; no sidecar lock file."""
    with _path_lock(path), path.open("r+b" if writable else "rb") as stream:
        if os.name == "nt":
            import msvcrt

            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(stream.fileno(), fcntl.LOCK_EX if writable else fcntl.LOCK_SH)
        try:
            yield stream
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def read_compact_file(path: Path) -> dict[str, Any]:
    with compact_file_lock(path) as stream:
        before = _signature(os.fstat(stream.fileno()))
        payload = json.loads(stream.read().decode("utf-8-sig"))
        if before != _signature(os.fstat(stream.fileno())):
            raise ValueError("Compact changed while being read")
    if not isinstance(payload, dict):
        raise ValueError("Compact must be a JSON object")
    return payload


def _validate_batch(batch: dict[str, Any]) -> None:
    if not isinstance(batch, dict):
        raise ValueError("Invalid compact batch")
    if (any(type(batch.get(key)) is not int for key in ("from_seq", "to_seq"))
            or not 0 <= batch["from_seq"] <= batch["to_seq"]
            or not isinstance(batch.get("source_hash"), str)):
        raise ValueError("Invalid compact batch source")
    for lane in ("normal", "fallback"):
        records = batch.get(lane)
        if not isinstance(records, list) or any(not isinstance(record, dict) for record in records):
            raise ValueError("Invalid compact batch records")
    if batch["from_seq"] == 0 and (batch["to_seq"] != 0 or batch["normal"] or batch["fallback"]):
        raise ValueError("Only an empty compact batch can start at zero")


def decode_compact(payload: dict[str, Any]) -> dict[str, Any]:
    """Expose both storage versions as the same v2 normal-then-fallback payload."""
    if payload.get("schema_version") == 2:
        return payload
    if payload.get("schema_version") != STORAGE_VERSION:
        raise ValueError("compact memory schema is not supported")
    batches = payload.get("batches")
    source = payload.get("source")
    if (not isinstance(batches, list) or not batches or not isinstance(source, dict)
            or payload.get("batch_count") != len(batches)
            or not isinstance(payload.get("compression"), dict)
            or any(not isinstance(payload.get(key), str)
                   for key in ("space", "project", "session_id"))):
        raise ValueError("Invalid compact batch document")
    previous = -1
    for batch in batches:
        _validate_batch(batch)
        if batch["from_seq"] <= previous:
            raise ValueError("Compact batch ranges overlap")
        previous = batch["to_seq"]
    first_seq = next((batch["from_seq"] for batch in batches if batch["to_seq"]), 0)
    if (first_seq != source.get("from_seq")
            or batches[-1]["to_seq"] != source.get("to_seq")
            or batches[-1]["source_hash"] != source.get("source_content_hash")):
        raise ValueError("Compact footer does not match its committed batches")
    return {
        "schema_version": 2,
        **{key: payload[key]
           for key in ("space", "project", "session_id", "source", "compression")},
        "events": [record for lane in ("normal", "fallback")
                   for batch in batches for record in batch[lane]],
    }


def _footer(source: dict, compression: dict, batch_count: int) -> bytes:
    return b'],' + _encode({"source": source, "compression": compression,
                            "batch_count": batch_count})[1:] + b"\n"


def _published_receipt(path: Path, written: os.stat_result,
                       tail_offset: int, batch_count: int) -> dict[str, Any]:
    committed = path.stat()
    if any(getattr(written, key) != getattr(committed, key)
           for key in ("st_dev", "st_ino", "st_size")):
        raise ValueError("Compact file changed before its publication receipt")
    return {"signature": _signature(committed), "tail_offset": tail_offset,
            "batch_count": batch_count}


def write_compact_file(path: Path, payload_v2: dict, batch: dict) -> dict[str, Any]:
    """Atomically create or rebuild the complete file from one full-history batch."""
    _validate_batch(batch)
    disk = {"schema_version": STORAGE_VERSION,
            **{key: payload_v2[key] for key in ("space", "project", "session_id")},
            "batches": [batch], "source": payload_v2["source"],
            "compression": payload_v2["compression"], "batch_count": 1}
    if decode_compact(disk) != payload_v2:
        raise ValueError("Full compact batch does not match its logical payload")
    header = _encode({key: disk[key]
                      for key in ("schema_version", "space", "project", "session_id")})
    prefix = header[:-1] + b',"batches":['
    with _path_lock(path):
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(prefix)
                stream.write(_encode(batch))
                tail_offset = stream.tell()
                stream.write(_footer(payload_v2["source"], payload_v2["compression"], 1))
                stream.flush()
                os.fsync(stream.fileno())
                written = os.fstat(stream.fileno())
            os.replace(temporary, path)
            if os.name != "nt":
                directory = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
    return _published_receipt(path, written, tail_offset, 1)


def append_compact_file(
    path: Path, batch: dict, source: dict, compression: dict, *,
    expected_signature: tuple[int, int, int], tail_offset: int, batch_count: int,
) -> dict[str, Any]:
    """Overwrite only the old footer. A failed append is rebuilt from authoritative events."""
    _validate_batch(batch)
    with compact_file_lock(path, writable=True) as stream:
        if _opened_signature(path, stream) != expected_signature:
            raise ValueError("Compact file changed before append")
        if type(tail_offset) is not int or not 0 < tail_offset < expected_signature[2]:
            raise ValueError("Invalid compact tail offset")
        stream.seek(tail_offset)
        tail = stream.read()
        if not tail.startswith(b'],"source":'):
            raise ValueError("Invalid compact footer boundary")
        previous = json.loads((b'{"batches":[]' + tail[1:]).decode("utf-8"))
        if (previous.get("batch_count") != batch_count
                or batch["from_seq"] <= previous["source"]["to_seq"]
                or batch["to_seq"] != source.get("to_seq")
                or batch["source_hash"] != source.get("source_content_hash")
                or source.get("from_seq") != (previous["source"]["from_seq"]
                                              or batch["from_seq"])):
            raise ValueError("Compact append does not continue the committed source")
        stream.seek(tail_offset)
        stream.write(b"," + _encode(batch))
        next_offset = stream.tell()
        stream.write(_footer(source, compression, batch_count + 1))
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())
        written = os.fstat(stream.fileno())
    return _published_receipt(path, written, next_offset, batch_count + 1)
