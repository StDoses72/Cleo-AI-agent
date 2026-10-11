"""Incremental compact cache backed by the authoritative session event log."""

from __future__ import annotations

import json
import sqlite3
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cleo.memory.compact_file import (
    append_compact_file,
    decode_compact,
    read_compact_file,
    write_compact_file,
)
from cleo.memory.compaction import (
    SCHEMA_VERSION,
    _normalize_message_event,
    _now_iso,
    event_content_hash,
    project_compact_events,
    write_compact_events,
)
from cleo.memory.paths import compact_path, memory_database_path, memory_state_path
from cleo.memory.state import discard_session_source, get_session_source, touch_session_source
from cleo.memory.store import (
    conversation_projection_matches,
    delete_conversation_chunks,
    replace_conversation_chunks,
    update_conversation_chunks,
)
from cleo.sessions.files import fsync_file


@dataclass
class _ProjectionState:
    binding: tuple[str, str]
    source_signature: tuple | None
    through_seq: int
    end_offset: int
    source: dict[str, Any]
    compression: dict[str, Any]
    stats: dict[str, int]
    tool_ids: set[str]
    receipt: dict[str, Any]


def _signature(path: Path) -> tuple[int, int, int] | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size


def _tool_ids(events: list[dict]) -> set[str]:
    result = set()
    for index, event in enumerate(events):
        message = _normalize_message_event(event, index)
        if message is None:
            continue
        if message.get("tool_call_id"):
            result.add(str(message["tool_call_id"]))
        result.update(str(call["id"]) for call in message.get("tool_calls") or []
                      if isinstance(call, dict) and call.get("id"))
    return result


