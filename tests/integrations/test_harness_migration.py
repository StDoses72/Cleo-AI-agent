import json
import os
from pathlib import Path

import pytest

from cleo.integrations import harness_migration as migration


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.mark.skipif(os.name != "posix", reason="POSIX executable permission bits")
def test_migrated_skill_script_keeps_rwx_without_privilege_bits(tmp_path):
    source, target = tmp_path / "retired", tmp_path / "native"
    script = write(source / "skills/helper/scripts/run.sh", "#!/bin/sh\necho helper\n")
    script.chmod(0o6751)
    report = migration.migrate_native_home("codex", source, target)
    copied = target / script.relative_to(source)
    assert report["files"][script.relative_to(source).as_posix()]["status"] == "verified"
    assert copied.stat().st_mode & 0o7777 == 0o751
    assert copied.read_bytes() == script.read_bytes()
    assert script.stat().st_mode & 0o7777 == 0o6751


def codex(root, identifier="session-1", folder="sessions/2026/10/27"):
    return write(root / folder / f"rollout-{identifier}.jsonl", json.dumps({
        "type": "session_meta", "payload": {"id": identifier, "cwd": "C:/project",
        "cli_version": "0.155.1", "originator": "codex_cli_rs"}}) + "\n" + json.dumps({
        "type": "response_item", "payload": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": "Keep this history"}]}}) + "\n")


@pytest.mark.parametrize("harness", ["codex", "claude"])
def test_migration_is_verified_idempotent_and_preserves_auth_config_and_sources(tmp_path, harness):
    source, target = tmp_path / "retired", tmp_path / "native"
    transcript = codex(source) if harness == "codex" else write(
        source / "projects/C--project/session-1.jsonl",
        '{"type":"user","sessionId":"session-1","cwd":"C:/project"}\n')
    original = transcript.read_bytes()
    write(source / "auth.json", "retired account")
    write(source / "config.toml", 'model_provider="retired-account"')
    write(source / "state_5.sqlite", "not portable")
    write(target / "auth.json", "native account")
    skill = write(source / "skills/helper/SKILL.md", "User skill")
    write(source / "skills/helper/scripts/run.py", "print('helper')")
    write(source / "skills/helper/.env", "PRIVATE_KEY=sentinel")
    write(source / "skills/helper/auth.json", "private credential")
    for _ in range(2):
        report = migration.migrate_native_home(harness, source, target)
        assert report["files"][transcript.relative_to(source).as_posix()]["status"] == "verified"
        assert (target / transcript.relative_to(source)).read_bytes() == original
        assert (target / skill.relative_to(source)).read_text() == "User skill"
        assert (target / "skills/helper/scripts/run.py").read_text() == "print('helper')"
        assert not (target / "skills/helper/.env").exists()
        assert not (target / "skills/helper/auth.json").exists()
        assert (target / "auth.json").read_text() == "native account"
        assert not (target / "config.toml").exists()
        assert not (target / "state_5.sqlite").exists()
        assert transcript.read_bytes() == original
        assert report["originals_retained"]
    assert json.loads((source / migration.REPORT).read_text())["resume_verification"] == \
        "required_on_open"


def test_same_id_in_another_native_path_conflicts_but_unrelated_history_migrates(tmp_path):
    source, target = tmp_path / "retired", tmp_path / "native"
    conflicted = codex(source)
    existing = codex(target, folder="archived_sessions")
    existing.write_text(existing.read_text().replace('Keep this history', 'Divergent history'))
    before = existing.read_bytes()
    other = codex(source, "session-2")
    report = migration.migrate_native_home("codex", source, target)
    assert report["files"][conflicted.relative_to(source).as_posix()]["status"] == "conflict"
    assert not (target / conflicted.relative_to(source)).exists()
    assert existing.read_bytes() == before
    assert (target / other.relative_to(source)).exists()


def test_interrupted_publication_and_restart_retry(tmp_path, monkeypatch):
    source, target = tmp_path / "retired", tmp_path / "native"
    transcript = codex(source)
    real_link = migration.os.link
    def full_disk(*args):
        raise OSError("disk full")
    monkeypatch.setattr(migration.os, "link", full_disk)
    report = migration.migrate_native_home("codex", source, target)
    key = transcript.relative_to(source).as_posix()
    assert report["files"][key]["status"] == "retry"
    assert not list(target.rglob(".cleo-migrate-*"))
    monkeypatch.setattr(migration.os, "link", real_link)
    migration._done.clear()
    migration.ensure_migrated("codex", source, target)
    assert (target / key).read_bytes() == transcript.read_bytes()
    assert json.loads((source / migration.REPORT).read_text())["files"][key]["status"] == "verified"


def test_concurrent_native_file_wins(tmp_path, monkeypatch):
    source, target = tmp_path / "retired", tmp_path / "native"
    transcript = codex(source)
    real_link = migration.os.link
    def race(src, dst):
        Path(dst).write_text("native writer wins")
        return real_link(src, dst)
    monkeypatch.setattr(migration.os, "link", race)
    report = migration.migrate_native_home("codex", source, target)
    key = transcript.relative_to(source).as_posix()
    assert report["files"][key]["status"] == "conflict"
    assert (target / key).read_text() == "native writer wins"


def test_invalid_transcript_retained_and_valid_other_files_published(tmp_path):
    source, target = tmp_path / "retired", tmp_path / "native"
    write(source / "sessions/broken.jsonl", "partial json")
    write(source / "skills/helper/SKILL.md", "portable")
    report = migration.migrate_native_home("codex", source, target)
    assert report["files"]["sessions/broken.jsonl"]["status"] == "retry"
    assert (target / "skills/helper/SKILL.md").read_text() == "portable"
    assert not (target / "sessions/broken.jsonl").exists()


def test_verified_copy_before_report_failure_is_recovered(tmp_path, monkeypatch):
    source, target = tmp_path / "retired", tmp_path / "native"
    transcript = codex(source)
    real_replace = Path.replace
    def fail_report(path, dest):
        if Path(dest).name == migration.REPORT:
            raise OSError("interrupted report publication")
        return real_replace(path, dest)
    monkeypatch.setattr(Path, "replace", fail_report)
    with pytest.raises(OSError):
        migration.migrate_native_home("codex", source, target)
    assert not list(source.glob(".cleo-report-*"))
    monkeypatch.setattr(Path, "replace", real_replace)
    report = migration.migrate_native_home("codex", source, target)
    assert report["files"][transcript.relative_to(source).as_posix()]["status"] == "verified"


def test_native_continuation_after_migration_is_not_a_restart_conflict(tmp_path):
    source, target = tmp_path / "retired", tmp_path / "native"
    original = codex(source)
    migration.migrate_native_home("codex", source, target)
    published = target / original.relative_to(source)
    published.write_text(published.read_text() + '{"type":"event_msg","payload":{}}\n')
    continued = published.read_bytes()
    migration._done.clear()
    report = migration.migrate_native_home("codex", source, target)
    assert report["files"][original.relative_to(source).as_posix()]["status"] == "verified"
    assert published.read_bytes() == continued
    assert original.read_bytes() != continued


def test_resume_rechecks_legacy_append_after_process_migration(tmp_path, monkeypatch):
    source, target = tmp_path / "cleo/data/codex", tmp_path / "native"
    monkeypatch.setenv("CODEX_HOME", str(target))
    original = codex(source)
    migration.ensure_migrated("codex", source, target)
    migration.check_resume_migration("codex", "session-1")
    copied = target / original.relative_to(source)
    before = copied.read_bytes()
    original.write_text(original.read_text() + '{"type":"event_msg","payload":{}}\n')
    with pytest.raises(RuntimeError, match="migration conflict"):
        migration.check_resume_migration("codex", "session-1")
    assert copied.read_bytes() == before
    assert original.read_bytes() != before


def test_resume_accepts_native_continuation_without_recopying(tmp_path, monkeypatch):
    source, target = tmp_path / "cleo/data/codex", tmp_path / "native"
    monkeypatch.setenv("CODEX_HOME", str(target))
    original = codex(source)
    migration.ensure_migrated("codex", source, target)
    copied = target / original.relative_to(source)
    copied.write_text(copied.read_text() + '{"type":"event_msg","payload":{}}\n')
    migration._done.clear()
    migration.check_resume_migration("codex", "session-1")
    assert copied.read_bytes().startswith(original.read_bytes())


def test_resume_rechecks_native_replacement_and_restores_deleted_copy(tmp_path, monkeypatch):
    source, target = tmp_path / "cleo/data/codex", tmp_path / "native"
    monkeypatch.setenv("CODEX_HOME", str(target))
    original = codex(source)
    migration.ensure_migrated("codex", source, target)
    copied = target / original.relative_to(source)
    copied.write_text(copied.read_text().replace('Keep this history', 'Divergent history'))
    with pytest.raises(RuntimeError, match="migration conflict"):
        migration.check_resume_migration("codex", "session-1")
    copied.unlink()  # Fixture-only user resolution: retry republishes from retained source.
    migration.check_resume_migration("codex", "session-1")
    assert copied.read_bytes() == original.read_bytes()
