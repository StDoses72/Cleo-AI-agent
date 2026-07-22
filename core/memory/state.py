"""Durable source-version state for space-bound session consolidation."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from config.settings import settings
from core.memory.paths import memory_state_path, validate_name, validate_space

SCHEMA_VERSION = 2
_STATE_LOCK = RLock()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _state_path(space: str, path: Path | None) -> Path:
    return path or memory_state_path(settings.MEMORY_DIR, validate_space(space))


def _empty_state() -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "updated_at": _now_iso(), "sources": {}}


def _source_id(space: str, project: str, session_id: str) -> str:
    return (
        f"session:{validate_space(space)}:"
        f"{validate_name(project, 'project')}:"
        f"{validate_name(session_id, 'session_id')}"
    )


def _load_unlocked(path: Path) -> dict[str, Any]:
    if not path.exists():
        return _empty_state()
    try:
        state = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return _empty_state()
    if not isinstance(state, dict) or state.get("schema_version") != SCHEMA_VERSION:
        return _empty_state()
    if not isinstance(state.get("sources"), dict):
        state["sources"] = {}
    return state


def _save_unlocked(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["schema_version"] = SCHEMA_VERSION
    state["updated_at"] = _now_iso()
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def touch_session_source(
    *,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    last_event_seq: int,
    path: Path | None = None,
) -> dict[str, Any]:
    """Register an event-log revision without advancing consolidation state.

    ``source_version`` is a monotonic revision counter for this session's
    persisted event source. In normal conversation flow it advances roughly
    once per completed interaction batch, but lifecycle/status events can also
    advance it, so it is not an exact turn count or a schema/model version.
    """
    state_path = _state_path(space, path)
    source_id = _source_id(space, project, session_id)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(source_id)
        now = _now_iso()
        if entry is None:
            entry = {
                "space": space,
                "project": project,
                "session_id": session_id,
                "source_version": 1,
                "source_hash": source_hash,
                "last_event_seq": int(last_event_seq),
                "consolidated_version": 0,
                "consolidated_hash": None,
                "status": "pending",
                "failure_count": 0,
                "last_error": None,
                "last_updated_at": now,
                "last_consolidated_at": None,
            }
            state["sources"][source_id] = entry
        elif entry.get("source_hash") != source_hash:
            # A distinct event-log hash represents a new source revision. Keep
            # only the latest revision number; no per-version history is stored.
            entry["source_version"] = int(entry.get("source_version", 0)) + 1
            entry["source_hash"] = source_hash
            entry["last_event_seq"] = int(last_event_seq)
            entry["status"] = "pending"
            entry["last_error"] = None
            entry["last_updated_at"] = now
        _save_unlocked(state_path, state)
        return dict(entry)


def get_session_source(
    space: str,
    project: str,
    session_id: str,
    *,
    path: Path | None = None,
) -> dict[str, Any] | None:
    with _STATE_LOCK:
        state = _load_unlocked(_state_path(space, path))
        entry = state["sources"].get(_source_id(space, project, session_id))
        return dict(entry) if entry else None


def needs_consolidation(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> bool:
    entry = get_session_source(space, project, session_id, path=path)
    return entry is None or entry.get("consolidated_hash") != source_hash


def mark_consolidation_started(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> dict[str, Any]:
    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None or entry.get("source_hash") != source_hash:
            raise ValueError("memory source changed before consolidation started")
        entry["status"] = "running"
        entry["last_started_at"] = _now_iso()
        entry["last_error"] = None
        _save_unlocked(state_path, state)
        return dict(entry)


def mark_consolidation_failed(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    error: str,
    *,
    path: Path | None = None,
) -> dict[str, Any] | None:
    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None:
            return None
        if entry.get("source_hash") == source_hash:
            entry["status"] = "failed"
            entry["failure_count"] = int(entry.get("failure_count", 0)) + 1
            entry["last_error"] = str(error)[:2000]
            entry["last_failed_at"] = _now_iso()
            _save_unlocked(state_path, state)
        return dict(entry)


def mark_consolidated(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    durable_memory_count: int,
    no_durable_memory_reason: str = "",
    path: Path | None = None,
) -> dict[str, Any]:
    if durable_memory_count < 0:
        raise ValueError("durable_memory_count cannot be negative")
    if durable_memory_count == 0 and not no_durable_memory_reason.strip():
        raise ValueError("a no-op consolidation requires a reason")

    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None or entry.get("source_hash") != source_hash:
            raise ValueError("memory source changed before consolidation completed")
        entry["consolidated_hash"] = source_hash
        entry["consolidated_version"] = int(entry.get("source_version", 0))
        entry["status"] = "complete"
        entry["failure_count"] = 0
        entry["last_error"] = None
        entry["last_consolidated_at"] = _now_iso()
        entry["durable_memory_count"] = durable_memory_count
        entry["no_durable_memory_reason"] = no_durable_memory_reason.strip() or None
        _save_unlocked(state_path, state)
        return dict(entry)
