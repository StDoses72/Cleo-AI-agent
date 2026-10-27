import asyncio

import pytest

from cleo.memory.source_settings import validate_source_settings
from cleo.memory.sources import MemorySources


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def sources(tmp_path, monkeypatch):
    codex, claude = tmp_path / "codex", tmp_path / "claude"
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    return MemorySources(tmp_path / "cleo/memory"), codex, claude


@pytest.mark.parametrize("bad", [None, [], {"sources": None}, {"sources": [None]},
                                  {"sources": [{"id": []}]}, {"disabled_sources": [[]]},
                                  {"sources": [{"id": "notes", "root": None}]}])
def test_invalid_source_settings_fail_with_validation_error(bad):
    with pytest.raises(ValueError):
        validate_source_settings(bad)


def test_invalid_source_configuration_is_not_ignored_or_reenabled(tmp_path, monkeypatch):
    service, codex, _ = sources(tmp_path, monkeypatch)
    write(codex / "memories/MEMORY.md", "private notes")
    write(service.config_path, '{"sources":[null]}')
    result = service.list_memory_sources()
    assert result["sources"] == []
    assert result["errors"]


def test_bad_discovery_member_does_not_hide_other_configured_sources(tmp_path, monkeypatch):
    service, _, _ = sources(tmp_path, monkeypatch)
    write(service.config_path.parent / "harnesses.json", '{"providers":{"broken":null,'
          '"valid":{"type":"codex_sdk"},"badType":{"type":[]}}}')
    write(service.config_path.parent / "cleo.json", "[]")
    result = service.list_memory_sources()
    assert next(item for item in result["sources"] if item["id"] == "codex")["configured"]
    assert len(result["errors"]) == 3


@pytest.mark.parametrize("settings", ["[]", "null", '{"features":[]}'])
def test_malformed_native_settings_preserve_readable_memory(tmp_path, monkeypatch, settings):
    service, _, claude = sources(tmp_path, monkeypatch)
    write(claude / "projects/demo/memory/MEMORY.md", "readable notes")
    write(claude / "settings.json", settings)
    state = next(item for item in service.list_memory_sources()["sources"]
                 if item["id"] == "claude")
    assert state["readable_memory"]
    assert state["native_auto_update"]["generation"] == "unknown"
    if settings != '{"features":[]}':
        assert state["status"] == "partial"


def test_codex_wrong_toml_table_type_is_partial_not_disabled(tmp_path, monkeypatch):
    service, codex, _ = sources(tmp_path, monkeypatch)
    write(codex / "config.toml", 'features = []\n')
    write(codex / "memories/MEMORY.md", "readable")
    state = next(item for item in service.list_memory_sources()["sources"]
                 if item["id"] == "codex")
    assert state["status"] == "partial" and state["readable_memory"]


def test_bad_transcript_record_is_partial_and_other_entries_remain_readable(tmp_path, monkeypatch):
    service, codex, _ = sources(tmp_path, monkeypatch)
    write(codex / "sessions/broken.jsonl", 'null\n')
    write(codex / "memories/MEMORY.md", "valid entry")
    directory = service.browse_memory_source("codex")
    assert directory["status"] == "partial"
    assert [item["entry"] for item in directory["entries"]] == ["memories/MEMORY.md"]
    assert directory["errors"][0]["entry"] == "sessions/broken.jsonl"
    assert service.read_memory_source("codex", "sessions/broken.jsonl")["status"] == "read_error"
    assert service.read_memory_source("codex", "memories/MEMORY.md")["content"] == "valid entry"


def test_symlinks_cannot_expose_files_or_scope_outside_native_source(tmp_path, monkeypatch):
    service, _, claude = sources(tmp_path, monkeypatch)
    folder = claude / "projects/demo"
    write(folder / "memory/MEMORY.md", "safe memory")
    outside = write(tmp_path / "private.jsonl", '{"cwd":"private-project"}\n')
    try:
        (folder / "linked.jsonl").symlink_to(outside)
        (folder / "memory/linked.md").symlink_to(outside)
    except OSError:
        pytest.skip("Symlink privilege is unavailable")
    result = service.browse_memory_source("claude")
    assert [item["entry"] for item in result["entries"]] == ["projects/demo/memory/MEMORY.md"]
    assert result["entries"][0]["scope"]["project_paths"] == []
    assert service.read_memory_source("claude", "projects/demo/memory/linked.md")["status"] == \
        "no_match"


def test_migration_conflict_blocks_resuming_wrong_history(tmp_path, monkeypatch):
    from cleo.integrations.harness_migration import migrate_native_home, migration_summary
    from cleo.integrations.harnesses.codex import CodexProvider
    from tests.integrations.test_harness_migration import codex

    legacy, target = tmp_path / "cleo/data/codex", tmp_path / "native"
    monkeypatch.setenv("CODEX_HOME", str(target))
    codex(legacy)
    existing = codex(target, folder="archived_sessions")
    existing.write_text(existing.read_text().replace('Keep this history', 'Divergent history'))
    migrate_native_home("codex", legacy, target)
    provider = CodexProvider(None)
    monkeypatch.setattr(provider, "_client_with_approvals", lambda *_a, **_kw: pytest.fail(
        "Conflicting history must be rejected before opening a native client"))
    with pytest.raises(RuntimeError, match="migration conflict"):
        asyncio.run(provider.resume_session("session-1", str(tmp_path)))
    summary = migration_summary("codex", target)
    assert summary["status_counts"]["conflict"] == 1
    assert "files" not in summary


