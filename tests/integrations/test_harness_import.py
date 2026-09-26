"""Local Claude/Codex setup is copied into Cleo's own directories, additively."""

import hashlib
import json
import tomllib
from pathlib import Path

import pytest

from cleo.integrations import harness_import
from cleo.integrations.harness_import import STATE_FILE, import_external

REAL_ENSURE = harness_import.ensure_imported


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def snapshot(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*")) if path.is_file()
    }


@pytest.fixture
def claude(tmp_path):
    external = tmp_path / "user" / ".claude"
    write(external / "skills" / "shared" / "SKILL.md", "---\nname: shared\n---\nExternal")
    write(external / "skills" / "fresh" / "SKILL.md", "---\nname: fresh\n---\nFresh")
    write(external / "skills" / "fresh" / "references" / "notes.md", "resource")
    write(external / "skills" / "synced" / "abc" / "SKILL.md", "---\nname: synced\n---\nS")
    write(external / "agents" / "reviewer.md", "reviewer agent")
    write(external / "commands" / "ship.md", "ship command")
    write(external / "CLAUDE.md", "User instructions")
    write(external / ".credentials.json", '{"claudeAiOauth": "secret"}')
    write(external / "projects" / "C--work" / "old.jsonl", '{"type":"user"}\n')
    write(external / "settings.json", json.dumps({
        "model": "external-model", "theme": "dark", "effortLevel": "high",
        "enabledPlugins": {"x@y": True}, "apiKeyHelper": "print-key",
        "env": {"ANTHROPIC_API_KEY": "sk-secret", "FOO": "bar"},
        "permissions": {"allow": ["Bash(ls)"], "deny": ["Bash(rm)"]},
    }))
    home = tmp_path / "cleo" / "data" / "claude"
    write(home / "skills" / "shared" / "SKILL.md", "---\nname: shared\n---\nCleo copy")
    write(home / "settings.json", json.dumps({
        "model": "cleo-model", "permissions": {"deny": ["Bash(del)"]}, "cleoUnknown": 1,
    }))
    return external, home


def test_claude_setup_is_copied_without_overwrites_credentials_or_history(claude):
    external, home = claude
    before = snapshot(external)
    imported = import_external("claude", home, external)
    assert set(imported) == {
        "skills/fresh", "skills/synced", "agents/reviewer.md", "commands/ship.md",
        "CLAUDE.md", "settings.json:theme", "settings.json:effortLevel", "settings.json:env",
        "settings.json:permissions.allow",
    }
    assert "Cleo copy" in (home / "skills/shared/SKILL.md").read_text()
    assert (home / "skills/fresh/references/notes.md").read_text() == "resource"
    assert (home / "skills/synced/abc/SKILL.md").exists()
    assert (home / "agents/reviewer.md").read_text() == "reviewer agent"
    assert (home / "CLAUDE.md").read_text() == "User instructions"
    settings = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    assert settings == {
        "model": "cleo-model", "cleoUnknown": 1, "theme": "dark", "effortLevel": "high",
        "env": {"FOO": "bar"},
        "permissions": {"deny": ["Bash(del)"], "allow": ["Bash(ls)"]},
    }
    assert not (home / ".credentials.json").exists()
    assert not (home / "projects").exists()
    assert snapshot(external) == before
    assert not list(home.rglob(".cleo-import-*"))


def test_imports_are_idempotent_respect_removals_and_pick_up_new_items(claude):
    external, home = claude
    import_external("claude", home, external)
    assert import_external("claude", home, external) == []
    (home / "skills/fresh/SKILL.md").unlink()
    (home / "skills/fresh/references/notes.md").unlink()
    (home / "skills/fresh/references").rmdir()
    (home / "skills/fresh").rmdir()
    settings = json.loads((home / "settings.json").read_text(encoding="utf-8"))
    del settings["theme"]
    write(home / "settings.json", json.dumps(settings))
    assert import_external("claude", home, external) == []
    assert not (home / "skills/fresh").exists()
    assert "theme" not in json.loads((home / "settings.json").read_text(encoding="utf-8"))
    write(external / "skills" / "later" / "SKILL.md", "---\nname: later\n---\nLater")
    assert import_external("claude", home, external) == ["skills/later"]
    state = json.loads((home / STATE_FILE).read_text(encoding="utf-8"))
    assert "skills/fresh" in state["imported"][str(external)]


