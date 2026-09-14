"""Checkpointed extraction results and deterministic publication of memory."""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from cleo.memory.dream_projection import Block, canonical
from cleo.memory.markdown import Edit


class Conflict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    preferences: list[str] = Field(min_length=2, max_length=10)
    question: str = Field(min_length=1, max_length=500)


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    edits: list[Edit] = Field(default_factory=list, max_length=30)
    conflicts: list[Conflict] = Field(default_factory=list, max_length=5)
    snapshot: list[Annotated[str, Field(max_length=200, pattern=r"^[^\r\n]*$")]] | None = Field(
        default=None, max_length=5,
    )
    work_item: str = Field(default="", max_length=150)
    summary: str = Field(default="", max_length=2000)

    def validate_evidence(self, block: Block) -> None:
        """Purpose: Reject preferences that refer to evidence outside this block.

        Input: The source block referenced by this schema-validated extraction.
        Output: Raises ValueError for missing or unknown evidence references.
        """
        for edit in self.edits:
            if edit.new and not edit.evidence_refs:
                raise ValueError("new preferences need source evidence")
            missing = set(edit.evidence_refs) - block.evidence.keys()
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


def load_checkpoint(path: Path) -> dict:
    if not path.exists():
        return {"version": 2, "committed_seq": 0, "committed_hash": None,
                "summary": "", "pending": None}
    checkpoint = json.loads(path.read_text(encoding="utf-8"))
    if checkpoint.get("version") == 1:
        return {"version": 2, "committed_seq": 0, "committed_hash": None,
                "summary": "", "pending": None}
    if checkpoint.get("version") != 2:
        raise ValueError("unsupported DreamAgent checkpoint version")
    return checkpoint
