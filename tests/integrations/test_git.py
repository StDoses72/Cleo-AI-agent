from __future__ import annotations

import subprocess

import pytest

from cleo.desktop.projection import changes_from_diff
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


def test_undo_visibility_uses_tree_changes_instead_of_checkpoint_commit_ids(tmp_path):
    from cleo.desktop.service import DesktopService

    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("before")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "initial")
    before = create_git_checkpoint(str(tmp_path), "no-op")
    after = finalize_git_checkpoint(before)
    assert before.before_worktree != after.after_worktree
    assert not DesktopService._can_undo({"undo_checkpoint": after.to_dict()})
    before = create_git_checkpoint(str(tmp_path), "changed")
    tracked.write_text("after")
    after = finalize_git_checkpoint(before)
    assert DesktopService._can_undo({"undo_checkpoint": after.to_dict()})
    assert not DesktopService._can_undo({
        "undo_checkpoint": after.to_dict(), "undo_checkpoint_shared": True,
    })
    assert not DesktopService._can_undo({})


def test_read_git_diff_shows_untracked_files_as_new_files(tmp_path) -> None:
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
    assert "diff --git a/new.txt b/new.txt\nnew file mode" in diff
    assert "+new" in diff
    assert "Untracked files (contents not included):" not in diff
    assert [change["path"] for change in changes_from_diff(diff)] == ["tracked.txt", "new.txt"]
    assert changes_from_diff(diff)[1]["status"] == "added"


def test_read_git_diff_lists_large_untracked_files_by_name(tmp_path, monkeypatch) -> None:
    import cleo.integrations.git as git_module

    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test User")
    (tmp_path / "tracked.txt").write_text("before\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    _git(tmp_path, "commit", "-m", "initial")
    (tmp_path / "big.log").write_text("x" * 64, encoding="utf-8")
    (tmp_path / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("secret\n", encoding="utf-8")
    monkeypatch.setattr(git_module, "_UNTRACKED_DIFF_BYTES", 32)

    diff = read_git_diff(str(tmp_path))

    assert diff is not None
    changes = {change["path"]: change for change in changes_from_diff(diff)}
    assert set(changes) == {".gitignore", "big.log"}
    assert changes["big.log"]["status"] == "added"
    assert "contents not included" in changes["big.log"]["diff"]
    assert "big.log" not in changes[".gitignore"]["diff"]
    assert "diff --git a/.gitignore b/.gitignore" in diff
    assert "diff --git a/ignored.txt" not in diff


@pytest.mark.parametrize("path", ["big.log", "folder name/报告.log", "folder b/file.log",
                                 "line\u2028break.log", "line\u0085break.log"])
def test_omitted_untracked_file_keeps_its_exact_path(tmp_path, monkeypatch, path) -> None:
    import cleo.integrations.git as git_module

    _git(tmp_path, "init")
    file = tmp_path / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("not included\n", encoding="utf-8")
    monkeypatch.setattr(git_module, "_UNTRACKED_DIFF_BYTES", 1)

    changes = changes_from_diff(read_git_diff(str(tmp_path)))

    assert len(changes) == 1
    assert changes[0]["path"] == path
    assert changes[0]["status"] == "added"
    assert changes[0]["additions"] == changes[0]["deletions"] == 0
    assert "contents not included" in changes[0]["diff"]


def test_untracked_file_limit_keeps_every_file_card(tmp_path) -> None:
    _git(tmp_path, "init")
    paths = [f"new-{index:02}.txt" for index in range(51)]
    for path in paths:
        (tmp_path / path).write_text("new\n", encoding="utf-8")

    changes = changes_from_diff(read_git_diff(str(tmp_path)))

    assert [change["path"] for change in changes] == paths
    assert all(change["status"] == "added" for change in changes)
    assert changes[0]["additions"] == 1
    assert "contents not included" in changes[-1]["diff"]


def test_unreadable_untracked_file_keeps_its_file_card(tmp_path, monkeypatch) -> None:
    from pathlib import Path

    _git(tmp_path, "init")
    file = tmp_path / "unreadable.txt"
    file.write_text("private\n", encoding="utf-8")
    stat = Path.stat

    def unreadable(path, *args, **kwargs):
        if path == file:
            raise PermissionError("test read denied")
        return stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", unreadable)
    changes = changes_from_diff(read_git_diff(str(tmp_path)))

    assert len(changes) == 1
    assert changes[0]["path"] == "unreadable.txt"
    assert changes[0]["status"] == "added"
    assert "contents not included" in changes[0]["diff"]


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


def test_turn_checkpoint_diff_preserves_trailing_spaces(tmp_path) -> None:
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
    checkpoint = create_git_checkpoint(str(tmp_path), "thread-spaces")
    assert checkpoint is not None

    tracked.write_text("after  \n", encoding="utf-8")
    completed = finalize_git_checkpoint(checkpoint)

    assert "+after  " in read_git_checkpoint_diff(completed)


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
