"""Stable, JSON-serializable memory projection for desktop clients."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cleo.memory.paths import MEMORY_SPACES, memory_state_path
from cleo.memory.reader import MemoryReader
from cleo.memory.repository import MemoryRepository
from cleo.memory.state import list_session_sources


def build_memory_overview(
    *,
    memory_root: Path,
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
    issues = []

    for selected_space in spaces:
        result = MemoryReader(memory_root).search_long_term_memory(
            space=selected_space, project=project, limit=100,
        )
        items = result["results"]
        issues.extend(result['errors'])
        project_memory_count += result['total']
        project_entries.extend(_project_entry(entry) for entry in items)
        names = [item['project'] for item in result['projects']]
        histories = {name: MemoryRepository(memory_root).history(selected_space, name, 5)
                     for name in names}
        for entry in project_entries:
            if entry['space'] == selected_space:
                entry['history'] = histories.get(entry['project'], [])
        project_scope_count += len(names)
        project_summaries.extend(result['projects'])
        selected_sources = list_session_sources(
            selected_space,
            path=memory_state_path(memory_root, selected_space),
        )
        if project is not None:
            selected_sources = [entry for entry in selected_sources if entry["project"] == project]
        sources.extend(selected_sources)

    entries = project_entries
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
    failures = [
        issue for issue in issues if issue.get("error") != "legacy_conflicts_excluded"
    ]
    dream_status = (
        "attention" if failed_count or failures else "running" if running_count else "idle"
    )

    return {
        "schema_version": 1,
        "issues": issues,
        "summary": {
            "active_memories": project_memory_count,
            "project_memories": project_memory_count,
            "project_scopes": project_scope_count,
            "pending_sources": len(review_sources),
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
