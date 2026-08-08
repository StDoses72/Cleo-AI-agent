from __future__ import annotations

import subprocess

from cleo.integrations.git import read_git_diff


def _git(cwd, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    )


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
