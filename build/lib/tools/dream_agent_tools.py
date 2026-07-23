"""Evidence-aware tools used by Cleo's space-bound DreamAgent."""

from __future__ import annotations

import json

from langchain.tools import tool

from config.settings import settings
from core.memory.compaction import load_validated_compact
from core.memory.paths import (
    events_path,
    project_directory,
    projects_directory,
    sessions_directory,
    validate_name,
    validate_space,
)
from core.memory.state import mark_consolidated
from core.memory.store import (
    count_source_memories,
    has_consolidation,
    record_consolidation,
    search_memories,
    upsert_memory,
)

PROJECT_MEMORY_FILENAMES = (
    "MEMORY.md",
    "decisions.md",
    "open_questions.md",
    "artifacts.md",
)
PROJECT_MEMORY_TEMPLATE = """# Project Memory: {project}

## Scope
- Space: {space}
- Last Session ID: {session_id}
- Source Hash: {source_hash}

## Executive Summary
{executive_summary}

## Facts
{facts}

## Decisions
{decisions}

## User Preferences
{preferences}

## Corrections
{corrections}

## Open Questions
{open_questions}

## Next Actions
{next_actions}

## Artifact References
{artifact_refs}

## Memory Notes
{memory_patch}

## Evidence-backed Atomic Memory
{atomic_memory}

## Excluded Noise
{excluded_noise}
"""


def _safe_project_dir(space: str, project: str):
    return project_directory(
        settings.MEMORY_DIR,
        validate_space(space),
        validate_name(project, "project"),
    )


def _validate_session_id(session_id: str) -> str:
    return validate_name(session_id, "session_id")


def _validated_compact(space: str, project: str, session_id: str) -> dict:
    _safe_project_dir(space, project)
    _validate_session_id(session_id)
    return load_validated_compact(
        memory_root=settings.MEMORY_DIR,
        space=space,
        project=project,
        session_id=session_id,
    )


def _format_markdown_items(value: str) -> str:
    text = (value or "").strip()
    if not text:
        return "- None"
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    if not lines:
        return "- None"
    if all(line.lstrip().startswith(("-", "*", "1.")) for line in lines):
        return "\n".join(lines)
    if len(lines) == 1:
        return lines[0]
    return "\n".join(f"- {line}" for line in lines)


def _valid_evidence_ids(payload: dict) -> set[str]:
    valid: set[str] = set()
    for event in payload.get("events") or []:
        if not isinstance(event, dict):
            continue
        if event.get("id"):
            valid.add(str(event["id"]))
        valid.update(str(item) for item in event.get("source_event_ids") or [])
    return valid


def _atomic_memory_markdown(space: str, project: str) -> str:
    memories = search_memories(space=space, project=project, limit=100)
    if not memories:
        return "- None"
    sections: list[str] = []
    by_category: dict[str, list[dict]] = {}
    for memory in memories:
        by_category.setdefault(memory["category"], []).append(memory)
    for category in sorted(by_category):
        sections.append(f"### {category.title()}")
        for memory in by_category[category]:
            evidence = memory["evidence"]
            sources = ", ".join(
                f"{item['session_id']}#{item['event_id']}" for item in evidence[:5]
            )
            if len(evidence) > 5:
                sources += f", +{len(evidence) - 5} more"
            sections.append(
                f"- **{memory['subject']}** - {memory['content']} "
                f"(evidence: {sources})"
            )
    return "\n".join(sections)


@tool
def read_session_events(space: str, project: str, session_id: str) -> str:
    """Read an append-only event log for explicit audit or debugging."""
    try:
        path = events_path(
            settings.MEMORY_DIR,
            validate_space(space),
            validate_name(project, "project"),
            _validate_session_id(session_id),
        )
    except ValueError as exc:
        return f"Error: {exc}"
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8-sig")


@tool
def read_compact_memory(space: str, project: str, session_id: str) -> str:
    """Read one validated, redacted compact session projection."""
    try:
        payload = _validated_compact(space, project, session_id)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str)


@tool
def list_all_session_ids(space: str, project: str) -> list[str]:
    """List session IDs within one explicit space and project."""
    try:
        root = sessions_directory(settings.MEMORY_DIR, space, project)
    except ValueError:
        return []
    if not root.exists():
        return []
    return sorted(path.name for path in root.iterdir() if path.is_dir())


@tool
def list_all_project_names(space: str) -> list[str]:
    """List project names inside one memory space."""
    try:
        root = projects_directory(settings.MEMORY_DIR, validate_space(space))
    except ValueError:
        return []
    if not root.exists():
        return []
    return sorted(path.name for path in root.iterdir() if path.is_dir())


