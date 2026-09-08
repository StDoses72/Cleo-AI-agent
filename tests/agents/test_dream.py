import asyncio
import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import SecretStr, ValidationError

import cleo.agents.dream as dream_module
from cleo.config.settings import SettingsModel
from cleo.memory.consolidation import Extraction
from cleo.memory.state import get_session_source
from cleo.memory.store import search_memories
from cleo.sessions.store import SessionStore


def setup(tmp_path, monkeypatch, text="Remember this decision"):
    config = SettingsModel.model_validate({
        "active_profiles": {"agent": "primary", "dream_agent": "primary"},
        "profiles": {
            "agents": {"primary": {
                "provider": "openai", "model": "test-model", "api_key": "test-key",
            }},
            "directories": {"default": {"root_dir": str(tmp_path)}},
        },
    })
    monkeypatch.setattr(dream_module, "settings", config)
    monkeypatch.setattr("cleo.config.settings.settings", config)
    monkeypatch.setattr(dream_module.DreamAgent, "_configure", lambda *_: None)
    store = SessionStore(config.MEMORY_DIR, config.SESSION_INDEX_PATH)
    store.sync_langchain_messages(
        session_id="session-dream", space="productivity", project="cleo",
        messages=[HumanMessage(content=text, id="human-1")], status="completed",
    )
    return config, store


def invoke(agent):
    return asyncio.run(agent.invoke("session-dream", "cleo", "productivity"))


def extracted(prompt, *, subject="Stored decision"):
    line = prompt.split("Evidence records:\n", 1)[1].splitlines()[0]
    row = json.loads(line)
    return Extraction.model_validate({
        "memories": [{"category": "decision", "subject": subject,
                      "content": "Use the accepted approach.",
                      "evidence_refs": [row.get("ref", row["record"])]}],
        "summary": "Keep the accepted approach.",
    })


def test_model_is_deferred_and_output_bounded(monkeypatch):
    captured = {}
    profile = SimpleNamespace(model="dream-model", provider="openai",
                              api_key=SecretStr("dream-key"), temperature=0.2,
                              base_url="https://dream.example/v1", max_tokens=100000)
    monkeypatch.setattr(dream_module, "init_chat_model",
                        lambda **options: captured.update(options))
    agent = dream_module.DreamAgent()
    assert captured == {}
    agent._configure(profile)
    assert captured["api_key"] == "dream-key"
    assert captured["max_tokens"] == 20000
    assert captured["model"] == "dream-model"


def test_completion_publishes_and_skips_unchanged_source(tmp_path, monkeypatch):
    config, _ = setup(tmp_path, monkeypatch)
    prompts = []

    async def extract(self, prompt):
        prompts.append(prompt)
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    assert invoke(dream_module.DreamAgent())["status"] == "skipped"
    assert len(prompts) == 1
    source = get_session_source("productivity", "cleo", "session-dream")
    assert source["consolidated_hash"] == source["source_hash"]
    memory = search_memories(space="productivity", project="cleo")
    assert len(memory) == 1 and memory[0]["evidence_count"] >= 1
    memory_path = config.MEMORY_DIR / "productivity/projects/cleo/MEMORY.md"
    assert "Stored decision" in memory_path.read_text()


def test_retry_reuses_completed_blocks_and_stages_before_publication(tmp_path, monkeypatch):
    config, _ = setup(tmp_path, monkeypatch, "large tool and user content " * 400)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    prompts = []
    fail = True

    async def extract(self, prompt):
        nonlocal fail
        prompts.append(prompt)
        if len(prompts) == 2 and fail:
            fail = False
            raise RuntimeError("provider unavailable")
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        invoke(dream_module.DreamAgent())
    assert search_memories(space="productivity", project="cleo") == []
    state = get_session_source("productivity", "cleo", "session-dream")
    assert state["status"] == "failed" and "1/" in state["last_error"]
    path = config.MEMORY_DIR / "productivity/projects/cleo/sessions/session-dream/dream.json"
    assert len(json.loads(path.read_text())["pending"]["results"]) == 1
    result = invoke(dream_module.DreamAgent())
    assert result["status"] == "complete"
    assert prompts.count(prompts[0]) == 1
    assert len(prompts) == result["completed_blocks"] + 1


def test_incremental_run_only_sends_new_event_text(tmp_path, monkeypatch):
    _, store = setup(tmp_path, monkeypatch, "old evidence unique marker")
    prompts = []

    async def extract(self, prompt):
        prompts.append(prompt)
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    invoke(dream_module.DreamAgent())
    store.append_event(session_id="session-dream", space="productivity", project="cleo",
                       event_type="user_message", actor="user",
                       content="new evidence unique marker")
    store.refresh_compact("session-dream")
    invoke(dream_module.DreamAgent())
    evidence = prompts[-1].split("Evidence records:\n", 1)[1]
    assert "new evidence unique marker" in evidence
    assert "old evidence unique marker" not in evidence


def test_new_events_during_run_remain_pending(tmp_path, monkeypatch):
    _, store = setup(tmp_path, monkeypatch)

    async def extract(self, prompt):
        store.append_event(session_id="session-dream", space="productivity", project="cleo",
                           event_type="user_message", actor="user", content="arrived later")
        store.refresh_compact("session-dream")
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    result = invoke(dream_module.DreamAgent())
    assert result["status"] == "pending"
    assert get_session_source("productivity", "cleo", "session-dream")["status"] == "pending"


def test_unknown_evidence_never_publishes_or_completes(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)

    async def extract(self, prompt):
        result = extracted(prompt)
        result.memories[0].evidence_refs = ["invented"]
        return result

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(ValueError, match="unknown evidence"):
        invoke(dream_module.DreamAgent())
    assert search_memories(space="productivity", project="cleo") == []
    assert get_session_source("productivity", "cleo", "session-dream")["status"] == "failed"


