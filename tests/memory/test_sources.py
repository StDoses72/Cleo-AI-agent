import asyncio
import json
from pathlib import Path

import pytest

from cleo.memory.source_settings import (
    read_source_settings,
    save_source_settings,
    sync_instructions,
)
from cleo.memory.sources import SOURCE_TOOLS, MemorySources


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="")
    return path


def setup_sources(tmp_path, monkeypatch):
    codex, claude = tmp_path / "codex", tmp_path / "claude"
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    root = tmp_path / "cleo" / "memory"
    root.mkdir(parents=True)
    return MemorySources(root), codex, claude


def test_sources_distinguish_readability_configuration_and_generation(tmp_path, monkeypatch):
    sources, codex, claude = setup_sources(tmp_path, monkeypatch)
    write(codex / "memories" / "memory_summary.md", "Known reference")
    write(codex / "config.toml", "[features]\nmemories = false\n")
    write(claude / "settings.json", '{"autoMemoryEnabled": true}')
    write(sources.config_path.parent / "harnesses.json",
          '{"providers":{"native":{"type":"codex_sdk"}}}')
    state = {source["id"]: source for source in sources.list_memory_sources()["sources"]}
    assert state["codex"]["readable_memory"] and state["codex"]["configured"]
    assert state["codex"]["native_auto_update"]["generation"] == "disabled"
    assert state["codex"]["native_auto_update"]["external_context_eligible"] is None
    assert state["claude"]["native_auto_update"]["generation"] == "configured_enabled"
    assert not state["claude"]["readable_memory"]
    assert not state["claude"]["native_auto_update"]["verified_running"]


def test_directory_and_utf8_pages_preserve_scope_versions_and_original(tmp_path, monkeypatch):
    sources, codex, _ = setup_sources(tmp_path, monkeypatch)
    content = "用户偏好🙂\n" * 30
    path = write(codex / "memories" / "MEMORY.md", content)
    directory = sources.browse_memory_source("codex")
    item = directory["entries"][0]
    offset, parts = 0, []
    while offset is not None:
        page = sources.read_memory_source("codex", item["entry"], item["version"], offset, 17)
        assert page["status"] == "ok"
        assert page["reference"] == str(path)
        assert page["trust"] == "reference_only"
        parts.append(page["content"])
        offset = page["next_offset"]
    assert "".join(parts) == content
    assert path.read_text(encoding="utf-8") == content
    path.write_text("changed", encoding="utf-8")
    assert sources.read_memory_source("codex", item["entry"], item["version"])["status"] == "stale"


def test_history_filter_is_exact_and_credentials_are_not_readable(tmp_path, monkeypatch):
    sources, codex, _ = setup_sources(tmp_path, monkeypatch)
    project = str(tmp_path / "project")
    write(codex / "sessions" / "one.jsonl", json.dumps({
        "type": "session_meta", "payload": {"id": "one", "cwd": project}}) + "\n")
    write(codex / "auth.json", '{"token":"not-readable"}')
    assert sources.browse_memory_source("codex", project_path=project)["total"] == 1
    assert sources.browse_memory_source("codex", project_path=project + "-other")["total"] == 0
    for entry in ("auth.json", "../secret.md", "/absolute.md"):
        assert sources.read_memory_source("codex", entry)["status"] == "no_match"


def test_manual_sources_revocation_and_sync_are_independent(tmp_path, monkeypatch):
    sources, _, _ = setup_sources(tmp_path, monkeypatch)
    manual = tmp_path / "notes"
    write(manual / "summary.md", "Scoped notes")
    settings = {"sync_enabled": False, "sources": [
        {"id": "notes", "kind": "markdown", "root": str(manual),
         "project_path": str(tmp_path / "work")}], "disabled_sources": []}
    save_source_settings(sources.config_path, settings)
    assert sources.browse_memory_source("notes")["total"] == 1
    assert sync_instructions(sources.config_path) == ""
    settings["sync_enabled"] = True
    save_source_settings(sources.config_path, settings)
    prompt = sync_instructions(sources.config_path)
    for requirement in (
        "unchanged", "disabled/unknown", "reading fails", "independent new evidence",
        "timestamps", "prove no write", "never edit generated memories",
    ):
        assert requirement in prompt
    settings["disabled_sources"] = ["notes"]
    save_source_settings(sources.config_path, settings)
    with pytest.raises(ValueError, match="disabled"):
        sources.read_memory_source("notes", "summary.md")
    assert read_source_settings(sources.config_path)["sync_enabled"]
    assert (manual / "summary.md").read_text() == "Scoped notes"