@tool
def read_project_memory(space: str, project: str) -> str:
    """Read inspectable long-term memory for one space-bound project."""
    try:
        directory = _safe_project_dir(space, project)
    except ValueError as exc:
        return f"Error: {exc}"
    if not directory.exists():
        return ""
    sections = []
    for filename in PROJECT_MEMORY_FILENAMES:
        path = directory / filename
        if path.is_file():
            content = path.read_text(encoding="utf-8-sig").strip()
            if content:
                sections.append(f"# {filename}\n\n{content}")
    return "\n\n---\n\n".join(sections)


@tool
def remember_durable_knowledge(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    category: str,
    subject: str,
    content: str,
    evidence_event_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
) -> str:
    """Store one durable memory with validated event evidence."""
    try:
        payload = _validated_compact(space, project, session_id)
        current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if source_hash != current_hash:
            raise ValueError("source_hash does not match the current compact projection")
        valid_ids = _valid_evidence_ids(payload)
        requested_ids = list(dict.fromkeys(str(item) for item in evidence_event_ids))
        missing_ids = [item for item in requested_ids if item not in valid_ids]
        if missing_ids:
            raise ValueError(f"unknown evidence event ids: {', '.join(missing_ids)}")
        memory = upsert_memory(
            space=space,
            project=project,
            session_id=session_id,
            source_hash=source_hash,
            category=category,
            subject=subject,
            content=content,
            evidence_event_ids=requested_ids,
            confidence=confidence,
            importance=importance,
            tags=tags,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(
        {
            "status": "stored",
            "id": memory["id"],
            "category": memory["category"],
            "evidence_count": memory["evidence_count"],
        },
        ensure_ascii=False,
    )


@tool
def write_memory_to_markdown(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    executive_summary: str = "",
    facts: str = "",
    decisions: str = "",
    preferences: str = "",
    corrections: str = "",
    open_questions: str = "",
    next_actions: str = "",
    artifact_refs: str = "",
    memory_patch: str = "",
    excluded_noise: str = "",
) -> str:
    """Atomically render project memory for a validated session source."""
    try:
        directory = _safe_project_dir(space, project)
        safe_session_id = _validate_session_id(session_id)
        payload = _validated_compact(space, project, safe_session_id)
        current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if source_hash != current_hash:
            raise ValueError("source_hash does not match the current compact projection")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"

    directory.mkdir(parents=True, exist_ok=True)
    memory_path = directory / "MEMORY.md"
    content = PROJECT_MEMORY_TEMPLATE.format(
        space=space,
        project=project,
        session_id=safe_session_id,
        source_hash=source_hash,
        executive_summary=(executive_summary or "No durable summary provided.").strip(),
        facts=_format_markdown_items(facts),
        decisions=_format_markdown_items(decisions),
        preferences=_format_markdown_items(preferences),
        corrections=_format_markdown_items(corrections),
        open_questions=_format_markdown_items(open_questions),
        next_actions=_format_markdown_items(next_actions),
        artifact_refs=_format_markdown_items(artifact_refs),
        memory_patch=(memory_patch or "No additional notes.").strip(),
        atomic_memory=_atomic_memory_markdown(space, project),
        excluded_noise=_format_markdown_items(excluded_noise),
    ).rstrip() + "\n"

    temp_path = memory_path.with_suffix(".md.tmp")
    temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(memory_path)
    record_consolidation(
        space=space,
        project=project,
        session_id=safe_session_id,
        source_hash=source_hash,
        summary_markdown=content,
    )
    return f"Project memory written to {memory_path}"


@tool
def complete_memory_consolidation(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    durable_memory_count: int,
    no_durable_memory_reason: str = "",
) -> str:
    """Commit consolidation after Markdown and atomic evidence are consistent."""
    try:
        payload = _validated_compact(space, project, session_id)
        current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if source_hash != current_hash:
            raise ValueError("source_hash does not match the current compact projection")
        if not has_consolidation(space, project, session_id, source_hash):
            raise ValueError("write_memory_to_markdown must succeed before completion")
        actual_count = count_source_memories(space, project, session_id, source_hash)
        if durable_memory_count != actual_count:
            raise ValueError(
                "durable_memory_count does not match the evidence-backed source count "
                f"({actual_count})"
            )
        entry = mark_consolidated(
            space,
            project,
            session_id,
            source_hash,
            durable_memory_count=durable_memory_count,
            no_durable_memory_reason=no_durable_memory_reason,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(
        {
            "status": "complete",
            "space": space,
            "project": project,
            "session_id": session_id,
            "source_version": entry["source_version"],
            "durable_memory_count": durable_memory_count,
        },
        ensure_ascii=False,
    )
