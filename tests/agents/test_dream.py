import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import SecretStr, ValidationError

import cleo.agents.dream as dream_module
from cleo.config.settings import SettingsModel
from cleo.desktop.service import DesktopService
from cleo.memory.consolidation import Extraction, load_checkpoint, project_lock
from cleo.memory.paths import project_directory, session_directory
from cleo.memory.reader import MemoryReader
from cleo.memory.repository import MemoryRepository
from cleo.memory.state import get_session_source, mark_consolidation_started
from cleo.sessions.rewind import active_events
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


def test_timing_tracks_actual_retries_and_publish_without_changing_evidence(tmp_path, monkeypatch):
    from cleo.runtime.timing import TimingStore

    config, store = setup(tmp_path, monkeypatch)
    original = store.read_events("session-dream")
    calls = []

    async def request(self, instructions, prompt):
        calls.append(prompt)
        await asyncio.sleep(0.002)
        return "invalid" if len(calls) == 1 else extracted(prompt).model_dump_json()

    monkeypatch.setattr(dream_module.DreamAgent, "_request_text", request)
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    timings = TimingStore(config.MEMORY_DIR)
    result = timings.detail(timings.summaries(kind="dream")[0]["id"])
    assert result["elapsedMs"] > 0 and result["status"] == "completed"
    models = [span for span in result["spans"] if span["category"] == "model"]
    assert len(models) == 2 and all(span["elapsedMs"] > 0 for span in models)
    assert any(span["status"] == "failed" and "校验" in span["label"] for span in result["spans"])
    assert {"发布记忆文件与 Git 提交", "保存整理状态", "准备分块与恢复检查点"} <= {
        span["label"] for span in result["spans"]
    }
    assert store.read_events("session-dream") == original
    assert invoke(dream_module.DreamAgent())["status"] == "skipped"
    assert len(calls) == 2


def memories():
    return MemoryReader(dream_module.settings.MEMORY_DIR).search_long_term_memory(
        space="productivity", project="cleo")["results"]


