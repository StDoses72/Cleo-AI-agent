import asyncio
import json
from pathlib import Path

import pytest
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
    assert result["status"] == "complete"
    assert result["excluded_conflict_groups"] == 1
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
        rows = [json.loads(row) for row in prompt.split("Evidence records:\n")[1].splitlines()]
        ref = next(row["record"] for row in rows if row.get("type") == "user_message")
        return Extraction.model_validate({"edits": [{"old": "默认中文。", "evidence_refs": [ref]}]})

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


def mixed_result(prompt):
    rows = [json.loads(row) for row in prompt.split("Evidence records:\n")[1].splitlines()]
    ref = next(row["record"] for row in rows if row.get("type") == "user_message")
    return Extraction.model_validate({
        "edits": [{"new": "Default Chinese.", "evidence_refs": [ref]},
                  {"new": "Show changed files.", "evidence_refs": [ref]}],
        "conflicts": [{"preferences": ["Default English.", "Default Chinese."],
                       "question": "Insufficient evidence for a language change."}],
    })


@pytest.mark.parametrize("after_commit", [False, True])
def test_uncertain_candidate_does_not_swallow_valid_edit_across_publication_retry(
    tmp_path, monkeypatch, after_commit,
):
    _, _, repo = environment(tmp_path, monkeypatch, "# User Preferences\n- Default English.\n")
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        return mixed_result(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    publish = MemoryRepository.publish

    def interrupted(self, *args):
        if after_commit:
            publish(self, *args)
        raise OSError("publication interrupted")

    monkeypatch.setattr(MemoryRepository, "publish", interrupted)
    with pytest.raises(OSError, match="publication interrupted"):
        asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    path = repo.path("productivity", "course").parent / "sessions/s1/dream.json"
    checkpoint = json.loads(path.read_text())
    assert checkpoint["committed_seq"] == 0
    assert checkpoint["pending"]["results"]
    monkeypatch.setattr(MemoryRepository, "publish", publish)
    result = asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    assert result["status"] == "complete" and result["skipped_uncertain_edits"] == 1
    assert len(calls) == 1
    memory = repo.read("productivity", "course")
    assert "Default English." in memory and "Show changed files." in memory
    assert "Default Chinese." not in memory
    assert json.loads(path.read_text())["pending"] is None


def test_existing_conflict_keeps_unrelated_edit_and_legacy_progress_is_replayed(
    tmp_path, monkeypatch,
):
    from cleo.memory.compaction import event_content_hash
    from cleo.memory.repository import digest

    text = "# User Preferences\n- Default English.\n- Default Chinese.\n"
    config, store, repo = environment(tmp_path, monkeypatch, text)
    events = store.read_events("s1")
    directory = repo.path("productivity", "course").parent
    (directory / ".memory-review.json").write_text(json.dumps({"conflicts": [{
        "hashes": [digest("Default English."), digest("Default Chinese.")],
        "question": "Language?",
    }]}))
    checkpoint = directory / "sessions/s1/dream.json"
    checkpoint.write_text(json.dumps({"version": 2, "committed_seq": events[-1]["seq"],
                                     "committed_hash": event_content_hash(events), "summary": "",
                                     "pending": None, "memory_hash": digest(text)}))
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        result = mixed_result(prompt)
        result.edits = result.edits[1:]
        return result

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    result = asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    assert result["status"] == "complete" and result["excluded_conflict_groups"] == 1
    assert "Show changed files." in repo.read("productivity", "course")
    rows = MemoryReader(config.MEMORY_DIR).search_long_term_memory(
        space="productivity", project="course",
    )["results"]
    assert [row["content"] for row in rows] == ["Show changed files."]
    assert asyncio.run(dream_module.DreamAgent().invoke(
        "s1", "course", "productivity",
    ))["status"] == "skipped"
    assert len(calls) == 1


def test_concurrent_edit_rechecks_latest_memory_without_overwrite(tmp_path, monkeypatch):
    _, _, repo = environment(tmp_path, monkeypatch, "# User Preferences\n- Default English.\n")
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        if len(calls) == 1:
            repo.path("productivity", "course").write_text(
                "# User Preferences\n- Default English.\n- Preserve manual changes.\n",
            )
        return mixed_result(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(ValueError, match="memory changed since extraction"):
        asyncio.run(dream_module.DreamAgent().invoke("s1", "course", "productivity"))
    assert asyncio.run(dream_module.DreamAgent().invoke(
        "s1", "course", "productivity",
    ))["status"] == "complete"
    assert "Preserve manual changes." in calls[-1]
    assert "Preserve manual changes." in repo.read("productivity", "course")