def test_same_home_credential_aliases_are_rejected_before_read(tmp_path, monkeypatch):
    from pathlib import Path

    service, codex, _ = sources(tmp_path, monkeypatch)
    alias = write(codex / "memories/alias.md", "credential sentinel")
    real_symlink = Path.is_symlink
    # Exercise the Windows policy branch without requiring symlink creation privileges.
    monkeypatch.setattr(Path, "is_symlink", lambda path: path == alias or real_symlink(path))
    assert service.browse_memory_source("codex")["total"] == 0
    assert service.read_memory_source("codex", "memories/alias.md")["status"] == "no_match"


def test_named_harness_usage_maps_to_native_family(tmp_path, monkeypatch):
    service, _, _ = sources(tmp_path, monkeypatch)
    write(service.config_path.parent / "harnesses.json",
          '{"providers":{"company-codex":{"type":"codex_sdk"}}}')
    write(service.root / "productivity/projects/work/sessions/one/manifest.json",
          '{"provider":"company-codex"}')
    state = service.list_memory_sources()["sources"]
    assert next(item for item in state if item["id"] == "codex")["used"]
    assert not any(item["id"] == "company-codex" for item in state)


def test_user_claude_custom_memory_directory_is_read_only_and_revocable(tmp_path, monkeypatch):
    import json

    from cleo.memory.source_settings import save_source_settings

    service, _, claude = sources(tmp_path, monkeypatch)
    custom = tmp_path / "custom-native-memory"
    note = write(custom / "MEMORY.md", "Native custom notes")
    settings = write(claude / "settings.json", json.dumps({
        "autoMemoryDirectory": str(custom), "autoMemoryEnabled": True,
    }))
    before = {path: path.read_bytes() for path in (note, settings)}
    state = next(item for item in service.list_memory_sources()["sources"]
                 if item["id"] == "claude-auto-memory")
    assert state["origin"] == str(settings)
    assert state["configured"] and state["detected"] and state["readable_memory"]
    assert not state["manual"]
    assert state["native_auto_update"]["generation"] == "unknown"
    directory = service.browse_memory_source("claude-auto-memory")
    assert directory["entries"][0]["scope"]["native_scope"] == "unknown"
    assert directory["entries"][0]["scope"]["project_path"] is None
    assert service.read_memory_source("claude-auto-memory", "MEMORY.md")["content"] == \
        "Native custom notes"
    save_source_settings(service.config_path, {"disabled_sources": ["claude-auto-memory"]})
    with pytest.raises(ValueError, match="disabled"):
        service.read_memory_source("claude-auto-memory", "MEMORY.md")
    assert {path: path.read_bytes() for path in before} == before
    assert list(custom.iterdir()) == [note]


@pytest.mark.parametrize("directory", ["relative-memory", "$HOME/memory", None, []])
def test_custom_memory_discovery_never_interpolates_or_reads_project_settings(
    tmp_path, monkeypatch, directory,
):
    import json

    service, _, claude = sources(tmp_path, monkeypatch)
    write(claude / "settings.json", json.dumps({"autoMemoryDirectory": directory}))
    write(claude / "projects/project/.claude/settings.json",
          json.dumps({"autoMemoryDirectory": str(tmp_path / "untrusted-project-memory")}))
    assert not any(item["id"] == "claude-auto-memory"
                   for item in service.list_memory_sources()["sources"])


def test_user_custom_memory_accepts_native_home_relative_setting(tmp_path, monkeypatch):
    service, _, claude = sources(tmp_path, monkeypatch)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    write(tmp_path / "custom-memory/MEMORY.md", "Home-relative native notes")
    write(claude / "settings.json", '{"autoMemoryDirectory":"~/custom-memory"}')
    result = service.read_memory_source("claude-auto-memory", "MEMORY.md")
    assert result["status"] == "ok"
    assert result["content"] == "Home-relative native notes"


def test_manual_source_id_does_not_duplicate_unsupported_harness(tmp_path, monkeypatch):
    from cleo.memory.source_settings import save_source_settings

    service, _, _ = sources(tmp_path, monkeypatch)
    root = tmp_path / "manual-gemini"
    write(root / "MEMORY.md", "Explicit source")
    write(service.config_path.parent / "harnesses.json",
          '{"providers":{"gemini":{"type":"acp"}}}')
    save_source_settings(service.config_path, {"sources": [
        {"id": "gemini", "kind": "markdown", "root": str(root)},
    ]})
    matching = [item for item in service.list_memory_sources()["sources"]
                if item["id"] == "gemini"]
    assert len(matching) == 1 and matching[0]["status"] == "available"
    with pytest.raises(ValueError, match="unique"):
        save_source_settings(service.config_path, {"sources": [
            {"id": "claude-auto-memory", "root": str(root)},
        ]})
