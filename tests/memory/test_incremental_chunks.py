import json
import sqlite3

import pytest

from cleo.memory import store


def payload(digest="hash-1"):
    return {"space": "productivity", "project": "p", "session_id": "s",
            "source": {"source_content_hash": digest}}


def event(identifier, kind="ai"):
    return {"id": identifier, "type": kind, "content": f"needle {identifier}",
            "source_event_ids": [f"source-{identifier}"], "created_at": identifier}


def rows(path):
    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(
            "SELECT * FROM conversation_chunks ORDER BY chunk_index")]


def assert_search(monkeypatch, path, metadata, normal, fallback):
    monkeypatch.setattr(store, "load_validated_compact", lambda **kwargs: metadata)
    results = store.search_conversation_history(
        space="productivity", project="p", query="needle", path=path,
        memory_root=path.parent, top_k=20,
    )
    expected = store._conversation_chunks({"events": normal + fallback})
    assert len(results) == len(expected)
    by_index = {item["chunk_index"]: item for item in results}
    for chunk in expected:
        result = by_index[chunk["index"]]
        for key in ("event_ids", "content", "created_at", "ended_at"):
            assert result[key] == chunk[key]
        assert result["source_hash"] == metadata["source"]["source_content_hash"]


def test_batches_keep_v2_order_and_leave_old_normal_rows_untouched(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    normal = [event("u1", "human"), event("a1"), event("u2", "human"), event("a2")]
    fallback = [event("f1", "provider_event")]
    store.update_conversation_chunks(payload(), normal=normal, fallback=fallback,
                                    batch_key=4, expected_prior_hash=None, reset=True, path=path)
    first = next(row for row in rows(path) if row["chunk_index"] == 0)
    delta = [event("a2-more"), event("u3", "human"), event("a3")]
    more_fallback = [event("f2", "error")]
    store.update_conversation_chunks(payload("hash-2"), normal=delta, fallback=more_fallback,
                                    batch_key=7, expected_prior_hash="hash-1", path=path)
    assert next(row for row in rows(path) if row["chunk_index"] == 0) == first
    assert_search(monkeypatch, path, payload("hash-2"), normal + delta,
                  fallback + more_fallback)


def test_fallback_only_empty_batch_and_new_human_move_fallback_to_last_chunk(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    fallback = [event("f1", "error")]
    assert store.update_conversation_chunks(payload(), normal=[], fallback=fallback,
                                           batch_key=1, expected_prior_hash=None,
                                           reset=True, path=path) == 1
    assert_search(monkeypatch, path, payload(), [], fallback)
    store.update_conversation_chunks(payload("hash-2"), normal=[], fallback=[],
                                    batch_key=2, expected_prior_hash="hash-1", path=path)
    assert_search(monkeypatch, path, payload("hash-2"), [], fallback)
    normal = [event("u", "human"), event("a")]
    store.update_conversation_chunks(payload("hash-3"), normal=normal, fallback=[],
                                    batch_key=4, expected_prior_hash="hash-2", path=path)
    assert_search(monkeypatch, path, payload("hash-3"), normal, fallback)


def test_empty_projection_replay_and_prior_hash_conflict(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    args = dict(normal=[], fallback=[], batch_key=0, expected_prior_hash=None, path=path)
    assert store.update_conversation_chunks(payload(), reset=True, **args) == 0
    before = rows(path)
    assert store.update_conversation_chunks(payload(), **args) == 0
    assert rows(path) == before
    assert_search(monkeypatch, path, payload(), [], [])
    with pytest.raises(ValueError, match="prior"):
        store.update_conversation_chunks(payload("other"), normal=[event("wrong")], fallback=[],
                                        batch_key=1, expected_prior_hash="wrong", path=path)
    assert rows(path) == before


def test_failed_head_publication_rolls_back_tail_and_new_fragments(tmp_path):
    path = tmp_path / "memory.sqlite3"
    store.update_conversation_chunks(payload(), normal=[event("u", "human")], fallback=[],
                                    batch_key=1, expected_prior_hash=None, reset=True, path=path)
    before = rows(path)
    with sqlite3.connect(path) as conn:
        conn.execute("""CREATE TRIGGER reject_head BEFORE UPDATE ON conversation_chunks
            WHEN NEW.projection_kind = 'head'
            BEGIN SELECT RAISE(ABORT, 'injected head failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="injected head failure"):
        store.update_conversation_chunks(payload("hash-2"), normal=[event("a")],
                                        fallback=[event("f", "error")], batch_key=3,
                                        expected_prior_hash="hash-1", path=path)
    assert rows(path) == before


def test_reset_and_legacy_replacement_remove_previous_generation(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    store.update_conversation_chunks(payload(), normal=[event("old", "human")],
                                    fallback=[event("old-fallback", "error")], batch_key=2,
                                    expected_prior_hash=None, reset=True, path=path)
    normal = [event("edited", "human")]
    store.update_conversation_chunks(payload("hash-2"), normal=normal, fallback=[],
                                    batch_key=5, expected_prior_hash=None, reset=True, path=path)
    assert_search(monkeypatch, path, payload("hash-2"), normal, [])
    assert all("old" not in row["content"] for row in rows(path))
    legacy = {**payload("legacy"), "events": [event("legacy", "human")]}
    store.replace_conversation_chunks(legacy, path=path)
    assert {row["projection_kind"] for row in rows(path)} == {"legacy"}
    assert_search(monkeypatch, path, legacy, legacy["events"], [])


def test_search_rejects_uncommitted_head_and_missing_fragments(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    normal = [event("u", "human")]
    store.update_conversation_chunks(payload(), normal=normal,
                                    fallback=[event("f", "error")], batch_key=2,
                                    expected_prior_hash=None, reset=True, path=path)
    monkeypatch.setattr(store, "load_validated_compact", lambda **kwargs: payload("hash-2"))
    assert store.search_conversation_history(space="productivity", project="p", query="needle",
                                             path=path, memory_root=tmp_path) == []
    monkeypatch.setattr(store, "load_validated_compact", lambda **kwargs: payload())
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM conversation_chunks WHERE projection_kind = 'fallback'")
    assert store.search_conversation_history(space="productivity", project="p", query="needle",
                                             path=path, memory_root=tmp_path) == []


def test_search_limit_counts_logical_chunks_not_fallback_fragments(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    store.update_conversation_chunks(payload(), normal=[event("u", "human")], fallback=[],
                                    batch_key=0, expected_prior_hash=None, reset=True, path=path)
    with sqlite3.connect(path) as conn:
        conn.executemany("""INSERT INTO conversation_chunks(
            id,space,project,session_id,chunk_index,event_ids_json,content,source_hash,
            created_at,ended_at,updated_at,projection_kind,batch_seq)
            VALUES (?, 'productivity','p','s',?,?,'error: needle','hash-1',?,?,?, 'fallback',?)""",
            [(f"f-{i}", -2-i, json.dumps([f"f-{i}"]), str(i), str(i), str(i), i)
             for i in range(1, 1002)])
        conn.execute("UPDATE conversation_chunks SET content=?,batch_seq=1001 "
                     "WHERE projection_kind='head'",
                     (json.dumps({"normal_count": 1, "fallback_count": 1001}),))
    monkeypatch.setattr(store, "load_validated_compact", lambda **kwargs: payload())
    result = store.search_conversation_history(space="productivity", project="p", query="needle",
                                               path=path, memory_root=tmp_path)
    assert len(result) == 1
    assert len(result[0]["event_ids"]) == 1003
    assert result[0]["content"].count("error: needle") == 1001


def test_existing_schema_migrates_without_rewriting_legacy_chunks(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    chunk = store._conversation_chunks({"events": [event("legacy", "human")]})[0]
    with sqlite3.connect(path) as conn:
        conn.execute("""CREATE TABLE conversation_chunks(
            id TEXT PRIMARY KEY,space TEXT NOT NULL,project TEXT NOT NULL,session_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,event_ids_json TEXT NOT NULL,content TEXT NOT NULL,
            source_hash TEXT NOT NULL,created_at TEXT,ended_at TEXT,updated_at TEXT NOT NULL,
            UNIQUE(space,project,session_id,chunk_index))""")
        conn.execute("INSERT INTO conversation_chunks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                     ("legacy-id", "productivity", "p", "s", 0,
                      json.dumps(chunk["event_ids"]), chunk["content"], "hash-1",
                      chunk["created_at"], chunk["ended_at"], "unchanged"))
    assert_search(monkeypatch, path, payload(), [event("legacy", "human")], [])
    saved = rows(path)[0]
    assert saved["id"] == "legacy-id" and saved["updated_at"] == "unchanged"
    assert saved["projection_kind"] == "legacy" and saved["batch_seq"] == 0
    with pytest.raises(ValueError, match="prior head"):
        store.update_conversation_chunks(payload("hash-2"), normal=[event("new", "human")],
                                        fallback=[], batch_key=3,
                                        expected_prior_hash="hash-1", path=path)


def test_scope_filter_and_delete_remove_fragments_with_their_head(tmp_path, monkeypatch):
    path = tmp_path / "memory.sqlite3"
    for project in ("p", "other"):
        store.update_conversation_chunks({**payload(), "project": project},
                                        normal=[event(project, "human")],
                                        fallback=[event(f"{project}-fallback", "error")],
                                        batch_key=2, expected_prior_hash=None,
                                        reset=True, path=path)
    assert_search(monkeypatch, path, payload(), [event("p", "human")],
                  [event("p-fallback", "error")])
    store.delete_conversation_chunks(space="productivity", project="p", session_id="s", path=path)
    assert {row["project"] for row in rows(path)} == {"other"}
    assert store.search_conversation_history(space="productivity", project="p", query="needle",
                                             path=path, memory_root=tmp_path) == []
