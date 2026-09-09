import asyncio
import json
from pathlib import Path

from langchain_core.messages import HumanMessage

import cleo.agents.dream as dream_module
from cleo.config.settings import SettingsModel
from cleo.memory.consolidation import Extraction
from cleo.memory.reader import MemoryReader, preference_context
from cleo.memory.repository import MemoryRepository
from cleo.sessions.store import SessionStore


def environment(tmp_path, monkeypatch, text):
    config = SettingsModel.model_validate(
        {
            "active_profiles": {"agent": "test", "dream_agent": "test"},
            "profiles": {
                "agents": {"test": {"provider": "openai", "model": "test", "api_key": "fake"}},
                "directories": {"default": {"root_dir": str(tmp_path)}},
            },
        }
    )
    monkeypatch.setattr(dream_module, "settings", config)
    monkeypatch.setattr("cleo.config.settings.settings", config)
    monkeypatch.setattr(dream_module.DreamAgent, "_configure", lambda *_: None)
    store = SessionStore(config.MEMORY_DIR, config.SESSION_INDEX_PATH)
    store.sync_langchain_messages(
        session_id="s1",
        space="productivity",
        project="course",
        messages=[HumanMessage(content="整理", id="u1")],
    )
    repo = MemoryRepository(config.MEMORY_DIR)
    path = repo.path("productivity", "course")
    path.write_text(text, encoding="utf-8", newline="")
    return config, store, repo


def test_unresolved_conflict_masks_only_conflicting_entries_then_resolves(tmp_path, monkeypatch):
    text = "# 用户偏好\n- 默认英文。\n- 列出修改文件。\n- 默认中文。\n"
    config, store, repo = environment(tmp_path, monkeypatch, text)

    async def conflict(self, prompt):
        return Extraction.model_validate(
            {
                "conflicts": [
                    {
                        "preferences": ["默认英文。", "默认中文。"],
                        "question": "默认使用哪种语言？",
                    }
                ]
            }
        )

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", conflict)
    result = asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    assert result["status"] == "needs_clarification"
    assert repo.read("productivity", "course") == text
    context = preference_context(config.MEMORY_DIR, "productivity", "course")
    assert "列出修改文件。" in context
    # Questions can describe the ambiguity; the effective preference list cannot contain it.
    reader = MemoryReader(config.MEMORY_DIR)
    assert [
        r["content"]
        for r in reader.search_long_term_memory(space="productivity", project="course")["results"]
    ] == ["列出修改文件。"]
    assert repo.history("productivity", "course") == []

    async def resolve(self, prompt):
        return Extraction.model_validate({"edits": [{"old": "默认中文。"}]})

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", resolve)
    store.append_event(
        session_id="s1",
        space="productivity",
        project="course",
        event_type="user_message",
        actor="user",
        content="默认英文，删除中文。",
    )
    store.refresh_compact("s1")
    result = asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    assert result["status"] == "complete"
    assert repo.read("productivity", "course") == text.replace("- 默认中文。\n", "")
    assert not repo.path("productivity", "course").with_name(".memory-review.json").exists()
    checkpoint = repo.path("productivity", "course").parent / "sessions/s1/dream.json"
    assert json.loads(checkpoint.read_text())["pending"] is None


def test_fact_only_noop_creates_no_fact_entries_or_memory_copy(tmp_path, monkeypatch):
    config, _, repo = environment(tmp_path, monkeypatch, "")

    async def empty(self, prompt):
        return Extraction()

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", empty)
    result = asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    assert result["status"] == "complete" and result["commit"] is None
    assert repo.read("productivity", "course") == ""
    assert not list(Path(config.MEMORY_DIR).rglob("memory.json"))
    assert MemoryReader(config.MEMORY_DIR).search_long_term_memory()["results"] == []


def test_manual_resolution_of_one_conflict_does_not_mask_its_remaining_value(tmp_path):
    from cleo.memory.repository import digest, read_conflicts

    path = tmp_path / '.memory-review.json'
    path.write_text(json.dumps({'conflicts': [
        {'hashes': [digest('English'), digest('Chinese')], 'question': 'Language?'},
        {'hashes': [digest('Short'), digest('Long')], 'question': 'Length?'},
    ]}), encoding='utf-8')
    assert read_conflicts(path, ['English', 'Short', 'Long', 'Unrelated']) == [
        {'preferences': ['Short', 'Long'], 'question': 'Length?'},
    ]
