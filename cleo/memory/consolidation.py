"""Checkpointed extraction results and deterministic publication of memory."""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from cleo.memory.dream_projection import Block, canonical
from cleo.memory.paths import memory_database_path, project_directory
from cleo.memory.persona import render_persona_markdown, upsert_persona_trait
from cleo.memory.store import record_consolidation, search_memories, upsert_memory


class MemoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    category: Literal[
        "fact", "decision", "constraint", "correction", "preference", "action",
        "pattern", "artifact", "question",
    ]
    subject: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=4000)
    evidence_refs: list[str] = Field(min_length=1, max_length=20)
    confidence: float = Field(default=1.0, ge=0, le=1)
    importance: int = Field(default=3, ge=1, le=5)
    tags: list[str] = Field(default_factory=list, max_length=20)


class PersonaItem(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    category: Literal["communication", "expression", "relationship", "adaptation", "boundary"]
    trait: str = Field(min_length=1, max_length=1000)
    evidence_refs: list[str] = Field(min_length=1, max_length=20)
    confidence: float = Field(default=1.0, ge=0, le=1)
    importance: int = Field(default=3, ge=1, le=5)
    tags: list[str] = Field(default_factory=list, max_length=20)


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    memories: list[MemoryItem] = Field(default_factory=list, max_length=30)
    persona: list[PersonaItem] = Field(default_factory=list, max_length=10)
    summary: str = Field(default="", max_length=2000)

    def validate_evidence(self, block: Block) -> None:
        for item in [*self.memories, *self.persona]:
            missing = set(item.evidence_refs) - block.evidence.keys()
            if missing:
                raise ValueError(f"unknown evidence refs: {', '.join(sorted(missing))}")


def save_checkpoint(path: Path, checkpoint: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(canonical(checkpoint), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


async def finish_write(function, *args, **kwargs):
    """Do not release the publisher lock while a cancelled worker still writes."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


@asynccontextmanager
async def project_lock(directory: Path):
    """Serialize publishers across processes; OS locks release after a crash."""
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".dream.lock").open("a+b") as stream:
        if os.name == "nt":
            import msvcrt

            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()

            def acquire():
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)

            def release():
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            def acquire():
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

            def release():
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        while True:
            try:
                acquire()
                break
            except (BlockingIOError, PermissionError):
                await asyncio.sleep(0.1)
        try:
            yield
        finally:
            release()


def publish(
    *, memory_root: Path, persona_path: Path, space: str, project: str,
    session_id: str, source_hash: str, blocks: list[Block], results: list[Extraction],
) -> int:
    """Idempotently save validated results, then render the project projection.

    Results are checkpointed before any write. Retrying publication uses identical
    text and evidence, so the existing database fingerprints prevent duplicates.
    """
    database = memory_database_path(memory_root, space)
    for block, result in zip(blocks, results, strict=True):
        result.validate_evidence(block)
        for item in result.memories:
            ids = list(dict.fromkeys(
                eid for ref in item.evidence_refs for eid in block.evidence[ref]
            ))
            upsert_memory(
                space=space, project=project, session_id=session_id, source_hash=source_hash,
                category=item.category, subject=item.subject, content=item.content,
                evidence_event_ids=ids, confidence=item.confidence, importance=item.importance,
                tags=item.tags, path=database,
            )
        for item in result.persona:
            ids = list(dict.fromkeys(
                eid for ref in item.evidence_refs for eid in block.evidence[ref]
            ))
            upsert_persona_trait(
                memory_root=memory_root, category=item.category, trait=item.trait,
                space=space, project=project, session_id=session_id, source_hash=source_hash,
                evidence_event_ids=ids, confidence=item.confidence, importance=item.importance,
                tags=item.tags,
            )
    if any(result.persona for result in results):
        render_persona_markdown(memory_root=memory_root, persona_path=persona_path)

    # Preserve pre-existing narrative; only replace our own generated section.
    path = project_directory(memory_root, space, project) / "MEMORY.md"
    marker = "<!-- cleo:consolidated-memory -->"
    existing = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    narrative = existing.partition(marker)[0].rstrip()
    if not narrative:
        narrative = f"# Project Memory: {project}"
    entries = search_memories(space=space, project=project, limit=100, path=database)
    lines = [narrative, "", marker, "", "## Consolidated Memory", "",
             "Recent/high-importance entries; the memory index retains all entries.", ""]
    for entry in entries:
        evidence = ", ".join(
            f"{item['session_id']}#{item['event_id']}" for item in entry["evidence"][:5]
        )
        subject = entry["subject"].replace(marker, "")
        content = entry["content"].replace(marker, "")
        lines.append(f"- **{subject}** ({entry['category']}): {content} (evidence: {evidence})")
    if not entries:
        lines.append("- No durable memories extracted.")
    markdown = "\n".join(lines).rstrip() + "\n"
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(markdown, encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    record_consolidation(
        space=space, project=project, session_id=session_id, source_hash=source_hash,
        summary_markdown=markdown, path=database,
    )
    from cleo.memory.store import count_source_memories

    return count_source_memories(space, project, session_id, source_hash, path=database)


def load_checkpoint(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "committed_seq": 0, "committed_hash": None,
                "summary": "", "pending": None}
    checkpoint = json.loads(path.read_text(encoding="utf-8"))
    if checkpoint.get("version") != 1:
        raise ValueError("unsupported DreamAgent checkpoint version")
    return checkpoint