class CompactProjection:
    """Keep only cursors, counters and association IDs; never retain historical bodies."""

    def __init__(self, memory_root: Path) -> None:
        self.memory_root = memory_root
        self._cache: OrderedDict[str, _ProjectionState] = OrderedDict()

    def note_append(self, session_id: str, before: tuple | None, after: tuple | None) -> None:
        cached = self._cache.get(session_id)
        if cached is not None:
            if cached.source_signature == before:
                cached.source_signature = after
            else:
                self._cache.pop(session_id)

    def forget(self, session_id: str) -> None:
        self._cache.pop(session_id, None)

    def refresh(self, manifest: dict[str, Any], event_store, revision,
                *, materialize: bool = True) -> dict:
        space, project, session_id = manifest["space"], manifest["project"], manifest["id"]
        raw_path = event_store.path(space, project, session_id)
        path = compact_path(self.memory_root, space, project, session_id)
        cached = self._cache.get(session_id)
        if cached is not None and (
            cached.binding != (space, project)
            or cached.source_signature != revision.signature
            or _signature(path) != cached.receipt["signature"]
            or not conversation_projection_matches(
                space, project, session_id, cached.source["source_content_hash"],
                path=memory_database_path(self.memory_root, space),
            )
        ):
            cached = None
            self.forget(session_id)

        if cached is not None and cached.through_seq == revision.last_seq:
            self._cache.move_to_end(session_id)
            return self._result(cached, path, materialize)

        if cached is None:
            events = event_store.read(raw_path)
        else:
            with raw_path.open("rb") as stream:
                stream.seek(cached.end_offset)
                tail = stream.read(revision.end_offset - cached.end_offset)
            events = [json.loads(line) for line in tail.split(b"\n") if line.strip()]
            if any(not isinstance(event, dict)
                   or event.get("seq") != cached.through_seq + index + 1
                   for index, event in enumerate(events)):
                self.forget(session_id)
                raise ValueError("Incremental compact source sequence is incomplete")

        tools = _tool_ids(events)
        if cached is not None and (
            any(event.get("type") == "rewind" for event in events)
            or tools & cached.tool_ids
        ):
            # Exceptional dependencies can change older output; keep the full oracle.
            cached = None
            events = event_store.read(raw_path)
            tools = _tool_ids(events)

        if cached is None and event_content_hash(events) != revision.source_hash:
            self.forget(session_id)
            event_store.forget(session_id)
            raise ValueError("Session source changed while rebuilding compact")

        projected = project_compact_events(
            events, visible_index_base=cached.stats["visible_event_count"] if cached else 0,
        )
        stats = {key: value + (cached.stats[key] if cached else 0)
                 for key, value in projected["stats"].items()}
        if event_store._signature(raw_path) != revision.signature:
            self.forget(session_id)
            raise ValueError("Session source changed while preparing compact")

        if raw_path.exists():
            fsync_file(raw_path)

        source_state = touch_session_source(
            space=space, project=project, session_id=session_id,
            source_hash=revision.source_hash, last_event_seq=revision.last_seq,
            path=memory_state_path(self.memory_root, space),
        )
        first_seq = (cached.source["from_seq"] if cached else 0) or (
            int(events[0]["seq"]) if events else 0
        )
        source = {
            "relative_path": f"{space}/projects/{project}/sessions/{session_id}/events.jsonl",
            "event_count": revision.event_count,
            "from_seq": first_seq,
            "to_seq": revision.last_seq, "source_content_hash": revision.source_hash,
            "source_version": int(source_state["source_version"]),
        }
        compression = {
            "compressed_at": _now_iso(), "raw_characters": revision.raw_characters,
            "compact_characters": (
                2 + stats["record_characters"] + max(0, stats["totalrecords"] - 1)
            ),
            "omitted_tool_characters": stats["omitted_tool_characters"],
            "tool_event_count": stats["tool_event_count"],
        }
        batch = {
            "from_seq": cached.through_seq + 1 if cached else source["from_seq"],
            "to_seq": revision.last_seq, "source_hash": revision.source_hash,
            "normal": projected["normal"], "fallback": projected["fallback"],
        }
        payload = {"schema_version": SCHEMA_VERSION, "space": space, "project": project,
                   "session_id": session_id, "source": source, "compression": compression}
        try:
            if cached is None:
                receipt = write_compact_file(
                    path, {**payload, "events": projected["normal"] + projected["fallback"]}, batch,
                )
            else:
                receipt = append_compact_file(
                    path, batch, source, compression,
                    expected_signature=cached.receipt["signature"],
                    tail_offset=cached.receipt["tail_offset"],
                    batch_count=cached.receipt["batch_count"],
                )
            try:
                update_conversation_chunks(
                    payload, normal=projected["normal"], fallback=projected["fallback"],
                    batch_key=revision.last_seq,
                    expected_prior_hash=cached.source["source_content_hash"] if cached else None,
                    reset=cached is None, path=memory_database_path(self.memory_root, space),
                )
            except ValueError:
                if cached is None:
                    raise
                # A deleted/incomplete derived index can be rebuilt in this same commit.
                self.forget(session_id)
                return self.refresh(manifest, event_store, revision, materialize=materialize)
        except (OSError, ValueError, RuntimeError, sqlite3.Error):
            self.forget(session_id)
            raise

        tool_ids = cached.tool_ids if cached else set()
        tool_ids.update(tools)
        state = _ProjectionState(
            binding=(space, project), source_signature=revision.signature,
            through_seq=revision.last_seq, end_offset=revision.end_offset,
            source=source, compression=compression, stats=stats,
            tool_ids=tool_ids, receipt=receipt,
        )
        self._cache[session_id] = state
        self._cache.move_to_end(session_id)
        while len(self._cache) > 32:
            self._cache.popitem(last=False)
        return self._result(state, path, materialize)

    @staticmethod
    def _result(state: _ProjectionState, path: Path, materialize: bool) -> dict:
        return {
            "manifest": {"last_event_seq": state.through_seq,
                         "last_compacted_seq": state.through_seq,
                         "source_hash": state.source["source_content_hash"],
                         "source_version": state.source["source_version"]},
            "payload": decode_compact(read_compact_file(path)) if materialize else None,
        }

    def is_consolidated(self, space: str, project: str, session_id: str) -> bool:
        state = get_session_source(
            space, project, session_id, path=memory_state_path(self.memory_root, space),
        )
        return bool(state and state.get("consolidated_hash"))

    def export_legacy(self, manifest: dict, event_store) -> dict:
        """Explicit downgrade export; never run this whole-history path after every turn."""
        space, project, session_id = manifest["space"], manifest["project"], manifest["id"]
        self.forget(session_id)
        events = event_store.read(event_store.path(space, project, session_id))
        last_seq = int(events[-1]["seq"]) if events else 0
        source_hash = event_content_hash(events)
        state = touch_session_source(
            space=space, project=project, session_id=session_id,
            source_hash=source_hash, last_event_seq=last_seq,
            path=memory_state_path(self.memory_root, space),
        )
        _, payload = write_compact_events(
            memory_root=self.memory_root, space=space, project=project, session_id=session_id,
            events=events, source_version=int(state["source_version"]),
        )
        replace_conversation_chunks(payload, path=memory_database_path(self.memory_root, space))
        return {"manifest": {"last_event_seq": last_seq, "last_compacted_seq": last_seq,
                             "source_hash": source_hash,
                             "source_version": int(state["source_version"])}, "payload": payload}

    def discard(self, space: str, project: str, session_id: str) -> None:
        self.forget(session_id)
        discard_session_source(
            space, project, session_id, path=memory_state_path(self.memory_root, space),
        )
        delete_conversation_chunks(
            space=space, project=project, session_id=session_id,
            path=memory_database_path(self.memory_root, space),
        )
