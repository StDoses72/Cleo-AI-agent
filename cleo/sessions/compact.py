"""The compact projection of a session: ``compact.json``, memory source state and chunks.

These are derived from ``events.jsonl`` and feed long-term memory: the source hash tells
DreamAgent whether a session changed since it was consolidated, and the conversation chunks
back history search.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cleo.memory.compaction import event_content_hash, write_compact_events
from cleo.memory.paths import memory_database_path, memory_state_path
from cleo.memory.state import discard_session_source, get_session_source, touch_session_source
from cleo.memory.store import delete_conversation_chunks, replace_conversation_chunks


class CompactProjection:
    def __init__(self, memory_root: Path) -> None:
        self.memory_root = memory_root

    def refresh(self, manifest: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
        """Purpose: Rebuild the projection from the full event log.

        Input: The session manifest and its events. Output: The manifest fields to record
        (``last_event_seq``, ``last_compacted_seq``, ``source_hash``, ``source_version``)
        under ``"manifest"`` and the compact payload under ``"payload"``.
        """
        space, project, session_id = manifest["space"], manifest["project"], manifest["id"]
        last_event_seq = int(events[-1]["seq"]) if events else 0
        source_hash = event_content_hash(events)
        source_state = touch_session_source(
            space=space,
            project=project,
            session_id=session_id,
            source_hash=source_hash,
            last_event_seq=last_event_seq,
            path=memory_state_path(self.memory_root, space),
        )
        _, payload = write_compact_events(
            memory_root=self.memory_root,
            space=space,
            project=project,
            session_id=session_id,
            events=events,
            source_version=int(source_state["source_version"]),
        )
        replace_conversation_chunks(
            payload,
            path=memory_database_path(self.memory_root, space),
        )
        return {
            "manifest": {
                "last_event_seq": last_event_seq,
                "last_compacted_seq": last_event_seq,
                "source_hash": source_hash,
                "source_version": int(source_state["source_version"]),
            },
            "payload": payload,
        }

    def is_consolidated(self, space: str, project: str, session_id: str) -> bool:
        state = get_session_source(
            space, project, session_id, path=memory_state_path(self.memory_root, space),
        )
        return bool(state and state.get("consolidated_hash"))

    def discard(self, space: str, project: str, session_id: str) -> None:
        """Purpose: Drop the memory source state and chunks of a session in one project."""
        discard_session_source(
            space,
            project,
            session_id,
            path=memory_state_path(self.memory_root, space),
        )
        delete_conversation_chunks(
            space=space,
            project=project,
            session_id=session_id,
            path=memory_database_path(self.memory_root, space),
        )
