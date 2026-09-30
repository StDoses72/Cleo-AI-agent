"""Isolated skill discovery and desktop dispatch regressions."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.desktop.service import PRODUCTIVITY_COMMANDS, DesktopService
from cleo.desktop.skills import discover_skills


@pytest.fixture
def skill_home(tmp_path, monkeypatch):
    # Bound project discovery so fixtures never read real ancestor skill directories.
    (tmp_path / ".git").mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    # Harness user state lives in Cleo's fixed directories: <CLEO_HOME>/data/<harness>.
    cleo = tmp_path / "cleo"
    monkeypatch.setattr("cleo.config.settings.APP_HOME", cleo)
    # External vendor homes exist but must never feed Cleo's catalog.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "external-codex"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "external-claude"))
    return SimpleNamespace(
        home=home, codex=cleo / "data" / "codex", claude=cleo / "data" / "claude",
        external_codex=tmp_path / "external-codex", external_claude=tmp_path / "external-claude",
    )


def write_skill(root, name, text="Apply concrete examples."):
    path = root / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\n---\n{text}", encoding="utf-8")
    return path


def test_discovery_scope_collisions_and_hidden_skills(skill_home, tmp_path):
    cwd = tmp_path / "project"
    (cwd / ".git").mkdir(parents=True)
    codex = skill_home.codex / "skills"
    write_skill(codex, "eli5")
    write_skill(codex, "help")
    write_skill(codex / ".system", "internal")
    write_skill(skill_home.home / ".agents" / "skills", "shared")
    write_skill(cwd / ".codex" / "skills", "eli5", "Project instructions")
    write_skill(skill_home.claude / "skills", "claude-only")
    hidden = write_skill(codex, "hidden")
    hidden.write_text("---\nname: hidden\nuser-invocable: false\n---\nPrivate")
    entries = discover_skills("codex", str(cwd), PRODUCTIVITY_COMMANDS)
    assert {s.name for s in entries} == {"eli5", "help", "shared", "internal"}
    aliases = [s for s in entries if s.name in {"eli5", "help"}]
    assert all(s.command.startswith("/skill:") for s in aliases)
    assert len({s.command for s in entries}) == len(entries)
    assert [s.command for s in entries] == [
        s.command for s in discover_skills("codex", str(cwd), PRODUCTIVITY_COMMANDS)
    ]
    assert {s.name for s in discover_skills("claude", str(cwd), PRODUCTIVITY_COMMANDS)} == {
        "claude-only"
    }
    assert discover_skills("acp", str(cwd), PRODUCTIVITY_COMMANDS) == []


@pytest.mark.parametrize("arguments", ["", " explain recursion\nkeep this line"])
def test_loads_real_instructions_and_preserves_arguments(skill_home, tmp_path, arguments):
    path = write_skill(
        skill_home.codex / "skills", "eli5",
        "Explain using toy blocks. Read references/example.md.",
    )
    skill, = discover_skills("codex", str(tmp_path), PRODUCTIVITY_COMMANDS)
    assert skill.command == "/eli5"
    prompt = skill.expand("/eli5" + arguments)
    assert path.read_text() in prompt
    assert str(path.parent) in prompt
    assert "/eli5" + arguments in prompt
    path.unlink()
    with pytest.raises(ValueError, match="eli5"):
        skill.expand("/eli5")


def test_desktop_dispatch_uses_selected_harness_and_keeps_builtins(skill_home, tmp_path):
    write_skill(skill_home.codex / "skills", "eli5", "CODEX instructions")
    write_skill(skill_home.claude / "skills", "eli5", "CLAUDE instructions")
    write_skill(skill_home.codex / "skills", "help", "SKILL HELP")
    manifest = {"id": "session", "space": "productivity", "project": "workspace",
                "provider": "codex", "cwd": str(tmp_path)}
    service = DesktopService.__new__(DesktopService)
    service.store = SimpleNamespace(
        load_manifest=lambda _: manifest,
        update_manifest=lambda _, **changes: manifest.update(changes),
    )
    service.settings = SimpleNamespace(
        MEMORY_DIR=tmp_path / "memory", productivity=SimpleNamespace(default_provider="codex"),
    )
    service._activate = lambda _: None
    service._is_evolution = lambda _: False
    service._productivity_provider = lambda name: SimpleNamespace(type=f"{name}_sdk")
    service._run_tasks = {}
    service._steering_runs = {}
    service._runtime_locks = {}
    service._run_ids = {}
    service._pending_approvals = {}
    service._run_workspaces = {}
    service._workspace_guard = asyncio.Lock()
    service._stream_productivity = AsyncMock()
    service._run_command = AsyncMock()
    emit = AsyncMock()

    async def send(prompt):
        await service.stream_turn(thread_id="session", prompt=prompt, attachments=[], emit=emit)

    for provider, expected in [("codex", "CODEX"), ("claude", "CLAUDE"), ("codex", "CODEX")]:
        manifest["provider"] = provider
        asyncio.run(send("/eli5 explain recursion"))
        forwarded = service._stream_productivity.call_args.args[1]
        assert expected + " instructions" in forwarded
        assert "/eli5 explain recursion" in forwarded
    asyncio.run(send("/help"))
    service._run_command.assert_awaited_once_with(manifest, "/help", emit)
    help_skill = next(s for s in service._local_skills(manifest) if s.name == "help")
    asyncio.run(send(help_skill.command))
    assert "SKILL HELP" in service._stream_productivity.call_args.args[1]
    manifest["space"] = "non_productivity"
    assert service._local_skills(manifest) == []


def test_catalog_reads_only_cleo_directories(skill_home, tmp_path, monkeypatch):
    path = write_skill(skill_home.codex / "skills", "cleo-owned")
    write_skill(skill_home.external_codex / "skills", "external-codex")
    write_skill(skill_home.external_claude / "skills", "external-claude")
    write_skill(skill_home.home / ".codex" / "skills", "default-codex")
    write_skill(skill_home.home / ".claude" / "skills", "default-claude")
    entries = discover_skills("codex", str(tmp_path), PRODUCTIVITY_COMMANDS)
    assert [(s.name, s.source) for s in entries] == [("cleo-owned", "codex · Cleo")]
    assert discover_skills("claude", str(tmp_path), PRODUCTIVITY_COMMANDS) == []
    monkeypatch.delenv("CODEX_HOME")
    monkeypatch.delenv("CLAUDE_CONFIG_DIR")
    assert [s.name for s in discover_skills("codex", str(tmp_path), PRODUCTIVITY_COMMANDS)] == [
        "cleo-owned"
    ]
    assert discover_skills("claude", str(tmp_path), PRODUCTIVITY_COMMANDS) == []
    # External skills reach the menu only as imported copies (import tests cover copying);
    # the catalog itself never points at an external directory.
    for harness in ("codex", "claude"):
        for skill in discover_skills(harness, str(tmp_path), PRODUCTIVITY_COMMANDS):
            assert skill.path.is_relative_to(getattr(skill_home, harness).resolve())
    assert path.read_text().endswith("Apply concrete examples.")
    path.write_bytes(b"\xff\xfe")
    assert discover_skills("codex", str(tmp_path), PRODUCTIVITY_COMMANDS) == []
