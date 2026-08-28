"""Small Git helpers for the productivity UI."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_DIVERGENCE = re.compile(r"(ahead|behind) (\d+)")
_OBJECT_ID = re.compile(r"^[0-9a-f]{40,64}$")
_CHECKPOINT_VERSION = 1
_GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "Cleo",
    "GIT_AUTHOR_EMAIL": "checkpoint@cleo.local",
    "GIT_COMMITTER_NAME": "Cleo",
    "GIT_COMMITTER_EMAIL": "checkpoint@cleo.local",
}


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


@dataclass(frozen=True, slots=True)
class GitUndoResult:
    """Summary of a completed working-tree rollback."""

    repo_root: str
    restored_count: int


@dataclass(frozen=True, slots=True)
class GitCheckpoint:
    """Git object references that bracket one productivity turn."""

    repo_root: str
    ref: str
    head: str
    before_worktree: str
    before_index: str
    after_worktree: str | None = None
    after_index: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": _CHECKPOINT_VERSION,
            "repo_root": self.repo_root,
            "ref": self.ref,
            "head": self.head,
            "before_worktree": self.before_worktree,
            "before_index": self.before_index,
            "after_worktree": self.after_worktree,
            "after_index": self.after_index,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> GitCheckpoint:
        if value.get("version") != _CHECKPOINT_VERSION:
            raise ValueError("Git 回退记录版本无效。")
        fields = {
            name: str(value.get(name) or "")
            for name in (
                "repo_root",
                "ref",
                "head",
                "before_worktree",
                "before_index",
                "after_worktree",
                "after_index",
            )
        }
        if not fields["ref"].startswith("refs/cleo/undo/"):
            raise ValueError("Git 回退记录引用无效。")
        for name in (
            "head",
            "before_worktree",
            "before_index",
            "after_worktree",
            "after_index",
        ):
            if not _OBJECT_ID.fullmatch(fields[name]):
                raise ValueError("Git 回退记录对象无效。")
        return cls(**fields)


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


def create_git_checkpoint(cwd: str, checkpoint_id: str) -> GitCheckpoint | None:
    """Capture the index and working tree before one agent turn."""
    status = inspect_git_status(cwd)
    if status is None:
        return None

    head = _git(status.repo_root, "rev-parse", "--verify", "HEAD")
    if head.returncode != 0:
        raise ValueError("当前 Git 仓库还没有提交，无法创建回退记录。")
    head_id = head.stdout.strip()
    before_index_tree, before_worktree_tree = _snapshot_trees(status.repo_root, head_id)
    before_index = _commit_tree(status.repo_root, before_index_tree, None, "before index")
    before_worktree = _commit_tree(
        status.repo_root,
        before_worktree_tree,
        before_index,
        "before worktree",
    )
    digest = hashlib.sha256(checkpoint_id.encode("utf-8")).hexdigest()
    ref = f"refs/cleo/undo/{digest}"
    updated = _git(status.repo_root, "update-ref", ref, before_worktree)
    if updated.returncode != 0:
        raise RuntimeError(_git_error(updated, "Git 无法保存回退记录。"))
    return GitCheckpoint(
        repo_root=status.repo_root,
        ref=ref,
        head=head_id,
        before_worktree=before_worktree,
        before_index=before_index,
    )


def finalize_git_checkpoint(checkpoint: GitCheckpoint) -> GitCheckpoint:
    """Capture the index and working tree after the same agent turn."""
    _validate_checkpoint_repository(checkpoint)
    after_index_tree, after_worktree_tree = _snapshot_trees(
        checkpoint.repo_root,
        checkpoint.head,
    )
    after_index = _commit_tree(
        checkpoint.repo_root,
        after_index_tree,
        checkpoint.before_worktree,
        "after index",
    )
    after_worktree = _commit_tree(
        checkpoint.repo_root,
        after_worktree_tree,
        after_index,
        "after worktree",
    )
    updated = _git(
        checkpoint.repo_root,
        "update-ref",
        checkpoint.ref,
        after_worktree,
        checkpoint.before_worktree,
    )
    if updated.returncode != 0:
        raise RuntimeError(_git_error(updated, "Git 无法完成回退记录。"))
    return GitCheckpoint(
        repo_root=checkpoint.repo_root,
        ref=checkpoint.ref,
        head=checkpoint.head,
        before_worktree=checkpoint.before_worktree,
        before_index=checkpoint.before_index,
        after_worktree=after_worktree,
        after_index=after_index,
    )


def undo_git_checkpoint(value: dict[str, Any] | GitCheckpoint) -> GitUndoResult:
    """Restore the state before one turn without discarding earlier changes."""
    checkpoint = value if isinstance(value, GitCheckpoint) else GitCheckpoint.from_dict(value)
    if checkpoint.after_worktree is None or checkpoint.after_index is None:
        raise ValueError("最近一次回答的 Git 回退记录尚未完成。")
    _validate_checkpoint_repository(checkpoint)

    current_index_tree, current_worktree_tree = _snapshot_trees(
        checkpoint.repo_root,
        checkpoint.head,
    )
    after_index_tree = _tree_for_commit(checkpoint.repo_root, checkpoint.after_index)
    after_worktree_tree = _tree_for_commit(checkpoint.repo_root, checkpoint.after_worktree)
    if current_index_tree != after_index_tree or current_worktree_tree != after_worktree_tree:
        raise ValueError("回答完成后工作区又发生了变化，为避免覆盖这些改动，无法自动回退。")

    changed_paths = _changed_paths(
        checkpoint.repo_root,
        checkpoint.before_worktree,
        checkpoint.after_worktree,
    ) | _changed_paths(
        checkpoint.repo_root,
        checkpoint.before_index,
        checkpoint.after_index,
    )
    reverse_patch = _git(
        checkpoint.repo_root,
        "diff",
        "--binary",
        "--full-index",
        checkpoint.after_worktree,
        checkpoint.before_worktree,
        "--",
        timeout=30,
    )
    if reverse_patch.returncode != 0:
        raise RuntimeError(_git_error(reverse_patch, "Git 无法生成本轮回退补丁。"))

    if reverse_patch.stdout:
        checked = _git(
            checkpoint.repo_root,
            "apply",
            "--check",
            "--binary",
            input_text=reverse_patch.stdout,
            timeout=30,
        )
        if checked.returncode != 0:
            raise ValueError(_git_error(checked, "本轮改动与当前工作区冲突，无法自动回退。"))
        applied = _git(
            checkpoint.repo_root,
            "apply",
            "--binary",
            input_text=reverse_patch.stdout,
            timeout=30,
        )
        if applied.returncode != 0:
            raise RuntimeError(_git_error(applied, "Git 无法应用本轮回退补丁。"))

    restored_index = _git(checkpoint.repo_root, "read-tree", checkpoint.before_index)
    if restored_index.returncode != 0:
        _restore_after_worktree(checkpoint)
        raise RuntimeError(_git_error(restored_index, "Git 无法恢复回答前的暂存区。"))

    _git(
        checkpoint.repo_root,
        "update-ref",
        "-d",
        checkpoint.ref,
        checkpoint.after_worktree,
    )
    return GitUndoResult(checkpoint.repo_root, len(changed_paths))


def discard_git_checkpoint(value: dict[str, Any] | GitCheckpoint) -> None:
    """Remove the private ref that keeps one checkpoint reachable."""
    checkpoint = value if isinstance(value, GitCheckpoint) else GitCheckpoint.from_dict(value)
    _git(checkpoint.repo_root, "update-ref", "-d", checkpoint.ref)


def _snapshot_trees(repo_root: str, head: str) -> tuple[str, str]:
    index = _git(repo_root, "write-tree")
    if index.returncode != 0:
        raise RuntimeError(_git_error(index, "Git 无法读取暂存区。"))

    with tempfile.TemporaryDirectory(prefix="cleo-git-checkpoint-") as temporary:
        environment = {"GIT_INDEX_FILE": str(Path(temporary) / "index")}
        loaded = _git(repo_root, "read-tree", head, env=environment)
        if loaded.returncode != 0:
            raise RuntimeError(_git_error(loaded, "Git 无法初始化回退记录。"))
        added = _git(
            repo_root,
            "add",
            "-A",
            "--",
            ".",
            env=environment,
            timeout=30,
        )
        if added.returncode != 0:
            raise RuntimeError(_git_error(added, "Git 无法记录当前工作区。"))
        worktree = _git(repo_root, "write-tree", env=environment)
        if worktree.returncode != 0:
            raise RuntimeError(_git_error(worktree, "Git 无法保存当前工作区。"))
    return index.stdout.strip(), worktree.stdout.strip()


def _commit_tree(repo_root: str, tree: str, parent: str | None, label: str) -> str:
    arguments = ["commit-tree", tree]
    if parent is not None:
        arguments.extend(("-p", parent))
    arguments.extend(("-m", f"Cleo undo checkpoint: {label}"))
    committed = _git(repo_root, *arguments, env=_GIT_IDENTITY)
    if committed.returncode != 0:
        raise RuntimeError(_git_error(committed, "Git 无法创建回退对象。"))
    return committed.stdout.strip()


def _tree_for_commit(repo_root: str, commit: str) -> str:
    result = _git(repo_root, "rev-parse", f"{commit}^{{tree}}")
    if result.returncode != 0:
        raise ValueError("最近一次回答的 Git 回退对象已失效。")
    return result.stdout.strip()


def _changed_paths(repo_root: str, before: str, after: str) -> set[str]:
    result = _git(repo_root, "diff", "--name-only", before, after, "--", timeout=30)
    if result.returncode != 0:
        raise RuntimeError(_git_error(result, "Git 无法读取本轮变更。"))
    return {line for line in result.stdout.splitlines() if line}


def _validate_checkpoint_repository(checkpoint: GitCheckpoint) -> None:
    status = inspect_git_status(checkpoint.repo_root)
    if status is None:
        raise ValueError("当前工作目录不是 Git 仓库，无法回退。")
    if os.path.normcase(status.repo_root) != os.path.normcase(checkpoint.repo_root):
        raise ValueError("Git 回退记录不属于当前仓库。")
    head = _git(checkpoint.repo_root, "rev-parse", "--verify", "HEAD")
    if head.returncode != 0 or head.stdout.strip() != checkpoint.head:
        raise ValueError("本轮回答期间 Git HEAD 已变化，无法安全自动回退。")


def _restore_after_worktree(checkpoint: GitCheckpoint) -> None:
    if checkpoint.after_worktree is None:
        return
    forward_patch = _git(
        checkpoint.repo_root,
        "diff",
        "--binary",
        "--full-index",
        checkpoint.before_worktree,
        checkpoint.after_worktree,
        "--",
        timeout=30,
    )
    if forward_patch.returncode == 0 and forward_patch.stdout:
        _git(
            checkpoint.repo_root,
            "apply",
            "--binary",
            input_text=forward_patch.stdout,
            timeout=30,
        )


def _git_error(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    detail = (result.stderr or result.stdout).strip()
    return detail or fallback


def _git(
    cwd: str,
    *args: str,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    timeout: int = 5,
) -> subprocess.CompletedProcess[str]:
    """执行一次 git 子命令(带 5 秒超时, 不抛异常)。

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
            stdin=subprocess.DEVNULL if input_text is None else None,
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=None if env is None else {**os.environ, **env},
        )
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(["git", *args], 1, "", "")
