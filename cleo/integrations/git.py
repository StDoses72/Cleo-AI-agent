"""Small, read-only Git status projection for the productivity UI."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

_DIVERGENCE = re.compile(r"(ahead|behind) (\d+)")


@dataclass(frozen=True, slots=True)
class GitStatus:
    """只读的 Git 仓库状态快照。

    由 ``inspect_git_status`` 构造; 被 Textual productivity workspace 消费。
    """

    repo_root: str
    branch: str
    upstream: str | None
    ahead: int
    behind: int
    changes: tuple[str, ...]

    @property
    def dirty_count(self) -> int:
        """变更文件数量(``changes`` 长度), 供 console 渲染角标。"""
        return len(self.changes)


def inspect_git_status(cwd: str) -> GitStatus | None:
    """Return a compact status without mutating the repository.

    由 CLI productivity TUI 以
    ``session.project_path`` 调用, 用于在界面展示分支与变更概览。
    参数:
        cwd: 待检查目录(通常是 session 的 project_path); 内部先解析
            repo 顶层再执行 ``git status --short --branch``。
    返回:
        ``GitStatus``; 目录不在 git 仓库内或 git 命令失败时返回 None
        (调用方按无状态处理)。
    """
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


def read_git_diff(cwd: str) -> str | None:
    """Return the current tracked diff plus an explicit untracked-file list."""
    status = inspect_git_status(cwd)
    if status is None:
        return None

    result = _git(status.repo_root, "diff", "--no-ext-diff", "--no-color", "HEAD", "--")
    if result.returncode == 0:
        diff = result.stdout.rstrip()
    else:
        unstaged = _git(status.repo_root, "diff", "--no-ext-diff", "--no-color", "--")
        staged = _git(
            status.repo_root,
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--",
        )
        diff = "\n".join(
            part.rstrip()
            for part in (staged.stdout, unstaged.stdout)
            if part.strip()
        )

    untracked = tuple(
        change[3:].strip()
        for change in status.changes
        if change.startswith("?? ") and change[3:].strip()
    )
    if untracked:
        note = "Untracked files (contents not included):\n" + "\n".join(
            f"  {path}" for path in untracked
        )
        diff = f"{diff}\n\n{note}".strip()
    return diff


def _git(cwd: str, *args: str) -> subprocess.CompletedProcess[str]:
    """执行一次只读 git 子命令(带 5 秒超时, 不抛异常)。

    参数:
        cwd: 工作目录, 来自 ``inspect_git_status``。
        *args: git 子命令及参数。
    返回:
        ``CompletedProcess``; git 不可用或超时时返回 returncode=1 的
        合成结果, 由调用方按失败分支处理。
    """
    try:
        return subprocess.run(
            ["git", "-C", cwd, *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(["git", *args], 1, "", "")
