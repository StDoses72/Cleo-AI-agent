import json
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from core.memory.compaction import load_validated_compact
from core.memory.paths import (
    compact_path,
    events_path,
    manifest_path,
    project_directory,
)
from core.memory.session_store import SessionStore
from core.memory.state import (
    get_session_source,
    mark_consolidated,
    needs_consolidation,
    touch_session_source,
)
from core.memory.store import (
    count_source_memories,
    search_conversation_history,
    search_memories,
    upsert_memory,
)
from core.runtime.model import RuntimeState


def test_directory_profile_exposes_new_session_paths(tmp_path: Path) -> None:
    from config.settings import DirectoryProfile

    profile = DirectoryProfile(
        root_dir=tmp_path,
        memory_dir="memory",
        memory_policy_path="memory/MEMORY_POLICY.md",
        session_index_path="memory/sessions.sqlite3",
        session_artifacts_dir="data/session_artifacts",
    )

    assert profile.memory_path == tmp_path / "memory"
    assert profile.memory_policy_file == tmp_path / "memory" / "MEMORY_POLICY.md"
    assert profile.session_index_file == tmp_path / "memory" / "sessions.sqlite3"
    assert profile.session_artifacts_path == tmp_path / "data" / "session_artifacts"


def test_session_store_appends_events_and_updates_manifest(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    session_id = "session-a"
    first_messages = [
        HumanMessage(content="Design the session store", id="human-1"),
        AIMessage(content="Use append-only JSONL", id="ai-1"),
    ]
    store.sync_langchain_messages(
        session_id=session_id,
        space="non_productivity",
        project="cleo",
        messages=first_messages,
    )
    first_events = store.read_events(session_id)

    store.sync_langchain_messages(
        session_id=session_id,
        space="non_productivity",
        project="cleo",
        messages=[
            *first_messages,
            HumanMessage(content="Add a manifest", id="human-2"),
            AIMessage(content="The manifest is an atomic projection", id="ai-2"),
        ],
        status="completed",
    )
    all_events = store.read_events(session_id)
    manifest = store.load_manifest(session_id)

    assert all_events[: len(first_events)] == first_events
    assert [event["seq"] for event in all_events] == list(range(1, len(all_events) + 1))
    assert manifest["space"] == "non_productivity"
    assert manifest["project"] == "cleo"
    assert manifest["status"] == "completed"
    assert manifest["last_event_seq"] == len(all_events)
    assert manifest["last_compacted_seq"] == len(all_events)
    assert store.load_langchain_messages(session_id)[-1].content == (
        "The manifest is an atomic projection"
    )
    assert events_path(memory_root, "non_productivity", "cleo", session_id).is_file()
    assert manifest_path(memory_root, "non_productivity", "cleo", session_id).is_file()
    assert compact_path(memory_root, "non_productivity", "cleo", session_id).is_file()
    for database in (
        memory_root / "sessions.sqlite3",
        memory_root / "non_productivity" / "memory.sqlite3",
    ):
        moved = database.with_suffix(".moved")
        database.replace(moved)
        moved.replace(database)


def test_compactor_merges_tools_redacts_secrets_and_cites_events(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    session_id = "session-tools"
    store.sync_langchain_messages(
        session_id=session_id,
        space="productivity",
        project="cleo",
        messages=[
            HumanMessage(content="Analyze design.md", id="human-1"),
            AIMessage(
                content="",
                id="ai-call-1",
                tool_calls=[
                    {
                        "id": "call-1",
                        "name": "read_file",
                        "args": {
                            "file_path": "design.md",
                            "api_key": "should-not-survive",
                        },
                    }
                ],
            ),
            ToolMessage(
                content="X" * 10_000,
                tool_call_id="call-1",
                name="read_file",
                id="tool-1",
                status="success",
            ),
            AIMessage(content="The design needs a session manifest", id="ai-final-1"),
        ],
        status="completed",
    )
    payload = load_validated_compact(
        memory_root=memory_root,
        space="productivity",
        project="cleo",
        session_id=session_id,
    )
    tool_event = next(event for event in payload["events"] if event["type"] == "tool_event")
    raw_events = store.read_events(session_id)
    source_events = {
        event["source_message_id"]: event["id"]
        for event in raw_events
        if event.get("source_message_id")
    }

    assert tool_event["args"]["api_key"] == "<redacted>"
    assert tool_event["result_omitted"] is True
    assert tool_event["original_result_characters"] == 10_000
    assert tool_event["source_event_ids"] == [
        source_events["ai-call-1"],
        source_events["tool-1"],
    ]
    assert payload["space"] == "productivity"
    assert payload["source"]["to_seq"] == len(raw_events)


def test_memory_state_is_bound_to_space_project_and_session(tmp_path: Path) -> None:
    non_productivity_state = tmp_path / "non-productivity-state.json"
    productivity_state = tmp_path / "productivity-state.json"
    first = touch_session_source(
        space="non_productivity",
        project="cleo",
        session_id="session-a",
        source_hash="sha256:first",
        last_event_seq=2,
        path=non_productivity_state,
    )
    repeated = touch_session_source(
        space="non_productivity",
        project="cleo",
        session_id="session-a",
        source_hash="sha256:first",
        last_event_seq=2,
        path=non_productivity_state,
    )
    other_space = touch_session_source(
        space="productivity",
        project="cleo",
        session_id="session-a",
        source_hash="sha256:other",
        last_event_seq=1,
        path=productivity_state,
    )

    assert first["source_version"] == repeated["source_version"] == 1
    assert other_space["space"] == "productivity"
    assert needs_consolidation(
        "non_productivity",
        "cleo",
        "session-a",
        "sha256:first",
        path=non_productivity_state,
    )
    mark_consolidated(
        "non_productivity",
        "cleo",
        "session-a",
        "sha256:first",
        durable_memory_count=0,
        no_durable_memory_reason="No durable information.",
        path=non_productivity_state,
    )
    state = get_session_source(
        "non_productivity",
        "cleo",
        "session-a",
        path=non_productivity_state,
    )
    assert state is not None
    assert state["consolidated_hash"] == "sha256:first"


def test_atomic_memory_is_idempotent_and_space_scoped(tmp_path: Path) -> None:
    database_path = tmp_path / "memory.sqlite3"
    kwargs = {
        "space": "productivity",
        "project": "cleo",
        "session_id": "session-a",
        "source_hash": "sha256:source",
        "category": "decision",
        "subject": "Memory retrieval",
        "content": "Use a local lexical index before vector infrastructure.",
        "evidence_event_ids": ["evt-1"],
        "tags": ["memory", "retrieval"],
        "path": database_path,
    }
    first = upsert_memory(**kwargs)
    repeated = upsert_memory(**kwargs)

    assert first["id"] == repeated["id"]
    assert repeated["evidence_count"] == 1
    assert count_source_memories(
        "productivity",
        "cleo",
        "session-a",
        "sha256:source",
        path=database_path,
    ) == 1
    results = search_memories(
        space="productivity",
        project="cleo",
        query="local lexical index",
        path=database_path,
    )
    assert [item["id"] for item in results] == [first["id"]]
    assert search_memories(
        space="non_productivity",
        project="cleo",
        query="local lexical index",
        path=tmp_path / "other-space.sqlite3",
    ) == []


def test_history_search_rejects_stale_compact_event_sources(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    session_id = "session-history"
    store.sync_langchain_messages(
        session_id=session_id,
        space="productivity",
        project="cleo",
        messages=[
            HumanMessage(content="Why start with lexical search?", id="human-1"),
            AIMessage(content="It does not require Qdrant.", id="ai-1"),
        ],
        status="completed",
    )
    database_path = memory_root / "productivity" / "memory.sqlite3"
    results = search_conversation_history(
        space="productivity",
        project="cleo",
        query="Qdrant",
        path=database_path,
        memory_root=memory_root,
    )
    assert len(results) == 1
    assert results[0]["session_id"] == session_id
    assert len(results[0]["event_ids"]) == 2

    store.append_event(
        space="productivity",
        project="cleo",
        session_id=session_id,
        event_type="user_message",
        actor="user",
        content="This event has not been compacted yet.",
    )
    assert search_conversation_history(
        space="productivity",
        project="cleo",
        query="Qdrant",
        path=database_path,
        memory_root=memory_root,
    ) == []


def test_event_to_dream_completion_protocol(tmp_path: Path, monkeypatch) -> None:
    from core.memory import state
    from core.memory import store as memory_store
    from tools import dream_agent_tools

    memory_root = tmp_path / "memory"
    fake_settings = SimpleNamespace(MEMORY_DIR=memory_root)
    monkeypatch.setattr(state, "settings", fake_settings)
    monkeypatch.setattr(memory_store, "settings", fake_settings)
    monkeypatch.setattr(dream_agent_tools, "settings", fake_settings)
    session_store = SessionStore(memory_root)
    session_store.sync_langchain_messages(
        session_id="session-dream",
        space="productivity",
        project="cleo",
        messages=[
            HumanMessage(content="Use local lexical retrieval first.", id="human-1"),
            AIMessage(content="Recorded the architecture decision.", id="ai-1"),
        ],
        status="completed",
    )
    payload = load_validated_compact(
        memory_root=memory_root,
        space="productivity",
        project="cleo",
        session_id="session-dream",
    )
    source_hash = payload["source"]["source_content_hash"]
    evidence_event_id = next(
        event["id"] for event in payload["events"] if event["type"] == "human"
    )

    remembered = dream_agent_tools.remember_durable_knowledge.invoke(
        {
            "space": "productivity",
            "project": "cleo",
            "session_id": "session-dream",
            "source_hash": source_hash,
            "category": "decision",
            "subject": "Initial retrieval backend",
            "content": "Use local lexical retrieval before vector infrastructure.",
            "evidence_event_ids": [evidence_event_id],
            "tags": ["memory", "retrieval"],
        }
    )
    assert json.loads(remembered)["status"] == "stored"

    written = dream_agent_tools.write_memory_to_markdown.invoke(
        {
            "space": "productivity",
            "project": "cleo",
            "session_id": "session-dream",
            "source_hash": source_hash,
            "executive_summary": "Selected the initial retrieval backend.",
            "decisions": "- Start with local lexical retrieval.",
        }
    )
    assert written.startswith("Project memory written")
    completed = dream_agent_tools.complete_memory_consolidation.invoke(
        {
            "space": "productivity",
            "project": "cleo",
            "session_id": "session-dream",
            "source_hash": source_hash,
            "durable_memory_count": 1,
        }
    )
    assert json.loads(completed)["status"] == "complete"
    source_state = state.get_session_source(
        "productivity",
        "cleo",
        "session-dream",
    )
    assert source_state is not None
    assert source_state["consolidated_hash"] == source_hash
    memory_text = (
        project_directory(memory_root, "productivity", "cleo") / "MEMORY.md"
    ).read_text(encoding="utf-8")
    assert f"session-dream#{evidence_event_id}" in memory_text


def test_runtime_recent_threads_are_partitioned_by_space() -> None:
    state = RuntimeState(
        current_space="productivity",
        current_project="cleo",
        projects={
            "non_productivity": ["general", "personal"],
            "productivity": ["cleo"],
        },
        recent_threads={
            "non_productivity": ["personal-session"],
            "productivity": ["code-session"],
        },
    )

    assert state.projects["non_productivity"] == ["general", "personal"]
    assert state.projects["productivity"] == ["cleo"]
    assert state.recent_threads["non_productivity"] == ["personal-session"]
    assert state.recent_threads["productivity"] == ["code-session"]
