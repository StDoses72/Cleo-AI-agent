import asyncio
from types import SimpleNamespace

import pytest

import cleo.agents.dream as dream_module
from cleo.config.settings import SettingsModel
from cleo.memory.consolidation import Extraction
from cleo.memory.repository import MemoryRepository, digest
from cleo.sessions.store import SessionStore
from scripts.migrate_memory import preview


def test_preview_isolated_and_reviewed_apply_preserves_legacy_in_git(tmp_path, monkeypatch):
    config = SettingsModel.model_validate(
        {
            "active_profiles": {"agent": "test", "dream_agent": "test"},
            "profiles": {
                "agents": {"test": {"provider": "openai", "model": "test", "api_key": "fake"}},
                "directories": {"default": {"root_dir": str(tmp_path / "source")}},
            },
        }
    )
    monkeypatch.setattr(dream_module, "settings", config)
    monkeypatch.setattr("cleo.config.settings.settings", config)
    monkeypatch.setattr(dream_module.DreamAgent, "_configure", lambda *_: None)
    store = SessionStore(config.MEMORY_DIR)
    store.create_session(
        session_id="old", space="productivity", project="course", provider="cleo", owner_type="user"
    )
    store.append_event(
        session_id="old",
        space="productivity",
        project="course",
        event_type="user_message",
        actor="user",
        content="Check facts only.",
    )
    repository = MemoryRepository(config.MEMORY_DIR)
    path = repository.path("productivity", "course")
    path.write_text("# Project Memory\n## Facts\n- Tests passed.\n", encoding="utf-8")
    before = path.read_bytes()
    args = SimpleNamespace(
        source_root=config.MEMORY_DIR,
        space="productivity",
        project="course",
        sessions="",
        output=tmp_path / "preview.md",
        apply_reviewed=None,
        expected_hash=None,
    )

    async def empty(self, prompt):
        assert "Tests passed." not in prompt  # Legacy extracted prose is not source evidence.
        return Extraction()

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", empty)
    asyncio.run(preview(args))
    assert path.read_bytes() == before
    assert not (config.MEMORY_DIR / ".git").exists()
    assert args.output.read_text() == ""
    assert not list(tmp_path.glob("memory-migration-*"))
    args.apply_reviewed = args.output
    args.expected_hash = "wrong"
    with pytest.raises(ValueError, match="hash"):
        asyncio.run(preview(args))
    args.expected_hash = digest(repository.read("productivity", "course"))
    asyncio.run(preview(args))
    assert repository.read("productivity", "course") == ""
    assert len(repository.history("productivity", "course")) == 2
    assert "Tests passed." in repository._git(
        "show", "HEAD^:productivity/projects/course/MEMORY.md"
    )
