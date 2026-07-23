"""Small, read-only Git status projection for the productivity UI."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

_DIVERGENCE = re.compile(r"(ahead|behind) (\d+)")


@dataclass(frozen=True, slots=True)
class GitStatus:
    repo_root: str
    branch: str
    upstream: str | None
    ahead: int
    behind: int
    changes: tuple[str, ...]

    @property
    def dirty_count(self) -> int:
        return len(self.changes)


def inspect_git_status(cwd: str) -> GitStatus | None:
    """Return a compact status without mutating the repository."""
    root_result = _git(cwd, "rev-parse", "--show-toplevel")
    if root_result.returncode != 0:
        return None
    repo_root = root_result.stdout.strip()
    status_result = _git(repo_root, "status", "--short", "--branch")
    if status_result.returncode != 0:
        return None

    lines = status_result.stdout.splitlines()
    header = lines[0].removeprefix("## ").strip() if lines else "HEAD"
    branch_part, _, divergence = header.partition(" [")
    branch, separator, upstream = branch_part.partition("...")
    ahead = 0
    behind = 0
    for direction, value in _DIVERGENCE.findall(divergence):
        if direction == "ahead":
            ahead = int(value)
        else:
            behind = int(value)
    return GitStatus(
        repo_root=str(Path(repo_root).resolve()),
        branch=branch.strip() or "HEAD",
        upstream=upstream.strip() if separator else None,
        ahead=ahead,
        behind=behind,
        changes=tuple(lines[1:]),
    )


def _git(cwd: str, *args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(["git", *args], 1, "", "")
