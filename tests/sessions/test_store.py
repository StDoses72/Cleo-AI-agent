from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from cleo.memory.paths import compact_path, events_path, manifest_path
from cleo.memory.state import get_session_source, mark_consolidated
from cleo.memory.store import search_conversation_history
from cleo.sessions.store import SessionStore


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
    assert manifest["title"] == "Design the session store"
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

    renamed = store.rename_session(session_id, "Session storage design")
    assert renamed["title"] == "Session storage design"
    assert store.list_sessions(project="cleo")[0]["title"] == "Session storage design"


def test_session_store_event_id_cache_invalidates_after_another_writer(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    first_store = SessionStore(memory_root)
    first_store.create_session(
        session_id="session-cache",
        space="non_productivity",
        project="cleo",
        provider="cleo",
        owner_type="user",
    )
    first_store.append_event(
        space="non_productivity",
        project="cleo",
        session_id="session-cache",
        event_type="user_message",
        actor="user",
        content="prime the cache",
        event_id="evt-first",
    )

    second_store = SessionStore(memory_root)
    second_store.append_event(
        space="non_productivity",
        project="cleo",
        session_id="session-cache",
        event_type="assistant_message",
        actor="cleo",
        content="written by another store instance",
        event_id="evt-external",
    )
    appended = first_store.append_events(
        space="non_productivity",
        project="cleo",
        session_id="session-cache",
        events=[
            {
                "type": "assistant_message",
                "actor": "cleo",
                "content": "must not be duplicated",
                "id": "evt-external",
            }
        ],
    )

    assert appended == []
    assert [
        event["id"] for event in first_store.read_events("session-cache")
    ].count("evt-external") == 1


def test_session_store_event_id_cache_survives_failed_append(
    tmp_path: Path,
    monkeypatch,
) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    store.create_session(
        session_id="session-retry",
        space="non_productivity",
        project="cleo",
        provider="cleo",
        owner_type="user",
    )
    event_file = events_path(
        memory_root,
        "non_productivity",
        "cleo",
        "session-retry",
    )
    original_open = Path.open
    should_fail = True

    def flaky_open(path, *args, **kwargs):
        nonlocal should_fail
        if path == event_file and args and args[0] == "a" and should_fail:
            should_fail = False
            raise OSError("simulated append failure")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", flaky_open)
    with pytest.raises(OSError, match="simulated append failure"):
        store.append_event(
            space="non_productivity",
            project="cleo",
            session_id="session-retry",
            event_type="user_message",
            actor="user",
            content="retry me",
            event_id="evt-retry",
        )

    retried = store.append_event(
        space="non_productivity",
        project="cleo",
        session_id="session-retry",
        event_type="user_message",
        actor="user",
        content="retry me",
        event_id="evt-retry",
    )

    assert retried["id"] == "evt-retry"
    assert [event["id"] for event in store.read_events("session-retry")].count(
        "evt-retry"
    ) == 1


def test_session_store_moves_pending_thread_between_projects(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    session_id = "session-move"
    store.sync_langchain_messages(
        session_id=session_id,
        space="non_productivity",
        project="general",
        messages=[
            HumanMessage(content="Put this discussion in research", id="human-move"),
            AIMessage(content="We can move it before consolidation.", id="ai-move"),
        ],
    )

    moved = store.move_session(session_id, "research")
    moved_events = store.read_events(session_id)

    assert moved["project"] == "research"
    assert moved["title"] == "Put this discussion in research"
    assert not manifest_path(
        memory_root,
        "non_productivity",
        "general",
        session_id,
    ).exists()
    assert manifest_path(
        memory_root,
        "non_productivity",
        "research",
        session_id,
    ).is_file()
    assert {event["project"] for event in moved_events} == {"research"}
    assert moved_events[-1]["type"] == "session_project_moved"
    assert store.list_sessions(project="general") == []
    assert [row["id"] for row in store.list_sessions(project="research")] == [
        session_id
    ]
    assert get_session_source(
        "non_productivity",
        "general",
        session_id,
        path=memory_root / "non_productivity" / "memory_state.json",
    ) is None
    assert get_session_source(
        "non_productivity",
        "research",
        session_id,
        path=memory_root / "non_productivity" / "memory_state.json",
    ) is not None
    assert search_conversation_history(
        space="non_productivity",
        project="general",
        query="research",
        path=memory_root / "non_productivity" / "memory.sqlite3",
        memory_root=memory_root,
    ) == []
    assert len(
        search_conversation_history(
            space="non_productivity",
            project="research",
            query="research",
            path=memory_root / "non_productivity" / "memory.sqlite3",
            memory_root=memory_root,
        )
    ) == 1


def test_session_store_refuses_to_move_consolidated_thread(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    session_id = "session-consolidated"
    store.sync_langchain_messages(
        session_id=session_id,
        space="non_productivity",
        project="general",
        messages=[HumanMessage(content="Remember this decision", id="human-remember")],
    )
    manifest = store.load_manifest(session_id)
    mark_consolidated(
        "non_productivity",
        "general",
        session_id,
        str(manifest["source_hash"]),
        durable_memory_count=0,
        no_durable_memory_reason="Nothing durable was extracted.",
        path=memory_root / "non_productivity" / "memory_state.json",
    )

    with pytest.raises(ValueError, match="already been consolidated"):
        store.move_session(session_id, "research")


def test_session_store_deletes_thread_and_derived_conversation_state(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root)
    session_id = "session-delete"
    store.sync_langchain_messages(
        session_id=session_id,
        space="non_productivity",
        project="general",
        messages=[HumanMessage(content="Delete this local history", id="human-delete")],
    )

    deleted = store.delete_session(session_id)

    assert deleted["id"] == session_id
    assert store.list_sessions() == []
    assert not manifest_path(
        memory_root,
        "non_productivity",
        "general",
        session_id,
    ).exists()
    assert get_session_source(
        "non_productivity",
        "general",
        session_id,
        path=memory_root / "non_productivity" / "memory_state.json",
    ) is None
    assert search_conversation_history(
        space="non_productivity",
        project="general",
        query="local history",
        path=memory_root / "non_productivity" / "memory.sqlite3",
        memory_root=memory_root,
    ) == []
    with pytest.raises(FileNotFoundError):
        store.load_manifest(session_id)