@pytest.mark.parametrize("record", ["not json", '{"version": 2, "imported": {}}'])
def test_unreadable_or_newer_import_record_is_left_alone(claude, record):
    external, home = claude
    write(home / STATE_FILE, record)
    assert import_external("claude", home, external) == []
    assert (home / STATE_FILE).read_text(encoding="utf-8") == record
    assert not (home / "skills/fresh").exists()


def test_unreadable_cleo_settings_are_not_replaced(claude):
    external, home = claude
    write(home / "settings.json", "{broken")
    imported = import_external("claude", home, external)
    assert "skills/fresh" in imported
    assert not any(item.startswith("settings.json") for item in imported)
    assert (home / "settings.json").read_text(encoding="utf-8") == "{broken"


def test_state_record_keeps_unknown_fields(claude):
    external, home = claude
    write(home / STATE_FILE, json.dumps({"version": 1, "imported": {}, "future": [1]}))
    import_external("claude", home, external)
    state = json.loads((home / STATE_FILE).read_text(encoding="utf-8"))
    assert state["future"] == [1] and state["version"] == 1


CODEX_EXTERNAL = r'''model = "gpt-5.5"
approval_policy = "on-request"
notify = ["python", "C:\\tools\\notify.py"]
model_provider = "azure"

[plugins."github@openai-curated"]
enabled = true

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
env = { TOKEN_PATH = "C:\\keys\\t" }

[projects.'c:\users\me\work']
trust_level = "trusted"

[features]
web_search = true
'''

CODEX_CLEO = r'''# Written by Codex inside Cleo
[projects.'c:\users\me\cleo']
trust_level = "trusted"

[windows]
sandbox = "elevated"

[features]
unified_exec = true
'''


def test_codex_config_merge_appends_and_preserves_the_existing_file(tmp_path):
    external = tmp_path / "user" / ".codex"
    home = tmp_path / "cleo" / "data" / "codex"
    write(external / "config.toml", CODEX_EXTERNAL)
    write(external / "auth.json", '{"tokens": "secret"}')
    write(external / "skills" / "eli5" / "SKILL.md", "---\nname: eli5\n---\nE")
    write(external / "skills" / ".system" / "own" / "SKILL.md", "system")
    write(external / "rules" / "default.rules", 'prefix_rule(pattern=["git"])')
    write(home / "config.toml", CODEX_CLEO)
    before = snapshot(external)
    imported = import_external("codex", home, external)
    assert set(imported) == {
        "skills/eli5", "rules/default.rules", "config.toml:model",
        "config.toml:approval_policy", "config.toml:notify", "config.toml:mcp_servers",
        r"config.toml:projects.c:\users\me\work",
    }
    text = (home / "config.toml").read_text(encoding="utf-8")
    assert CODEX_CLEO in text
    config = tomllib.loads(text)
    assert config["model"] == "gpt-5.5"
    assert config["notify"] == ["python", r"C:\tools\notify.py"]
    assert config["mcp_servers"]["docs"]["env"] == {"TOKEN_PATH": r"C:\keys\t"}
    assert set(config["projects"]) == {r"c:\users\me\cleo", r"c:\users\me\work"}
    assert config["windows"] == {"sandbox": "elevated"}
    # A scalar inside an existing table cannot be appended safely and is not recorded.
    assert config["features"] == {"unified_exec": True}
    assert "model_provider" not in config and "plugins" not in config
    assert not (home / "auth.json").exists()
    assert not (home / "skills" / ".system").exists()
    assert snapshot(external) == before
    assert import_external("codex", home, external) == []


