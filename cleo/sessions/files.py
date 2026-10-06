"""Crash-safe file writes shared by the session stores."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Purpose: Replace one JSON file without leaving a half-written state.

    Input: Target path (a session manifest) and the payload. Output: None. Writes a
    ``.tmp`` sibling first, then renames it over the target.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    temp_path.replace(path)


def atomic_write_jsonl(path: Path, payloads: list[dict[str, Any]]) -> None:
    """Purpose: Replace a whole JSON-lines file (one record per line) atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
        for payload in payloads:
            stream.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    temp_path.replace(path)


def fsync_file(path: Path) -> None:
    """Purpose: Flush a written file to disk."""
    # Windows fsync/_commit requires a writable handle; r+b preserves the file bytes.
    with path.open("r+b") as persisted:
        os.fsync(persisted.fileno())


def fsync_directory(path: Path) -> None:
    """Purpose: Persist a rename inside ``path`` (no-op on Windows)."""
    if os.name == "nt":
        return
    directory_fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
