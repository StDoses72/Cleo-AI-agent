"""Append-only session event logs (``events.jsonl``)."""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from collections import OrderedDict
from collections.abc import Iterator, Set
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.memory.compaction import _canonical_json, load_events
from cleo.memory.paths import events_path, validate_name
from cleo.sessions.files import atomic_write_jsonl

EVENT_SCHEMA_VERSION = 1

_Signature = tuple[int, int, int, int, int] | None


@dataclass(frozen=True)
class EventRevision:
    last_seq: int
    end_offset: int
    source_hash: str
    event_count: int
    raw_characters: int
    signature: _Signature


class _PendingIds(Set[str]):
    """A preparation-local overlay: adding IDs cannot change the committed cache."""

    def __init__(self, committed: set[str]) -> None:
        self._committed = committed
        self._added: set[str] = set()

    def __contains__(self, value: object) -> bool:
        return value in self._committed or value in self._added

    def __iter__(self) -> Iterator[str]:
        yield from self._committed
        yield from (value for value in self._added if value not in self._committed)

    def __len__(self) -> int:
        return len(self._committed) + sum(value not in self._committed for value in self._added)

    def add(self, value: str) -> None:
        if value not in self._committed:
            self._added.add(value)


@dataclass
class _AppendState:
    path: Path
    signature: _Signature
    ids: set[str]
    message_ids: set[str]
    last_seq: int
    event_count: int
    raw_characters: int
    digest: Any
    ends_with_newline: bool

    def revision(self) -> EventRevision:
        digest = self.digest.copy()
        digest.update(b"]")
        return EventRevision(
            last_seq=self.last_seq, end_offset=self.signature[2] if self.signature else 0,
            source_hash=f"sha256:{digest.hexdigest()}", event_count=self.event_count,
            raw_characters=self.raw_characters, signature=self.signature,
        )


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

    Committed IDs, sequence and canonical source digest are cached for 32 recent sessions.
    File identity, timestamps or size changes invalidate this performance cache; evidence
    readers still validate the authoritative log independently.
    """

    def __init__(self, memory_root: Path) -> None:
        self.memory_root = memory_root
        self._cache: OrderedDict[str, _AppendState] = OrderedDict()

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

    @staticmethod
    def _signature(path: Path) -> _Signature:
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None
        return (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size, stat.st_dev, stat.st_ino)

    def _remember(self, session_id: str, state: _AppendState) -> None:
        self._cache[session_id] = state
        self._cache.move_to_end(session_id)
        while len(self._cache) > 32:
            self._cache.popitem(last=False)

    def _state(self, session_id: str, path: Path) -> _AppendState:
        signature = self._signature(path)
        cached = self._cache.get(session_id)
        if cached is not None and cached.path == path and cached.signature == signature:
            self._cache.move_to_end(session_id)
            return cached
        self.forget(session_id)
        events = load_events(path) if signature is not None else []
        digest = hashlib.sha256(b"[")
        raw_characters = 2
        for index, event in enumerate(events):
            text = _canonical_json(event)
            digest.update(("," if index else "").encode() + text.encode())
            raw_characters += len(text) + bool(index)
        ends_with_newline = True
        if signature is not None and signature[2]:
            with path.open("rb") as stream:
                stream.seek(-1, os.SEEK_END)
                ends_with_newline = stream.read(1) == b"\n"
        if self._signature(path) != signature:
            raise ValueError("Session event log changed while its cache was rebuilt")
        state = _AppendState(
            path=path, signature=signature,
            ids={str(event["id"]) for event in events if event.get("id")},
            message_ids={str(event["source_message_id"]) for event in events
                         if event.get("source_message_id")},
            last_seq=int(events[-1]["seq"]) if events else 0,
            event_count=len(events), raw_characters=raw_characters, digest=digest,
            ends_with_newline=ends_with_newline,
        )
        self._remember(session_id, state)
        return state

    def committed(self, session_id: str, path: Path) -> tuple[_PendingIds, int]:
        """Return committed event IDs and the last sequence, invalidated by file metadata.

        New IDs stay in a small overlay until append succeeds. Sequence recovery uses
        the authoritative log, including after a process restart.
        """
        state = self._state(session_id, path)
        return _PendingIds(state.ids), state.last_seq

    def source_message_ids(self, session_id: str, path: Path) -> Set[str]:
        return _PendingIds(self._state(session_id, path).message_ids)

    def revision(self, session_id: str, path: Path) -> EventRevision:
        """Capture the current cached prefix; evidence readers still verify raw content."""
        return self._state(session_id, path).revision()

    @staticmethod
    def prepare(
        items: list[dict[str, Any]],
        *,
        session_id: str,
        space: str,
        project: str,
        known_ids: set[str] | _PendingIds,
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
        known_ids: Set[str],
        last_seq: int,
        fsync: bool,
    ) -> EventRevision:
        """Purpose: Append prepared records and remember the committed state."""
        try:
            state = self._state(session_id, path)
            lines = [json.dumps(event, ensure_ascii=False, default=str) + "\n" for event in events]
            persisted = [json.loads(line) for line in lines]
            digest = state.digest.copy()
            raw_characters = state.raw_characters
            for index, event in enumerate(persisted):
                if int(event["seq"]) != state.last_seq + index + 1:
                    raise ValueError("Session event log changed before append")
                text = _canonical_json(event)
                separator = "," if state.event_count + index else ""
                digest.update(separator.encode() + text.encode())
                raw_characters += len(text) + len(separator)
            if last_seq != state.last_seq + len(events):
                raise ValueError("Session append sequence does not match its events")
            end_offset = state.signature[2] if state.signature else 0
            with path.open("a", encoding="utf-8", newline="\n") as stream:
                if events and not state.ends_with_newline:
                    stream.write("\n")
                    end_offset += 1
                for line in lines:
                    stream.write(line)
                    end_offset += len(line.encode())
                stream.flush()
                if fsync:
                    os.fsync(stream.fileno())
                written = os.fstat(stream.fileno())
            signature = self._signature(path)
            # Windows can publish the final write timestamp only when the handle closes.
            if signature is None or signature[2:] != (end_offset, written.st_dev, written.st_ino):
                raise ValueError("Session event log changed during append")
        except (OSError, ValueError, TypeError):
            self.forget(session_id)
            raise
        state.signature = signature
        state.digest = digest
        state.raw_characters = raw_characters
        state.last_seq = last_seq
        state.event_count += len(events)
        state.ends_with_newline = state.ends_with_newline or bool(events)
        state.ids.update(str(event["id"]) for event in persisted)
        state.message_ids.update(str(event["source_message_id"]) for event in persisted
                                 if event.get("source_message_id"))
        self._remember(session_id, state)
        return state.revision()

    @staticmethod
    def rewrite(path: Path, events: list[dict[str, Any]]) -> None:
        atomic_write_jsonl(path, events)

    def forget(self, session_id: str) -> None:
        self._cache.pop(session_id, None)
