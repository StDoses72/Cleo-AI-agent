"""Append-only session event logs (``events.jsonl``)."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.memory.compaction import load_events
from cleo.memory.paths import events_path, validate_name
from cleo.sessions.files import atomic_write_jsonl

EVENT_SCHEMA_VERSION = 1

_Signature = tuple[int, int, int] | None


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def new_event_id() -> str:
    return f"evt_{uuid.uuid4().hex}"


def is_durable_handoff(events: list[dict[str, Any]]) -> bool:
    """Purpose: Whether a batch records a harness handoff, which must survive a crash."""
    return any(str((event.get("data") or {}).get("provider_event_type", ""))
               .startswith("cleo/ha") for event in events)


class JsonlEventStore:
    """One ``events.jsonl`` per session: ``seq`` increases by one, ids are unique.

    The ids and last ``seq`` already on disk are cached per session and invalidated by the
    file's mtime, ctime and size, so appends do not reread the whole log.
    """

    def __init__(self, memory_root: Path) -> None:
        self.memory_root = memory_root
        self._cache: dict[str, tuple[_Signature, set[str], int]] = {}

    def path(self, space: str, project: str, session_id: str) -> Path:
        return events_path(self.memory_root, space, project, session_id)

    @staticmethod
    def read(path: Path) -> list[dict[str, Any]]:
        return load_events(path) if path.exists() else []

    @staticmethod
    def read_prefix(path: Path, through_seq: int) -> list[dict[str, Any]]:
        """Read a frozen prefix without parsing a concurrently appended, possibly partial tail."""
        records = []
        with path.open(encoding="utf-8-sig") as source:
            for line in source:
                if len(records) >= through_seq:
                    break
                if not line.strip():
                    continue
                event = json.loads(line)
                if not isinstance(event, dict) or event.get("seq") != len(records) + 1:
                    raise ValueError("Snapshot source sequence is incomplete")
                records.append(event)
        if len(records) != through_seq:
            raise ValueError("Snapshot source is incomplete")
        return records

    def committed(self, session_id: str, path: Path) -> tuple[set[str], int]:
        """Return committed event IDs and the last sequence, invalidated by file metadata.

        Copy the ID set so a failed append cannot contaminate the cache. Sequence
        recovery uses the authoritative log, including after a process restart.
        """
        stat = path.stat() if path.exists() else None
        signature = (
            (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
            if stat is not None
            else None
        )
        cached = self._cache.get(session_id)
        if cached is not None and cached[0] == signature:
            return set(cached[1]), cached[2]
        events = load_events(path) if path.exists() else []
        ids = {
            str(event.get("id"))
            for event in events
            if event.get("id")
        }
        last_seq = int(events[-1]["seq"]) if events else 0
        self._cache[session_id] = (signature, ids, last_seq)
        return set(ids), last_seq

    @staticmethod
    def prepare(
        items: list[dict[str, Any]],
        *,
        session_id: str,
        space: str,
        project: str,
        known_ids: set[str],
        last_seq: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """Purpose: Turn requested events into log records, skipping ids already written.

        Input: Requested events (``type`` and ``actor`` required), the session scope, the
        committed ids (extended in place) and the last sequence. Output: The new records and
        the new last sequence.
        """
        appended: list[dict[str, Any]] = []
        next_seq = last_seq
        for item in items:
            event_type = validate_name(str(item.get("type") or ""), "event_type")
            actor = validate_name(str(item.get("actor") or ""), "actor")
            event_id = str(item.get("id") or new_event_id())
            if event_id in known_ids:
                continue
            next_seq += 1
            event: dict[str, Any] = {
                "schema_version": EVENT_SCHEMA_VERSION,
                "id": event_id,
                "seq": next_seq,
                "session_id": session_id,
                "space": space,
                "project": project,
                "type": event_type,
                "actor": actor,
                "created_at": item.get("created_at") or now_iso(),
            }
            for key in ("content", "data", "message", "source_message_id"):
                value = item.get(key)
                if value not in (None, {}, []):
                    event[key] = value
            appended.append(event)
            known_ids.add(event_id)
        return appended, next_seq

    def append(
        self,
        session_id: str,
        path: Path,
        events: list[dict[str, Any]],
        *,
        known_ids: set[str],
        last_seq: int,
        fsync: bool,
    ) -> None:
        """Purpose: Append prepared records and remember the committed state."""
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            for event in events:
                stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
            stream.flush()
            if fsync:
                os.fsync(stream.fileno())
        output_stat = path.stat()
        self._cache[session_id] = (
            (
                output_stat.st_mtime_ns,
                output_stat.st_ctime_ns,
                output_stat.st_size,
            ),
            set(known_ids),
            last_seq,
        )

    @staticmethod
    def rewrite(path: Path, events: list[dict[str, Any]]) -> None:
        atomic_write_jsonl(path, events)

    def forget(self, session_id: str) -> None:
        self._cache.pop(session_id, None)