def test_unavailable_invalid_format_and_failed_settings_write(tmp_path, monkeypatch):
    sources, codex, _ = setup_sources(tmp_path, monkeypatch)
    assert sources.browse_memory_source("codex")["status"] == "unavailable"
    path = write(codex / "memories" / "broken.md", "initial")
    path.write_bytes(b"\xff")
    result = sources.read_memory_source("codex", "memories/broken.md")
    assert result["status"] == "unsupported_format"
    save_source_settings(sources.config_path, {"sync_enabled": False})
    before = sources.config_path.read_bytes()
    monkeypatch.setattr("cleo.memory.source_settings.os.replace",
                        lambda *_args: (_ for _ in ()).throw(OSError("interrupted")))
    with pytest.raises(OSError, match="interrupted"):
        save_source_settings(sources.config_path, {"sync_enabled": True})
    assert sources.config_path.read_bytes() == before
    assert not list(sources.config_path.parent.glob(".memory-sources-*"))


def test_same_read_tools_available_without_dream_or_agent_configuration(tmp_path):
    from cleo.mcp.memory_server import create_server
    server = create_server(str(tmp_path / "memory"))
    tools = asyncio.run(server.list_tools())
    assert set(SOURCE_TOOLS) <= {tool.name for tool in tools}
    assert not (tmp_path / "config" / "cleo.json").exists()


def test_persona_upgrade_preserves_opaque_data_without_reading_or_importing(tmp_path, monkeypatch):
    from cleo.config.settings import DirectoryProfile
    from cleo.memory.overview import build_memory_overview
    root = tmp_path / "memory"
    root.mkdir()
    persona = root / "persona.sqlite3"
    persona.write_bytes(b"legacy database: deliberately not valid SQLite")
    projection = write(tmp_path / "PERSONA.md", "A legacy trait")
    original_read = Path.read_text

    def guard(path, *args, **kwargs):
        assert path not in {persona, projection}
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", guard)
    profile = DirectoryProfile(root_dir=tmp_path, persona_path="PERSONA.md")
    assert "persona_path" not in profile.model_dump()
    assert build_memory_overview(memory_root=root)["entries"] == []
    assert persona.read_bytes() == b"legacy database: deliberately not valid SQLite"
    assert projection.read_bytes() == b"A legacy trait"


def test_native_memory_scope_uses_recorded_project_metadata(tmp_path, monkeypatch):
    from cleo.sessions.store import SessionStore
    sources, _, claude = setup_sources(tmp_path, monkeypatch)
    cwd = str(tmp_path / "work")
    store = SessionStore(sources.root)
    store.create_session(session_id="one", space="productivity", project="work",
                         provider="codex", owner_type="user", cwd=cwd)
    write(sources.root / "productivity/projects/work/MEMORY.md", "# User Preferences\n")
    write(claude / "projects/ambiguous-sanitized-name/session.jsonl",
          json.dumps({"sessionId": "native-one", "cwd": cwd}) + "\n")
    write(claude / "projects/ambiguous-sanitized-name/memory/MEMORY.md", "Native notes")
    for source_id in ("cleo", "claude"):
        result = sources.browse_memory_source(source_id, project_path=cwd)
        assert any(entry["kind"] in {"memory", "summary"} for entry in result["entries"])
        assert all(cwd in entry["scope"]["project_paths"] for entry in result["entries"])
        assert sources.browse_memory_source(source_id, project_path=cwd + "-other")["total"] == 0


def test_direct_native_read_does_not_scan_other_history(tmp_path, monkeypatch):
    sources, codex, _ = setup_sources(tmp_path, monkeypatch)
    write(codex / "memories/MEMORY.md", "Current native memory")
    write(codex / "sessions/unrelated.jsonl", "unrelated history")
    monkeypatch.setattr(sources, "_entries", lambda *_: pytest.fail("No directory scan per read"))
    monkeypatch.setattr(sources, "_history_project", lambda *_: pytest.fail("No unrelated logs"))
    assert sources.read_memory_source("codex", "memories/MEMORY.md")["status"] == "ok"
