"""Evidence-aware tools used by Cleo's DreamAgent."""

from __future__ import annotations

import json

from langchain.tools import tool

from config.settings import settings
from core.memory.compaction import load_validated_compact
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
LEGACY_PROJECT_MEMORY_FILENAME = "AGENT.md"
PROJECT_MEMORY_TEMPLATE = """# Project Memory: {project}

## Last Consolidated Source
- Thread ID: {thread_id}
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


def _is_safe_name(value: str) -> bool:
    return bool(value) and not any(part in value for part in ("/", "\\", ".."))


def _safe_project_dir(project: str):
    if not _is_safe_name(project):
        raise ValueError("project must be a project name, not a path")
    return settings.MEMORY_PROJECTS_DIR / project


def _validate_thread_id(thread_id: str) -> str:
    if not _is_safe_name(thread_id):
        raise ValueError("thread_id must be an id, not a path")
    return thread_id


def _validated_compact(project: str, thread_id: str) -> dict:
    _safe_project_dir(project)
    _validate_thread_id(thread_id)
    return load_validated_compact(
        project=project,
        thread_id=thread_id,
        thread_objects_dir=settings.THREAD_OBJECTS_DIR,
        compact_dir=settings.COMPACT_THREADS_DIR,
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
    for message in payload.get("messages") or []:
        if not isinstance(message, dict):
            continue
        if message.get("id"):
            valid.add(str(message["id"]))
        valid.update(str(item) for item in message.get("source_message_ids") or [])
    return valid


def _atomic_memory_markdown(project: str) -> str:
    memories = search_memories(project=project, limit=100)
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
                f"{item['thread_id']}#{item['message_id']}" for item in evidence[:5]
            )
            if len(evidence) > 5:
                sources += f", +{len(evidence) - 5} more"
            sections.append(
                f"- **{memory['subject']}** — {memory['content']} "
                f"(evidence: {sources})"
            )
    return "\n".join(sections)


@tool
def read_memory_from_json(thread_id: str) -> str:
    """Read the authoritative raw snapshot for manual audit or debugging only."""
    try:
        safe_thread_id = _validate_thread_id(thread_id)
    except ValueError as exc:
        return f"Error: {exc}"
    file_path = settings.THREAD_OBJECTS_DIR / f"{safe_thread_id}.json"
    if not file_path.exists():
        return ""
    return file_path.read_text(encoding="utf-8-sig")


@tool
def read_compact_memory(project: str, thread_id: str) -> str:
    """Read the validated, redacted compact snapshot for one project thread."""
    try:
        payload = _validated_compact(project, thread_id)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(payload, ensure_ascii=False, indent=2, default=str)


@tool
def list_all_thread_ids() -> list[str]:
    """List saved raw thread IDs."""
    if not settings.THREAD_OBJECTS_DIR.exists():
        return []
    return sorted(path.stem for path in settings.THREAD_OBJECTS_DIR.glob("*.json"))


@tool
def list_all_project_names() -> list[str]:
    """List project names that currently have long-term memory directories."""
    if not settings.MEMORY_PROJECTS_DIR.exists():
        return []
    return sorted(path.name for path in settings.MEMORY_PROJECTS_DIR.iterdir() if path.is_dir())


@tool
def read_project_memory(project: str) -> str:
    """Read existing inspectable long-term memory for one project."""
    try:
        project_directory = _safe_project_dir(project)
    except ValueError as exc:
        return f"Error: {exc}"
    if not project_directory.exists():
        return ""
    sections = []
    for filename in PROJECT_MEMORY_FILENAMES:
        file_path = project_directory / filename
        if file_path.is_file():
            content = file_path.read_text(encoding="utf-8-sig").strip()
            if content:
                sections.append(f"# {filename}\n\n{content}")
    if not (project_directory / "MEMORY.md").is_file():
        legacy_path = project_directory / LEGACY_PROJECT_MEMORY_FILENAME
        if legacy_path.is_file():
            content = legacy_path.read_text(encoding="utf-8-sig").strip()
            if content:
                sections.append(f"# {LEGACY_PROJECT_MEMORY_FILENAME} (legacy)\n\n{content}")
    return "\n\n---\n\n".join(sections)


@tool
def remember_durable_knowledge(
    project: str,
    thread_id: str,
    source_hash: str,
    category: str,
    subject: str,
    content: str,
    evidence_message_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
) -> str:
    """Store one atomic durable memory with validated source-message evidence.

    Category must be one of fact, decision, constraint, correction, preference,
    action, pattern, artifact, or question. Evidence IDs must occur in the
    current compact snapshot and should point to user or tool evidence whenever
    possible. Project-private information always remains project-scoped.
    """
    try:
        payload = _validated_compact(project, thread_id)
        current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if source_hash != current_hash:
            raise ValueError("source_hash does not match the current compact snapshot")
        valid_ids = _valid_evidence_ids(payload)
        requested_ids = list(dict.fromkeys(str(item) for item in evidence_message_ids))
        missing_ids = [item for item in requested_ids if item not in valid_ids]
        if missing_ids:
            raise ValueError(f"unknown evidence message ids: {', '.join(missing_ids)}")
        memory = upsert_memory(
            project=project,
            thread_id=thread_id,
            source_hash=source_hash,
            category=category,
            subject=subject,
            content=content,
            evidence_message_ids=requested_ids,
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
    project: str,
    thread_id: str,
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
    """Atomically render inspectable project memory for a validated source.

    Read existing project memory first and preserve durable context in the
    narrative sections. The evidence-backed atomic index is rendered from
    SQLite automatically and cannot be omitted accidentally.
    """
    try:
        project_directory = _safe_project_dir(project)
        safe_thread_id = _validate_thread_id(thread_id)
        payload = _validated_compact(project, safe_thread_id)
        current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if source_hash != current_hash:
            raise ValueError("source_hash does not match the current compact snapshot")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"

    project_directory.mkdir(parents=True, exist_ok=True)
    memory_path = project_directory / "MEMORY.md"
    content = PROJECT_MEMORY_TEMPLATE.format(
        thread_id=safe_thread_id,
        source_hash=source_hash,
        project=project,
        executive_summary=(executive_summary or "No durable summary provided.").strip(),
        facts=_format_markdown_items(facts),
        decisions=_format_markdown_items(decisions),
        preferences=_format_markdown_items(preferences),
        corrections=_format_markdown_items(corrections),
        open_questions=_format_markdown_items(open_questions),
        next_actions=_format_markdown_items(next_actions),
        artifact_refs=_format_markdown_items(artifact_refs),
        memory_patch=(memory_patch or "No additional notes.").strip(),
        atomic_memory=_atomic_memory_markdown(project),
        excluded_noise=_format_markdown_items(excluded_noise),
    ).rstrip() + "\n"

    temp_path = memory_path.with_suffix(".md.tmp")
    temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(memory_path)
    record_consolidation(
        project=project,
        thread_id=safe_thread_id,
        source_hash=source_hash,
        summary_markdown=content,
    )
    return f"Project memory written to {memory_path}"


@tool
def complete_memory_consolidation(
    project: str,
    thread_id: str,
    source_hash: str,
    durable_memory_count: int,
    no_durable_memory_reason: str = "",
) -> str:
    """Commit a memory run after its project Markdown was written successfully.

    durable_memory_count must equal the number of distinct atomic memories with
    evidence from this source, including idempotent writes from a retried run.
    """
    try:
        payload = _validated_compact(project, thread_id)
        current_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if source_hash != current_hash:
            raise ValueError("source_hash does not match the current compact snapshot")
        if not has_consolidation(project, thread_id, source_hash):
            raise ValueError("write_memory_to_markdown must succeed before completion")
        actual_count = count_source_memories(project, thread_id, source_hash)
        if durable_memory_count != actual_count:
            raise ValueError(
                "durable_memory_count does not match the evidence-backed source count "
                f"({actual_count})"
            )
        entry = mark_consolidated(
            project,
            thread_id,
            source_hash,
            durable_memory_count=durable_memory_count,
            no_durable_memory_reason=no_durable_memory_reason,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return f"Error: {exc}"
    return json.dumps(
        {
            "status": "complete",
            "project": project,
            "thread_id": thread_id,
            "source_version": entry["source_version"],
            "durable_memory_count": durable_memory_count,
        },
        ensure_ascii=False,
    )
