from __future__ import annotations

import subprocess

import pytest

from cleo.integrations.git import (
    create_git_checkpoint,
    finalize_git_checkpoint,
    read_git_checkpoint_diff,
    read_git_diff,
    undo_git_checkpoint,
)


def _git(cwd, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )


def _git_output(cwd, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def test_read_git_diff_includes_tracked_patch_and_untracked_names(tmp_path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test User")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    _git(tmp_path, "commit", "-m", "initial")

    tracked.write_text("after\n", encoding="utf-8")
    (tmp_path / "new.txt").write_text("new\n", encoding="utf-8")

    diff = read_git_diff(str(tmp_path))

    assert diff is not None
    assert "-before" in diff
    assert "+after" in diff
    assert "Untracked files (contents not included):" in diff
    assert "new.txt" in diff


def test_turn_checkpoint_undo_preserves_changes_that_existed_before_the_answer(
    tmp_path,
) -> None:
    _git(tmp_path, "init")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    _git(
        tmp_path,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "initial",
    )
    tracked.write_text("user staged\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    tracked.write_text("user unstaged\n", encoding="utf-8")
    existing_untracked = tmp_path / "notes.txt"
    existing_untracked.write_text("user notes\n", encoding="utf-8")
    status_before = _git_output(tmp_path, "status", "--porcelain=v1", "-uall")
    staged_before = _git_output(tmp_path, "diff", "--cached")
    unstaged_before = _git_output(tmp_path, "diff")

    checkpoint = create_git_checkpoint(str(tmp_path), "thread-1")
    assert checkpoint is not None

    tracked.write_text("agent answer\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    existing_untracked.write_text("agent changed notes\n", encoding="utf-8")
    answer_file = tmp_path / "answer.txt"
    answer_file.write_text("agent file\n", encoding="utf-8")
    completed = finalize_git_checkpoint(checkpoint)

    result = undo_git_checkpoint(completed.to_dict())

    assert result.restored_count == 3
    assert tracked.read_text(encoding="utf-8") == "user unstaged\n"
    assert existing_untracked.read_text(encoding="utf-8") == "user notes\n"
    assert not answer_file.exists()
    assert _git_output(tmp_path, "status", "--porcelain=v1", "-uall") == status_before
    assert _git_output(tmp_path, "diff", "--cached") == staged_before
    assert _git_output(tmp_path, "diff") == unstaged_before


def test_turn_checkpoint_diff_contains_only_changes_from_that_turn(tmp_path) -> None:
    _git(tmp_path, "init")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("committed\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    _git(
        tmp_path,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "initial",
    )
    tracked.write_text("user change\n", encoding="utf-8")
    checkpoint = create_git_checkpoint(str(tmp_path), "thread-history")
    assert checkpoint is not None

    tracked.write_text("agent change\n", encoding="utf-8")
    (tmp_path / "created.txt").write_text("new file\n", encoding="utf-8")
    completed = finalize_git_checkpoint(checkpoint)

    diff = read_git_checkpoint_diff(completed)

    assert "-user change" in diff
    assert "+agent change" in diff
    assert "created.txt" in diff
    assert "-committed" not in diff


def test_turn_checkpoint_rejects_changes_made_after_the_answer(tmp_path) -> None:
    _git(tmp_path, "init")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("before\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    _git(
        tmp_path,
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-m",
        "initial",
    )
    checkpoint = create_git_checkpoint(str(tmp_path), "thread-1")
    assert checkpoint is not None
    tracked.write_text("agent answer\n", encoding="utf-8")
    completed = finalize_git_checkpoint(checkpoint)
    tracked.write_text("user edit after answer\n", encoding="utf-8")

    with pytest.raises(ValueError, match="回答完成后工作区又发生了变化"):
        undo_git_checkpoint(completed)

    assert tracked.read_text(encoding="utf-8") == "user edit after answer\n"


def test_turn_checkpoint_is_unavailable_outside_git(tmp_path) -> None:
    (tmp_path / ".git").mkdir()

    assert create_git_checkpoint(str(tmp_path), "thread-1") is None