def test_publication_failure_retry_does_not_call_model_again(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        return extracted(prompt)

    original = dream_module.publish

    def fail_once(**kwargs):
        original(**kwargs)
        raise OSError("publication interrupted")

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    monkeypatch.setattr(dream_module, "publish", fail_once)
    with pytest.raises(OSError):
        invoke(dream_module.DreamAgent())
    monkeypatch.setattr(dream_module, "publish", original)
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    assert len(calls) == 1
    assert len(search_memories(space="productivity", project="cleo")) == 1


def test_extractor_has_no_tools_or_accumulating_messages():
    calls = []

    class Model:
        async def ainvoke(self, messages):
            calls.append(messages)
            return AIMessage(content='{"memories": [], "summary": "none"}')

    agent = dream_module.DreamAgent()
    agent.model = Model()
    asyncio.run(agent._extract("first"))
    asyncio.run(agent._extract("second"))
    assert [len(messages) for messages in calls] == [2, 2]
    assert calls[1][-1].content == "second"


def test_extractor_ignores_batch_scores_without_changing_item_scores(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)

    class Model:
        async def ainvoke(self, messages):
            payload = extracted(messages[-1].content).model_dump()
            payload.update(confidence=1.0, importance=5)
            payload["memories"][0].update(confidence=0.6, importance=2)
            return AIMessage(content=json.dumps(payload))

    agent = dream_module.DreamAgent()
    agent.model = Model()
    assert invoke(agent)["status"] == "complete"
    memory = search_memories(space="productivity", project="cleo")[0]
    assert memory["confidence"] == 0.6
    assert memory["importance"] == 2


@pytest.mark.parametrize("payload", [
    {"confidence": 1.0, "importance": 5},
    {"memories": [], "unexpected": "must not be silently ignored"},
    {"memories": [{"category": "fact", "subject": "x", "content": "y",
                   "evidence_refs": ["E1"], "confidence": 2}], "importance": 5},
])
def test_batch_score_compatibility_keeps_malformed_responses_invalid(payload):
    class Model:
        async def ainvoke(self, messages):
            return AIMessage(content=json.dumps(payload))

    agent = dream_module.DreamAgent()
    agent.model = Model()
    with pytest.raises(ValidationError):
        asyncio.run(agent._extract("source"))


def test_runtime_extraction_exposes_no_memory_write_tools(tmp_path):
    from cleo.mcp.agent_server import agent_tools

    assert agent_tools("dream_extract", str(tmp_path)) == []


def test_cancellation_retains_checkpoint_and_releases_publisher_lock(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch, "multiple blocks " * 2000)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    calls = 0

    async def extract(self, prompt):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise asyncio.CancelledError()
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(asyncio.CancelledError):
        invoke(dream_module.DreamAgent())
    assert get_session_source("productivity", "cleo", "session-dream")["status"] == "failed"
    assert invoke(dream_module.DreamAgent())["status"] == "complete"


def test_existing_narrative_survives_publication_and_retry(tmp_path, monkeypatch):
    config, _ = setup(tmp_path, monkeypatch)
    path = config.MEMORY_DIR / "productivity/projects/cleo/MEMORY.md"
    path.write_text("# Human-reviewed context\nKeep this exact decision.\n", encoding="utf-8")

    async def extract(self, prompt):
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    invoke(dream_module.DreamAgent())
    assert path.read_text().startswith("# Human-reviewed context\nKeep this exact decision.")


def test_appended_events_do_not_invalidate_retry_of_older_snapshot(tmp_path, monkeypatch):
    _, store = setup(tmp_path, monkeypatch, "old record " * 2000)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        if len(calls) == 2:
            raise RuntimeError("offline")
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(RuntimeError):
        invoke(dream_module.DreamAgent())
    store.append_event(session_id="session-dream", space="productivity", project="cleo",
                       event_type="user_message", actor="user", content="new appended record")
    store.refresh_compact("session-dream")
    assert invoke(dream_module.DreamAgent())["status"] == "pending"
    assert calls.count(calls[0]) == 1
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    assert "new appended record" in calls[-1]


def test_edited_committed_prefix_cannot_be_skipped(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch)

    async def extract(self, prompt):
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    invoke(dream_module.DreamAgent())
    path = config.MEMORY_DIR / "productivity/projects/cleo/sessions/session-dream/events.jsonl"
    path.write_text(path.read_text().replace("Remember this decision", "Changed old evidence"),
                    encoding="utf-8")
    store.refresh_compact("session-dream")
    with pytest.raises(ValueError, match="consolidated events changed"):
        invoke(dream_module.DreamAgent())


def test_cancel_during_publication_waits_for_writer_before_retry(tmp_path, monkeypatch):
    import threading

    setup(tmp_path, monkeypatch)
    entered = threading.Event()
    release = threading.Event()
    calls = []
    original = dream_module.publish

    async def extract(self, prompt):
        calls.append(prompt)
        return extracted(prompt)

    def slow_publish(**kwargs):
        entered.set()
        assert release.wait(10)
        return original(**kwargs)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    monkeypatch.setattr(dream_module, "publish", slow_publish)

    async def scenario():
        task = asyncio.create_task(dream_module.DreamAgent().invoke(
            "session-dream", "cleo", "productivity",
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert (await dream_module.DreamAgent().invoke(
            "session-dream", "cleo", "productivity",
        ))["status"] == "complete"

    asyncio.run(scenario())
    assert len(calls) == 1
