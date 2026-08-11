"""Stable, JSON-serializable memory projection for desktop clients."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from cleo.memory.paths import MEMORY_SPACES, memory_database_path, memory_state_path
from cleo.memory.persona import list_persona_traits
from cleo.memory.state import list_session_sources
from cleo.memory.store import get_memory_inventory

if TYPE_CHECKING:
    from cleo.config.settings import MemoryGateSettings


def build_memory_overview(
    *,
    memory_root: Path,
    memory_gate: MemoryGateSettings,
    space: str | None = None,
    project: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    """Build the desktop memory view without loading the embedding model."""
    spaces = (space,) if space is not None else MEMORY_SPACES
    project_entries: list[dict[str, Any]] = []
    project_summaries: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    project_memory_count = 0
    project_scope_count = 0

    for selected_space in spaces:
        inventory = get_memory_inventory(
            space=selected_space,
            project=project,
            limit=limit,
            path=memory_database_path(memory_root, selected_space),
        )
        project_memory_count += inventory["active_memory_count"]
        project_scope_count += inventory["project_count"]
        project_entries.extend(_project_entry(entry) for entry in inventory["entries"])
        project_summaries.extend(
            {
                "space": selected_space,
                "project": entry["project"],
                "memory_count": entry["memory_count"],
                "updated_at": entry["updated_at"],
            }
            for entry in inventory["projects"]
        )
        selected_sources = list_session_sources(
            selected_space,
            path=memory_state_path(memory_root, selected_space),
        )
        if project is not None:
            selected_sources = [entry for entry in selected_sources if entry["project"] == project]
        sources.extend(selected_sources)

    persona_traits = list_persona_traits(memory_root=memory_root)
    entries = [*project_entries, *(_persona_entry(entry) for entry in persona_traits)]
    entries.sort(key=lambda entry: entry["updated_at"], reverse=True)

    pending_count = sum(entry.get("status") == "pending" for entry in sources)
    running_count = sum(entry.get("status") == "running" for entry in sources)
    failed_count = sum(entry.get("status") == "failed" for entry in sources)
    review_sources = [
        _review_source(entry) for entry in sources if entry.get("status") in {"pending", "failed"}
    ]
    review_sources.sort(key=lambda entry: entry["updated_at"], reverse=True)
    project_summaries.sort(key=lambda entry: entry["updated_at"] or "", reverse=True)
    processed_times = [entry.get("last_processed_at") for entry in sources]
    last_processed_at = max((value for value in processed_times if value), default=None)
    dream_status = "attention" if failed_count else "running" if running_count else "idle"

    return {
        "schema_version": 1,
        "summary": {
            "active_memories": project_memory_count + len(persona_traits),
            "project_memories": project_memory_count,
            "project_scopes": project_scope_count,
            "persona_traits": len(persona_traits),
            "pending_sources": len(review_sources),
        },
        "gate": {
            "enabled": memory_gate.enabled,
            "provider": "sentence-transformers",
            "model": memory_gate.model,
            "configuration_key": "memory_gate.model",
            "local_files_only": memory_gate.local_files_only,
            "minimum_similarity": memory_gate.minimum_similarity,
            "run_margin": memory_gate.run_margin,
            "skip_margin": memory_gate.skip_margin,
        },
        "dream_agent": {
            "status": dream_status,
            "last_processed_at": last_processed_at,
            "pending_count": pending_count,
            "running_count": running_count,
            "failed_count": failed_count,
        },
        "project_summaries": project_summaries,
        "review_sources": review_sources,
        "entries": entries[: max(1, min(int(limit), 500))],
    }


def _project_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "scope": "project",
        "space": entry["space"],
        "project": entry["project"],
        "category": entry["category"],
        "title": entry["subject"],
        "content": entry["content"],
        "confidence": entry["confidence"],
        "importance": entry["importance"],
        "tags": entry["tags"],
        "evidence": [
            {
                "space": evidence["space"],
                "project": evidence["project"],
                "session_id": evidence["session_id"],
                "event_id": evidence["event_id"],
                "observed_at": evidence["observed_at"],
            }
            for evidence in entry["evidence"]
        ],
        "evidence_count": entry["evidence_count"],
        "updated_at": entry["updated_at"],
    }


def _persona_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry["id"],
        "scope": "persona",
        "space": None,
        "project": None,
        "category": entry["category"],
        "title": entry["category"].replace("_", " ").title(),
        "content": entry["trait"],
        "confidence": entry["confidence"],
        "importance": entry["importance"],
        "tags": json.loads(entry["tags_json"] or "[]"),
        "evidence": [],
        "evidence_count": entry["evidence_count"],
        "updated_at": entry["updated_at"],
    }


def _review_source(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"{entry['space']}:{entry['project']}:{entry['session_id']}",
        "space": entry["space"],
        "project": entry["project"],
        "session_id": entry["session_id"],
        "status": entry["status"],
        "source_version": int(entry.get("source_version", 0)),
        "last_event_seq": int(entry.get("last_event_seq", 0)),
        "failure_count": int(entry.get("failure_count", 0)),
        "last_error": entry.get("last_error"),
        "updated_at": entry.get("last_updated_at") or "",
    }
