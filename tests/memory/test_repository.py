import subprocess

import pytest

from cleo.memory.repository import MemoryRepository

TEXT = "# 用户偏好\n- 默认中文解释。\n"


def test_nested_git_allowlist_noop_and_manual_edit(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    root = tmp_path / "memory"
    repo = MemoryRepository(root)
    session = root / "productivity/projects/course/sessions/s1/events.jsonl"
    session.parent.mkdir(parents=True)
    session.write_text("private history")
    (root / "sessions.sqlite3").write_text("private database")
    commit = repo.publish("productivity", "course", "", TEXT, "Add preference")
    assert commit and repo.read("productivity", "course") == TEXT
    assert repo._git("ls-files") == "productivity/projects/course/MEMORY.md"
    assert repo.publish("productivity", "course", TEXT, TEXT, "No change") is None
    assert len(repo.history("productivity", "course")) == 1
    assert not (tmp_path / ".gitmodules").exists()
    assert (
        subprocess.run(["git", "-C", str(tmp_path), "ls-files"], capture_output=True).stdout == b""
    )
    repo.path("productivity", "course").write_text(TEXT + "- 简洁。\n", encoding="utf-8")
    with pytest.raises(ValueError, match="changed since"):
        repo.publish("productivity", "course", TEXT, TEXT.replace("中文", "英文"), "stale")


def test_commit_failure_restores_file_and_retry_is_once(tmp_path, monkeypatch):
    repo = MemoryRepository(tmp_path)
    repo.publish("productivity", "course", "", TEXT, "initial")
    original = repo._git

    def fail(*args, **kwargs):
        if args[0] == "commit":
            raise RuntimeError("commit failed")
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, "_git", fail)
    new = TEXT.replace("中文", "英文")
    with pytest.raises(RuntimeError, match="commit failed"):
        repo.publish("productivity", "course", TEXT, new, "correction")
    assert repo.read("productivity", "course") == TEXT
    assert not repo.journal.exists()
    monkeypatch.setattr(repo, "_git", original)
    commit = repo.publish("productivity", "course", TEXT, new, "correction")
    assert repo.publish("productivity", "course", TEXT, new, "retry") == commit
    assert len(repo.history("productivity", "course")) == 2


def test_first_commit_failure_leaves_no_memory(tmp_path, monkeypatch):
    repo = MemoryRepository(tmp_path)
    original = repo._git

    def fail(*args, **kwargs):
        if args[0] == "commit":
            raise RuntimeError("commit failed")
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, "_git", fail)
    with pytest.raises(RuntimeError):
        repo.publish("productivity", "course", "", TEXT, "first")
    assert not repo.path("productivity", "course").exists()
    assert repo._git("ls-files") == ""


def test_undo_middle_change_preserves_later_preference(tmp_path):
    repo = MemoryRepository(tmp_path)
    repo.publish("productivity", "course", "", TEXT, "A")
    wrong = TEXT.replace("中文", "英文")
    commit = repo.publish("productivity", "course", TEXT, wrong, "B")
    latest = wrong + "- 列出修改文件。\n"
    repo.publish("productivity", "course", wrong, latest, "C")
    repo.revert("productivity", "course", commit)
    restored = repo.read("productivity", "course")
    assert "默认中文解释。" in restored and "默认英文解释。" not in restored
    assert "- 列出修改文件。\n" in restored
    assert len(repo.history("productivity", "course")) == 4


def test_windows_line_endings_survive_unrelated_edit(tmp_path):
    from cleo.memory.markdown import Edit, apply_edits

    repo = MemoryRepository(tmp_path)
    original = "# 用户偏好\r\n- 中文解释。\r\n- 列出文件。\r\n"
    repo.publish("productivity", "course", "", original, "initial")
    assert repo.read("productivity", "course") == original
    candidate = apply_edits(original, [Edit(old="中文解释。", new="英文解释。")])
    repo.publish("productivity", "course", original, candidate, "change")
    assert repo.path("productivity", "course").read_bytes() == candidate.encode("utf-8")


@pytest.mark.parametrize("after_commit", [False, True])
def test_restart_recovers_interrupted_file_and_git_commit(tmp_path, monkeypatch, after_commit):
    repo = MemoryRepository(tmp_path)
    repo.publish("productivity", "course", "", TEXT, "initial")
    new = TEXT.replace("中文", "英文")
    git = repo._git

    def crash(*args, **kwargs):
        if args[0] == "commit":
            if after_commit:
                git(*args, **kwargs)
            raise KeyboardInterrupt("simulated process death")
        return git(*args, **kwargs)

    monkeypatch.setattr(repo, "_git", crash)
    with pytest.raises(KeyboardInterrupt):
        repo.publish("productivity", "course", TEXT, new, "change")
    restarted = MemoryRepository(tmp_path)
    with pytest.raises(ValueError, match="interrupted"):
        restarted.read("productivity", "course")
    restarted.recover()
    assert restarted.read("productivity", "course") == (new if after_commit else TEXT)
    restarted.publish("productivity", "course", TEXT, new, "change")
    assert len(restarted.history("productivity", "course")) == 2
    assert restarted._git("status", "--porcelain") == ""


def test_concurrent_scopes_commit_without_lost_updates(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    repo = MemoryRepository(tmp_path)
    with ThreadPoolExecutor(max_workers=2) as pool:
        calls = [
            pool.submit(repo.publish, "productivity", name, "", TEXT, name)
            for name in ("first", "second")
        ]
        assert all(call.result() for call in calls)
    for name in ("first", "second"):
        assert repo.read("productivity", name) == TEXT
    assert len(repo._git("ls-files").splitlines()) == 2


def test_parent_policy_remains_in_parent_history(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    root = tmp_path / "memory"
    root.mkdir()
    policy = root / "MEMORY_POLICY.md"
    policy.write_text("Human-owned rules")
    subprocess.run(["git", "-C", str(tmp_path), "add", "memory/MEMORY_POLICY.md"], check=True)
    repo = MemoryRepository(root)
    repo.publish("productivity", "course", "", TEXT, "preference")
    parent = subprocess.run(
        ["git", "-C", str(tmp_path), "ls-files", "--stage"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert parent.startswith("100644 ") and "160000 " not in parent
    assert policy.read_text() == "Human-owned rules"
    assert "MEMORY_POLICY.md" not in repo._git("ls-files")
