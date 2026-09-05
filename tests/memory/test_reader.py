import json

import pytest

from cleo.memory.paths import events_path, memory_database_path
from cleo.memory.reader import MemoryReader
from cleo.memory.store import upsert_memory
from cleo.sessions.store import SessionStore


def add_thread(store, session_id, space, project, text):
    store.create_session(
        session_id=session_id,
        space=space,
        project=project,
        provider="test",
        owner_type="user",
    )
    store.append_event(
        session_id=session_id,
        space=space,
        project=project,
        event_type="user_message",
        actor="user",
        content=text,
    )


def test_cross_space_search_reads_uncompacted_threads(tmp_path):
    store = SessionStore(tmp_path)
    add_thread(store, "chat", "non_productivity", "general", "双向记忆需求")
    add_thread(store, "code-a", "productivity", "alpha", "双向记忆实现")
    add_thread(store, "code-b", "productivity", "beta", "双向记忆验证")
    reader = MemoryReader(tmp_path)
    assert {r["session_id"] for r in reader.search_conversation_history("双向记忆")["results"]} == {
        "chat",
        "code-a",
        "code-b",
    }
    result = reader.search_conversation_history("双向记忆", space="productivity", project="beta")
    assert [r["session_id"] for r in result["results"]] == ["code-b"]
    assert reader.search_conversation_history("双向记忆", project="missing")["results"] == []
    assert reader.read_thread("chat")["results"][0]["content"] == "双向记忆需求"


def test_read_snapshot_and_long_message_continuation(tmp_path):
    store = SessionStore(tmp_path)
    content = "hello " * 4000
    add_thread(store, "chat", "non_productivity", "general", content)
    reader = MemoryReader(tmp_path)
    page = reader.read_thread("chat", limit=1)
    parts = [page["results"][0]["content"]]
    store.append_event(
        session_id="chat",
        space="non_productivity",
        project="general",
        event_type="assistant_message",
        actor="assistant",
        content="later",
    )
    while page["next_cursor"]:
        page = reader.read_thread("chat", cursor=page["next_cursor"], limit=1)
        parts.extend(r["content"] for r in page["results"])
    assert "".join(parts) == content
    assert reader.read_thread("chat", limit=100)["snapshot_seq"] > page["snapshot_seq"]


def test_move_delete_and_stale_compact(tmp_path):
    store = SessionStore(tmp_path)
    add_thread(store, "chat", "non_productivity", "general", "old choice")
    store.refresh_compact("chat")
    reader = MemoryReader(tmp_path)
    store.append_event(
        session_id="chat",
        space="non_productivity",
        project="general",
        event_type="user_message",
        actor="user",
        content="new choice",
    )
    assert reader.read_thread("chat", view="summary")["status"] == "summary_unavailable"
    assert reader.search_conversation_history("new choice")["results"]
    store.move_session("chat", "moved")
    assert reader.read_thread("chat")["project"] == "moved"
    store.delete_session("chat")
    assert reader.read_thread("chat")["status"] == "not_found"
    assert reader.search_conversation_history("choice")["results"] == []


def test_validation_and_redaction(tmp_path):
    store = SessionStore(tmp_path)
    add_thread(store, "chat", "non_productivity", "general", "password=private-value")
    reader = MemoryReader(tmp_path)
    assert "private-value" not in json.dumps(reader.read_thread("chat"))
    with pytest.raises(ValueError):
        reader.read_thread("../outside")
    with pytest.raises(ValueError):
        reader.read_thread("chat", cursor="invalid")
    with pytest.raises(ValueError):
        reader.list_threads(space="invalid")


def test_search_pagination_does_not_hide_later_matches(tmp_path, monkeypatch):
    monkeypatch.setattr("cleo.memory.reader.SCAN_THREADS", 1)
    store = SessionStore(tmp_path)
    add_thread(store, "a", "non_productivity", "general", "unrelated")
    add_thread(store, "b", "productivity", "code", "needle")
    reader = MemoryReader(tmp_path)
    first = reader.search_conversation_history("needle")
    assert first["results"] == []
    assert first["partial"] and first["next_cursor"]
    second = reader.search_conversation_history("needle", cursor=first["next_cursor"])
    assert [r["session_id"] for r in second["results"]] == ["b"]
    assert not second["partial"]
    with pytest.raises(ValueError):
        reader.search_conversation_history("different", cursor=first["next_cursor"])
    page = reader.list_threads(limit=1)
    assert page["results"][0]["session_id"] == "a"
    assert reader.list_threads(cursor=page["next_cursor"])["results"][0]["session_id"] == "b"


def test_search_hit_limit_and_corrupt_source(tmp_path):
    store = SessionStore(tmp_path)
    add_thread(store, "a", "non_productivity", "general", "needle first")
    store.append_event(
        session_id="a",
        space="non_productivity",
        project="general",
        event_type="user_message",
        actor="user",
        content="needle second",
    )
    reader = MemoryReader(tmp_path)
    first = reader.search_conversation_history("needle", limit=1)
    second = reader.search_conversation_history("needle", limit=1, cursor=first["next_cursor"])
    assert first["results"][0]["event_ids"] != second["results"][0]["event_ids"]
    last = reader.search_conversation_history("needle", cursor=second["next_cursor"])
    assert not last["partial"] and last["results"] == []
    events_path(tmp_path, "non_productivity", "general", "a").write_text("broken\n")
    assert reader.read_thread("a")["status"] == "read_error"
    error = reader.search_conversation_history("needle")
    assert error["partial"] and error["errors"]


def test_durable_memory_uses_explicit_root_and_preserves_evidence(tmp_path):
    for space, project in [("non_productivity", "general"), ("productivity", "code")]:
        upsert_memory(
            space=space,
            project=project,
            session_id="source",
            source_hash="sha256:test",
            category="decision",
            subject="shared requirement",
            content="Use shared memory",
            evidence_event_ids=["event-1"],
            tags=["memory"],
            path=memory_database_path(tmp_path, space),
        )
    reader = MemoryReader(tmp_path)
    results = reader.search_long_term_memory("shared")["results"]
    assert {r["space"] for r in results} == {"non_productivity", "productivity"}
    assert all(r["evidence"][0]["event_id"] == "event-1" for r in results)
    assert len(reader.search_long_term_memory("shared", project="code")["results"]) == 1
    assert reader.search_long_term_memory("shared", tags=["missing"])["results"] == []


def test_valid_summary_and_read_cursor_survive_project_move(tmp_path):
    store = SessionStore(tmp_path)
    add_thread(store, "a", "non_productivity", "general", "x" * 8000)
    store.refresh_compact("a")
    reader = MemoryReader(tmp_path)
    assert reader.read_thread("a", view="summary")["status"] == "ok"
    first = reader.read_thread("a", limit=1)
    store.move_session("a", "moved")
    rest = reader.read_thread("a", cursor=first["next_cursor"])
    assert rest["status"] == "ok" and rest["project"] == "moved"
    assert first["results"][0]["content"] + rest["results"][0]["content"] == "x" * 8000