def test_codex_config_is_created_and_still_read_by_cleo(tmp_path, monkeypatch):
    from cleo.integrations.codex_home import isolated_codex_config

    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    monkeypatch.setattr("cleo.integrations.codex_home.sys.platform", "win32")
    external = tmp_path / "user" / ".codex"
    write(external / "config.toml", '[windows]\nsandbox = "elevated"\n')
    home = (tmp_path / "cleo" / "data" / "codex")
    assert import_external("codex", home, external) == ["config.toml:windows"]
    assert tomllib.loads((home / "config.toml").read_text(encoding="utf-8")) == {
        "windows": {"sandbox": "elevated"},
    }
    assert not any(value.startswith("windows.sandbox=")
                   for value in isolated_codex_config().config_overrides)


def test_harness_home_imports_once_and_skill_menu_lists_cleo_copies(tmp_path, monkeypatch):
    from cleo.desktop.service import PRODUCTIVITY_COMMANDS
    from cleo.desktop.skills import discover_skills
    from cleo.integrations.harness_home import harness_home

    monkeypatch.setattr(harness_import, "ensure_imported", REAL_ENSURE)
    monkeypatch.setattr(harness_import, "_done", set())
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    monkeypatch.setattr("pathlib.Path.home", classmethod(lambda cls: tmp_path / "user"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    (tmp_path / "project" / ".git").mkdir(parents=True)
    write(tmp_path / "user/.claude/skills/grill/SKILL.md", "---\nname: grill\n---\nGrill")
    skills = discover_skills("claude", str(tmp_path / "project"), PRODUCTIVITY_COMMANDS)
    home = harness_home("claude")
    assert [(s.name, s.path) for s in skills] == [
        ("grill", (home / "skills/grill/SKILL.md").resolve()),
    ]
    write(tmp_path / "user/.claude/skills/later/SKILL.md", "---\nname: later\n---\nL")
    harness_home("claude")
    assert not (home / "skills/later").exists()  # Picked up on the next Cleo start.


def test_import_failure_never_blocks_the_harness(tmp_path, monkeypatch):
    from cleo.integrations.harness_home import harness_home

    monkeypatch.setattr(harness_import, "ensure_imported", REAL_ENSURE)
    monkeypatch.setattr(harness_import, "_done", set())
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")

    def fail(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(harness_import, "import_external", fail)
    assert harness_home("codex") == (tmp_path / "cleo" / "data" / "codex").resolve()


def test_hidden_entries_are_skipped_and_copied_item_paths_follow_the_copy(tmp_path):
    external = tmp_path / "user" / ".codex"
    home = tmp_path / "cleo" / "data" / "codex"
    write(external / "skills" / "pdf" / "SKILL.md", "---\nname: pdf\n---\nP")
    write(external / "skills" / ".trash" / "old" / "SKILL.md", "deleted")
    skill = external / "skills" / "pdf" / "SKILL.md"
    program = external / "node_repl" / "server.js"
    write(external / "config.toml", (
        f"[[skills.config]]\npath = {json.dumps(str(skill))}\nenabled = false\n\n"
        f"[mcp_servers.repl]\ncommand = \"node\"\nargs = [{json.dumps(str(program))}]\n"
    ))
    import_external("codex", home, external)
    assert not (home / "skills" / ".trash").exists()
    config = tomllib.loads((home / "config.toml").read_text(encoding="utf-8"))
    assert config["skills"]["config"] == [
        {"path": str(home / "skills" / "pdf" / "SKILL.md"), "enabled": False},
    ]
    assert config["mcp_servers"]["repl"]["args"] == [str(program)]


def test_sync_status_compares_both_sides_without_changing_anything(claude):
    from cleo.integrations.harness_import import sync_status

    external, home = claude
    write(home / "skills" / "cleo-made" / "SKILL.md", "---\nname: cleo-made\n---\nC")
    write(external / "skills" / "same" / "SKILL.md", "same")
    write(home / "skills" / "same" / "SKILL.md", "same")
    before = (snapshot(external), snapshot(home))
    status = sync_status("claude", home, external)
    states = {item["id"]: item["state"] for item in status["items"]}
    assert states["skills/shared"] == "different"
    assert states["skills/same"] == "same"
    assert states["skills/fresh"] == "local_only"
    assert states["skills/cleo-made"] == "cleo_only"
    assert states["CLAUDE.md"] == "local_only"
    assert "skills/.hidden" not in states
    assert set(status["settings"]["missingInCleo"]) == {
        "theme", "effortLevel", "env", "permissions.allow",
    }
    assert status["localExists"] and status["settings"]["file"] == "settings.json"
    assert (snapshot(external), snapshot(home)) == before


def test_explicit_import_and_export_copy_only_missing_items(claude):
    from cleo.integrations.harness_import import sync_items, sync_status

    external, home = claude
    write(home / "skills" / "cleo-made" / "SKILL.md", "---\nname: cleo-made\n---\nC")
    result = sync_items(
        "claude", home, "import", ["skills/fresh", "skills/shared"], source=external,
    )
    assert result == {"copied": ["skills/fresh"], "skipped": ["skills/shared"]}
    assert "Cleo copy" in (home / "skills/shared/SKILL.md").read_text()
    result = sync_items("claude", home, "export", ["skills/cleo-made", "skills/shared"],
                        source=external)
    assert result == {"copied": ["skills/cleo-made"], "skipped": ["skills/shared"]}
    assert (external / "skills/cleo-made/SKILL.md").read_text().endswith("C")
    assert "External" in (external / "skills/shared/SKILL.md").read_text()
    result = sync_items("claude", home, "import", [], settings=True, source=external)
    assert "settings.json:theme" in result["copied"]
    assert sync_status("claude", home, external)["settings"]["missingInCleo"] == []
    state = json.loads((home / STATE_FILE).read_text(encoding="utf-8"))
    assert "skills/fresh" in state["imported"][str(external)]
    assert not (external / ".cleo-imported.json").exists()


@pytest.mark.parametrize("item", [
    "../secrets", "skills/../../x", "skills/.hidden", "skills/a/b", "skills\a", ".credentials.json",
    "projects/x", "settings.json", "skills/C:evil", "",
])
def test_explicit_sync_rejects_unsafe_items(claude, item):
    from cleo.integrations.harness_import import sync_items

    external, home = claude
    before = (snapshot(external), snapshot(home))
    with pytest.raises(ValueError):
        sync_items("claude", home, "export", [item], source=external)
    assert (snapshot(external), snapshot(home)) == before


def test_explicit_sync_requires_local_directory_and_direction(tmp_path):
    from cleo.integrations.harness_import import sync_items

    home = tmp_path / "cleo" / "data" / "codex"
    with pytest.raises(ValueError, match="本机未找到"):
        sync_items("codex", home, "export", ["skills/x"], source=tmp_path / "missing")
    (tmp_path / "local").mkdir()
    with pytest.raises(ValueError):
        sync_items("codex", home, "sideways", [], source=tmp_path / "local")
    with pytest.raises(ValueError):
        sync_items("codex", home, "export", [], settings=True, source=tmp_path / "local")


def test_desktop_service_exposes_comparison_and_sync(tmp_path, monkeypatch):
    import asyncio

    from cleo.desktop.service import DesktopService

    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    monkeypatch.setattr("pathlib.Path.home", classmethod(lambda cls: tmp_path / "user"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    write(tmp_path / "user/.codex/skills/pdf/SKILL.md", "---\nname: pdf\n---\nP")
    service = DesktopService.__new__(DesktopService)
    statuses = asyncio.run(service.get_harness_sync())
    assert [status["harness"] for status in statuses] == ["claude", "codex"]
    assert not statuses[0]["localExists"]
    assert statuses[1]["items"] == [
        {"id": "skills/pdf", "kind": "skills", "name": "pdf", "state": "local_only"},
    ]
    result = asyncio.run(service.sync_harness_items(
        harness="codex", direction="import", items=["skills/pdf"],
    ))
    assert result == {"copied": ["skills/pdf"], "skipped": []}
    assert (tmp_path / "cleo/data/codex/skills/pdf/SKILL.md").exists()
    with pytest.raises(ValueError):
        asyncio.run(service.sync_harness_items(harness="gemini", direction="import", items=[]))