def extracted(prompt, *, subject="Prefer concise answers."):
    line = prompt.split("Evidence records:\n", 1)[1].splitlines()[0]
    row = json.loads(line)
    return Extraction.model_validate({
        "edits": [{"new": subject,
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
    memory = memories()
    assert len(memory) == 1 and memory[0]["category"] == "preference"
    memory_path = config.MEMORY_DIR / "productivity/projects/cleo/MEMORY.md"
    assert "Prefer concise answers." in memory_path.read_text()


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
    assert memories() == []
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


def test_late_turn_diff_does_not_block_dream_or_rewrite_compact(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch, "Keep this original preference")
    from cleo.memory.paths import compact_path, events_path

    cached = compact_path(config.MEMORY_DIR, "productivity", "cleo", "session-dream")
    payload = json.loads(cached.read_text(encoding="utf-8"))
    payload["future_extension"] = {"keep": ["unknown data"]}
    cached.write_text(json.dumps(payload), encoding="utf-8")
    compact_before = cached.read_bytes()
    store.append_event(session_id="session-dream", space="productivity", project="cleo",
                       event_type="turn_diff", actor="codex", content="late diff evidence")
    raw = events_path(config.MEMORY_DIR, "productivity", "cleo", "session-dream")
    events_before = raw.read_bytes()
    prompts = []

    async def extract(self, prompt):
        prompts.append(prompt)
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    result = invoke(dream_module.DreamAgent())
    assert result["status"] == "complete"
    assert "late diff evidence" in "\n".join(prompts)
    assert cached.read_bytes() == compact_before
    assert raw.read_bytes() == events_before
    assert (
        get_session_source("productivity", "cleo", "session-dream")["consolidated_hash"]
        == result["source_hash"]
    )
    assert invoke(dream_module.DreamAgent())["status"] == "skipped"


@pytest.mark.parametrize("replacement", ['{broken', '{"schema_version":99,"sources":{"keep":1}}'])
def test_dream_refuses_unreadable_or_newer_queue_without_writing(
    tmp_path, monkeypatch, replacement
):
    config, _ = setup(tmp_path, monkeypatch)
    from cleo.memory.paths import memory_state_path

    path = memory_state_path(config.MEMORY_DIR, "productivity")
    path.write_text(replacement, encoding="utf-8")
    with pytest.raises(ValueError):
        invoke(dream_module.DreamAgent())
    assert path.read_text(encoding="utf-8") == replacement


def test_late_events_during_extraction_without_compaction_remain_pending(tmp_path, monkeypatch):
    _, store = setup(tmp_path, monkeypatch)

    async def extract(self, prompt):
        store.append_event(
            session_id="session-dream",
            space="productivity",
            project="cleo",
            event_type="user_message",
            actor="user",
            content="arrived during extraction",
        )
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    result = invoke(dream_module.DreamAgent())
    assert result["status"] == "pending"
    source = get_session_source("productivity", "cleo", "session-dream")
    assert source["status"] == "pending"
    assert source["source_hash"] != source.get("consolidated_hash")


@pytest.mark.parametrize("damage", ["missing", "malformed", "newer-schema", "wrong-project"])
def test_dream_source_rejects_invalid_raw_evidence_without_repairing_it(
    tmp_path, monkeypatch, damage
):
    config, store = setup(tmp_path, monkeypatch)
    from cleo.memory.paths import events_path

    raw = events_path(config.MEMORY_DIR, "productivity", "cleo", "session-dream")
    if damage == "missing":
        raw.unlink()
    elif damage == "malformed":
        raw.write_text('{broken', encoding="utf-8")
    elif damage == "newer-schema":
        raw.write_text('{"schema_version":99,"seq":1,"future":["keep"]}\n', encoding="utf-8")
    before = raw.read_bytes() if raw.exists() else None
    with pytest.raises((FileNotFoundError, ValueError)):
        dream_module.DreamAgent()._read_source(
            store,
            "productivity",
            "other" if damage == "wrong-project" else "cleo",
            "session-dream",
        )
    assert (raw.read_bytes() if raw.exists() else None) == before


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
        result.edits[0].evidence_refs = ["invented"]
        return result

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(ValueError, match="unknown evidence"):
        invoke(dream_module.DreamAgent())
    assert memories() == []
    assert get_session_source("productivity", "cleo", "session-dream")["status"] == "failed"


def test_publication_failure_retry_does_not_call_model_again(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch)
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        return extracted(prompt)

    original = MemoryRepository.publish

    def fail_once(self, *args, **kwargs):
        original(self, *args, **kwargs)
        raise OSError("publication interrupted")

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    monkeypatch.setattr(MemoryRepository, "publish", fail_once)
    with pytest.raises(OSError):
        invoke(dream_module.DreamAgent())
    monkeypatch.setattr(MemoryRepository, "publish", original)
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    assert len(calls) == 1
    assert len(memories()) == 1


def test_extractor_has_no_tools_or_accumulating_messages():
    calls = []

    class Model:
        async def ainvoke(self, messages):
            calls.append(messages)
            return AIMessage(content='{"edits": [], "summary": "none"}')

    agent = dream_module.DreamAgent()
    agent.model = Model()
    asyncio.run(agent._extract("first"))
    asyncio.run(agent._extract("second"))
    assert [len(messages) for messages in calls] == [2, 2]
    assert calls[1][-1].content == "second"


@pytest.mark.parametrize("backend", ["api", "runtime"])
@pytest.mark.parametrize("invalid", [
    '{"edits":[],"snapshot":null}}',
    json.dumps({"snapshot": ["x" * 202]}),
    json.dumps({"snapshot": ["first\nsecond"]}),
])
def test_extractor_corrects_invalid_output_with_original_evidence(monkeypatch, backend, invalid):
    """Purpose: Reproduce malformed JSON and invalid snapshot lines on both transports.

    Input: Recorded failure shapes followed by a valid model response.
    Output: Only corrected output is accepted; retries keep the original evidence.
    """
    calls = []
    responses = iter([invalid, '{"snapshot":["Corrected snapshot"],"summary":"valid"}'])

    class Model:
        async def ainvoke(self, messages):
            calls.append((messages[0].content, messages[1].content))
            return AIMessage(content=next(responses))

    class Runtime:
        def __init__(self, profile, root, instructions, *, mode):
            assert mode == "dream_extract"
            self.instructions = instructions

        async def ainvoke(self, payload, *, config):
            calls.append((self.instructions, payload["messages"][0].content))
            return {"messages": [AIMessage(content=next(responses))]}

    monkeypatch.setattr("cleo.agents.runtime.RuntimeGraph", Runtime)
    agent = dream_module.DreamAgent()
    agent.profile = SimpleNamespace(backend=backend)
    agent.model = Model() if backend == "api" else None
    result = asyncio.run(agent._extract("original evidence"))

    assert result.snapshot == ["Corrected snapshot"]
    assert len(calls) == 2
    assert [prompt for _, prompt in calls] == ["original evidence"] * 2
    assert calls[0][0] in calls[1][0]
    assert "JSON" in calls[1][0]
    assert len(calls[1][0]) > len(calls[0][0])


def test_snapshot_schema_exposes_line_limits():
    """Purpose: Ensure the model sees the same line limits that validation enforces.

    Input: The extraction JSON schema.
    Output: Snapshot array and item constraints are present, including newline rejection.
    """
    schema = Extraction.model_json_schema()["properties"]["snapshot"]
    array = next(option for option in schema["anyOf"] if option.get("type") == "array")
    assert array["maxItems"] == 5
    assert array["items"]["maxLength"] == 200
    assert "pattern" in array["items"]
    assert Extraction(snapshot=["x" * 200]).snapshot == ["x" * 200]
    for line in ["x" * 201, "first\nsecond", "first\rsecond"]:
        with pytest.raises(ValidationError):
            Extraction(snapshot=[line])


def test_invalid_output_retry_exhaustion_retains_blocks_without_publication(tmp_path, monkeypatch):
    """Purpose: Preserve completed work when a block cannot produce valid output.

    Input: A multi-block source with three invalid responses on its second block.
    Output: No partial publication, and a later retry skips the completed first block.
    """
    config, _ = setup(tmp_path, monkeypatch, "multiple evidence records " * 400)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    calls = []

    class Model:
        fail = True

        async def ainvoke(self, messages):
            prompt = messages[-1].content
            block = json.loads(prompt.split("\nEvidence records:", 1)[0])["block"]
            calls.append(block)
            if self.fail and block == 2:
                return AIMessage(content='{"edits":[]}}')
            return AIMessage(content=extracted(prompt).model_dump_json())

    model = Model()
    agent = dream_module.DreamAgent()
    agent.model = model
    with pytest.raises(json.JSONDecodeError):
        invoke(agent)
    assert calls == [1, 2, 2, 2]
    assert memories() == []
    state = get_session_source("productivity", "cleo", "session-dream")
    assert state["status"] == "failed" and "1/" in state["last_error"]
    checkpoint = config.MEMORY_DIR / "productivity/projects/cleo/sessions/session-dream/dream.json"
    assert len(json.loads(checkpoint.read_text())["pending"]["results"]) == 1

    model.fail = False
    assert invoke(agent)["status"] == "complete"
    assert calls.count(1) == 1
    assert calls.count(2) == 4
    assert len(memories()) == 1


@pytest.mark.parametrize("error", [RuntimeError("provider offline"), asyncio.CancelledError()])
def test_output_correction_does_not_retry_transport_errors_or_cancellation(error):
    """Purpose: Limit correction retries to malformed responses.

    Input: A provider exception or cancellation before a response exists.
    Output: The original exception propagates after one request.
    """
    calls = []

    class Model:
        async def ainvoke(self, messages):
            calls.append(messages)
            raise error

    agent = dream_module.DreamAgent()
    agent.model = Model()
    with pytest.raises(type(error)):
        asyncio.run(agent._extract("source"))
    assert len(calls) == 1


def test_extractor_rejects_fact_schema_and_batch_scores():
    class Model:
        async def ainvoke(self, messages):
            return AIMessage(content='{"edits": [], "confidence": 1}')

    agent = dream_module.DreamAgent()
    agent.model = Model()
    with pytest.raises(ValidationError):
        asyncio.run(agent._extract("source"))


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


def test_legacy_narrative_requires_migration_without_overwriting(tmp_path, monkeypatch):
    config, _ = setup(tmp_path, monkeypatch)
    path = config.MEMORY_DIR / "productivity/projects/cleo/MEMORY.md"
    path.write_text("# Human-reviewed context\nKeep this exact decision.\n", encoding="utf-8")

    async def extract(self, prompt):
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(ValueError, match="migration"):
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


@pytest.mark.parametrize("cancellations", [1, 2])
def test_cancel_during_publication_waits_for_writer_before_retry(
    tmp_path, monkeypatch, cancellations,
):
    import threading

    setup(tmp_path, monkeypatch)
    entered = threading.Event()
    release = threading.Event()
    calls = []
    original = MemoryRepository.publish

    async def extract(self, prompt):
        calls.append(prompt)
        return extracted(prompt)

    def slow_publish(self, *args, **kwargs):
        entered.set()
        assert release.wait(10)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    monkeypatch.setattr(MemoryRepository, "publish", slow_publish)

    async def scenario():
        task = asyncio.create_task(dream_module.DreamAgent().invoke(
            "session-dream", "cleo", "productivity",
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            for _ in range(cancellations):
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


def background_service(config, store):
    config.active_profiles.background_memory_enabled = True
    config.active_profiles.background_memory_pending_threshold = 1
    service = DesktopService(
        settings_model=config, store=store,
        runtime=SimpleNamespace(is_project_removed=lambda *_: False),
        dream_agent_factory=dream_module.DreamAgent,
        adapter=SimpleNamespace(rewind=AsyncMock()),
    )
    service._config = SimpleNamespace(snapshot=SimpleNamespace(settings=config))
    service._ensure_productivity_session = AsyncMock()
    service._rewindable = lambda _: True
    service._thread = AsyncMock(return_value={})
    return service


def checkpoint_file(config):
    directory = session_directory(config.MEMORY_DIR, "productivity", "cleo", "session-dream")
    return directory / "dream.json"


def append_turn(store, turn, text):
    store.append_event(session_id="session-dream", space="productivity", project="cleo",
                       event_id=turn, event_type="user_message", actor="user", content=text)
    store.refresh_compact("session-dream")


def test_background_extraction_is_drained_before_rewind_and_keeps_committed_memory(
    tmp_path, monkeypatch,
):
    config, store = setup(tmp_path, monkeypatch, "committed evidence")
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)

    async def initial_extract(self, prompt):
        return extracted(prompt, subject="Preserve this durable preference.")

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", initial_extract)
    invoke(dream_module.DreamAgent())
    committed = load_checkpoint(checkpoint_file(config))
    append_turn(store, "removed", "unpublished removed preference " * 2000)
    service = background_service(config, store)

    async def scenario():
        extracting = asyncio.Event()
        calls = 0

        async def extract(self, prompt):
            nonlocal calls
            calls += 1
            if calls == 2:
                extracting.set()
                await asyncio.Event().wait()
            return extracted(prompt, subject="Unpublished removed preference.")

        monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
        await service.run_background_memory_review()
        await extracting.wait()
        assert load_checkpoint(checkpoint_file(config))["pending"]["results"]
        await service.rewind_thread(thread_id="session-dream", item_id="removed")
        assert service._background_memory._task.cancelled()
        checkpoint = load_checkpoint(checkpoint_file(config))
        assert checkpoint["pending"] is None
        assert checkpoint["committed_hash"] == committed["committed_hash"]
        assert checkpoint["committed_seq"] == committed["committed_seq"]
        assert "removed" not in json.dumps(active_events(store.read_events("session-dream")))
        assert get_session_source("productivity", "cleo", "session-dream")["status"] == "pending"
        assert (await dream_module.DreamAgent().invoke(
            "session-dream", "cleo", "productivity",
        ))["status"] == "complete"
        assert calls == 2

    asyncio.run(asyncio.wait_for(scenario(), 10))
    memory = MemoryRepository(config.MEMORY_DIR).read("productivity", "cleo")
    assert "Preserve this durable preference." in memory
    assert "Unpublished removed preference." not in memory


def test_persisted_checkpoint_followed_by_rewind_is_regenerated_on_restart(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch, "removed old evidence " * 2000)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    calls = []

    async def interrupted(self, prompt):
        calls.append(prompt)
        if len(calls) == 2:
            raise RuntimeError("offline")
        return extracted(prompt, subject="Stale unpublished preference.")

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", interrupted)
    with pytest.raises(RuntimeError, match="offline"):
        invoke(dream_module.DreamAgent())
    assert load_checkpoint(checkpoint_file(config))["pending"]["results"]
    target = next(e["id"] for e in store.read_events("session-dream")
                  if e["type"] == "user_message")
    # Simulate a durable rewind followed by process death before checkpoint cleanup.
    store.append_event(session_id="session-dream", space="productivity", project="cleo",
                       event_type="rewind", actor="user", data={"turn_id": target})
    append_turn(store, "replacement", "replacement active evidence")
    prompts = []

    async def resumed(self, prompt):
        prompts.append(prompt)
        return extracted(prompt, subject="Replacement preference.")

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", resumed)
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    assert len(prompts) == 1
    evidence = prompts[0].split("Evidence records:\n", 1)[1]
    assert "replacement active evidence" in evidence and "removed old evidence" not in evidence
    memory = MemoryRepository(config.MEMORY_DIR).read("productivity", "cleo")
    assert "Replacement preference." in memory and "Stale unpublished preference." not in memory


def test_rewind_waits_for_publication_and_preserves_its_durable_memory(tmp_path, monkeypatch):
    import threading

    config, store = setup(tmp_path, monkeypatch)
    target = next(e["id"] for e in store.read_events("session-dream")
                  if e["type"] == "user_message")
    entered, release = threading.Event(), threading.Event()
    original = MemoryRepository.publish

    async def extract(self, prompt):
        return extracted(prompt)

    def publish(self, *args, **kwargs):
        entered.set()
        assert release.wait(10)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    monkeypatch.setattr(MemoryRepository, "publish", publish)
    service = background_service(config, store)

    async def scenario():
        await service.run_background_memory_review()
        operation = None
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            draining = asyncio.Event()
            cancel = service._background_memory.request_cancel

            def request_cancel():
                task = cancel()
                draining.set()
                return task

            monkeypatch.setattr(service._background_memory, "request_cancel", request_cancel)
            operation = asyncio.create_task(service.rewind_thread(
                thread_id="session-dream", item_id=target,
            ))
            await draining.wait()
            assert not operation.done()
            assert not any(e["type"] == "rewind" for e in store.read_events("session-dream"))
            assert service._memory_operations == 1
            assert (await service.run_background_memory_review())["running"]
        finally:
            release.set()
            if operation is not None:
                await operation
        assert load_checkpoint(checkpoint_file(config))["pending"] is None

    asyncio.run(asyncio.wait_for(scenario(), 10))
    assert "Prefer concise answers." in MemoryRepository(config.MEMORY_DIR).read(
        "productivity", "cleo",
    )
    assert not any(e["type"] == "user_message"
                   for e in active_events(store.read_events("session-dream")))


def test_failed_provider_rewind_keeps_local_events_and_checkpoint(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch, "pending evidence " * 2000)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    calls = 0

    async def extract(self, prompt):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("offline")
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(RuntimeError, match="offline"):
        invoke(dream_module.DreamAgent())
    target = next(e["id"] for e in store.read_events("session-dream")
                  if e["type"] == "user_message")
    before_events = store.read_events("session-dream")
    before_checkpoint = checkpoint_file(config).read_bytes()
    before_source = get_session_source("productivity", "cleo", "session-dream")
    before_memory = MemoryRepository(config.MEMORY_DIR).read("productivity", "cleo")
    service = background_service(config, store)
    service._adapter_instance.rewind.side_effect = RuntimeError("provider refused rewind")
    with pytest.raises(RuntimeError, match="provider refused rewind"):
        asyncio.run(service.rewind_thread(thread_id="session-dream", item_id=target))
    assert store.read_events("session-dream") == before_events
    assert checkpoint_file(config).read_bytes() == before_checkpoint
    assert get_session_source("productivity", "cleo", "session-dream") == before_source
    assert MemoryRepository(config.MEMORY_DIR).read("productivity", "cleo") == before_memory
    assert service._memory_operations == 0


def test_restart_recovers_abandoned_running_source_and_reuses_checkpoint(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch, "checkpointed evidence " * 2000)
    monkeypatch.setattr(dream_module, "BLOCK_BUDGET", 1200)
    calls = []

    async def extract(self, prompt):
        calls.append(prompt)
        if len(calls) == 2:
            raise RuntimeError("interrupted process")
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(RuntimeError):
        invoke(dream_module.DreamAgent())
    source = get_session_source("productivity", "cleo", "session-dream")
    mark_consolidation_started("productivity", "cleo", "session-dream", source["source_hash"])
    service = background_service(config, SessionStore(config.MEMORY_DIR, config.SESSION_INDEX_PATH))

    async def scenario():
        assert (await service.run_background_memory_review())["running"]
        await service._background_memory._task
        assert get_session_source("productivity", "cleo", "session-dream")["status"] == "complete"

    asyncio.run(asyncio.wait_for(scenario(), 10))
    assert calls.count(calls[0]) == 1


def test_recovery_waits_for_live_project_worker_and_cancellation_does_not_reset_it(
    tmp_path, monkeypatch,
):
    from contextlib import asynccontextmanager

    config, store = setup(tmp_path, monkeypatch)
    source = get_session_source("productivity", "cleo", "session-dream")
    mark_consolidation_started("productivity", "cleo", "session-dream", source["source_hash"])
    source = get_session_source("productivity", "cleo", "session-dream")
    service = background_service(config, store)

    async def scenario():
        waiting = asyncio.Event()

        @asynccontextmanager
        async def observed_lock(directory):
            waiting.set()
            async with project_lock(directory):
                yield

        monkeypatch.setattr(dream_module, "project_lock", observed_lock)
        monkeypatch.setattr(dream_module.DreamAgent, "_extract", AsyncMock())
        async with project_lock(project_directory(config.MEMORY_DIR, "productivity", "cleo")):
            assert (await service.run_background_memory_review())["running"]
            await waiting.wait()
            assert get_session_source("productivity", "cleo", "session-dream") == source
            await service.cancel_background_memory_review()
            assert get_session_source("productivity", "cleo", "session-dream") == source
            assert not checkpoint_file(config).exists()
            dream_module.DreamAgent._extract.assert_not_awaited()

    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_rewind_before_committed_cursor_drops_later_uncommitted_turns(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch, "committed preference evidence")
    prompts = []

    async def extract(self, prompt):
        prompts.append(prompt)
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    invoke(dream_module.DreamAgent())
    committed = load_checkpoint(checkpoint_file(config))
    append_turn(store, "later", "removed uncommitted evidence")
    target = next(e["id"] for e in store.read_events("session-dream")
                  if e["type"] == "user_message")
    store.append_event(session_id="session-dream", space="productivity", project="cleo",
                       event_type="rewind", actor="user", data={"turn_id": target})
    append_turn(store, "replacement", "new active evidence")
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    evidence = prompts[-1].split("Evidence records:\n", 1)[1]
    assert "removed uncommitted evidence" not in evidence
    assert "committed preference evidence" not in evidence
    assert "new active evidence" in evidence
    checkpoint = load_checkpoint(checkpoint_file(config))
    assert checkpoint["committed_seq"] > committed["committed_seq"]
    assert "Prefer concise answers." in MemoryRepository(config.MEMORY_DIR).read(
        "productivity", "cleo",
    )


def test_later_rewind_marker_blocks_publication_of_old_prefix(tmp_path, monkeypatch):
    config, store = setup(tmp_path, monkeypatch)
    target = next(e["id"] for e in store.read_events("session-dream")
                  if e["type"] == "user_message")
    calls = 0

    async def extract(self, prompt):
        nonlocal calls
        calls += 1
        store.append_event(session_id="session-dream", space="productivity", project="cleo",
                           event_type="rewind", actor="user", data={"turn_id": target})
        return extracted(prompt)

    monkeypatch.setattr(dream_module.DreamAgent, "_extract", extract)
    with pytest.raises(ValueError, match="source changed before publication"):
        invoke(dream_module.DreamAgent())
    assert memories() == []
    resumed = AsyncMock(return_value=Extraction())
    monkeypatch.setattr(dream_module.DreamAgent, "_extract", resumed)
    assert invoke(dream_module.DreamAgent())["status"] == "complete"
    assert calls == 1
    for call in resumed.await_args_list:
        assert "Remember this decision" not in call.args[0].split("Evidence records:\n", 1)[1]
    assert load_checkpoint(checkpoint_file(config))["pending"] is None
    assert memories() == []


def test_repeated_cancel_during_local_rewind_drains_write_and_keeps_project_lock(
    tmp_path, monkeypatch,
):
    import threading

    config, store = setup(tmp_path, monkeypatch)
    target = next(e["id"] for e in store.read_events("session-dream")
                  if e["type"] == "user_message")
    service = background_service(config, store)
    entered, release, completed = (threading.Event() for _ in range(3))
    original = service._record_rewind

    def delayed(*args):
        entered.set()
        assert release.wait(10)
        original(*args)
        completed.set()

    monkeypatch.setattr(service, "_record_rewind", delayed)

    async def scenario():
        operation = asyncio.create_task(service.rewind_thread(
            thread_id="session-dream", item_id=target,
        ))
        try:
            assert await asyncio.to_thread(entered.wait, 10)
            for _ in range(2):
                operation.cancel()
                await asyncio.sleep(0)
                assert not operation.done()
            assert service._memory_operations == 1
            assert not (await service.run_background_memory_review())["running"]
            assert not completed.is_set()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await operation
        assert completed.is_set() and service._memory_operations == 0
        async with project_lock(project_directory(config.MEMORY_DIR, "productivity", "cleo")):
            assert any(e["type"] == "rewind" for e in store.read_events("session-dream"))
            source = get_session_source("productivity", "cleo", "session-dream")
            assert source["status"] == "pending"

    asyncio.run(asyncio.wait_for(scenario(), 10))
