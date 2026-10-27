"""Regression coverage for scoped index repair, revision receipts and search paging."""

import sqlite3
from collections import Counter

import pytest

from cleo.memory import compaction
from cleo.memory.paths import compact_path, events_path, memory_database_path
from cleo.memory.reader import MemoryReader
from cleo.memory.store import _logical_conversation_rows
from cleo.sessions import event_log
from cleo.sessions.store import SessionStore


def add(store, identifier, text="needle", project="p"):
    store.create_session(session_id=identifier, space="productivity", project=project,
                         provider="test", owner_type="user")
    return store.append_event(session_id=identifier, space="productivity", project=project,
                              event_type="user_message", actor="user", content=text)


def append(store, identifier, text, **kwargs):
    return store.append_event(session_id=identifier, space="productivity", project="p",
                              event_type="user_message", actor="user", content=text, **kwargs)


def observe_logs(monkeypatch):
    counts = Counter()
    original = compaction.load_events

    def observed(path):
        counts[path.parent.name] += 1
        return original(path)

    monkeypatch.setattr(compaction, "load_events", observed)
    monkeypatch.setattr(event_log, "load_events", observed)
    return counts


def test_repeated_queries_and_message_pages_do_not_read_event_logs(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    add(store, "a", "needle " * 3000)
    store.refresh_compact("a")
    reader = MemoryReader(tmp_path)
    counts = observe_logs(monkeypatch)
    assert reader.search_conversation_history("needle")["results"]
    assert counts["a"] == 1  # Real compaction.load_events, not only compact_events.
    counts.clear()
    assert reader.search_conversation_history("needle")["results"]
    assert reader.search_conversation_history("missing")["results"] == []
    first = reader.read_thread("a", limit=1)
    second = reader.read_thread("a", limit=1, cursor=first["next_cursor"])
    assert second["status"] == "ok"
    assert counts == {}


def test_active_append_repairs_only_changed_session(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    add(store, "a")
    add(store, "b")
    reader = MemoryReader(tmp_path)
    reader.search_conversation_history("needle")
    old_hash = store.load_manifest("a")["source_hash"]
    append(store, "a", "fresh tail")
    assert store.load_manifest("a")["source_hash"] == old_hash
    counts = observe_logs(monkeypatch)
    result = reader.search_conversation_history("fresh tail")
    assert [row["session_id"] for row in result["results"]] == ["a"]
    assert counts["a"] > 0 and counts["b"] == 0
    counts.clear()
    assert reader.search_conversation_history("needle")["results"]
    assert counts == {}


def test_global_rank_passes_fifty_sessions_and_thousand_chunks(tmp_path):
    store = SessionStore(tmp_path)
    for number in range(51):
        add(store, f"a{number:03}", "needle weak")
    add(store, "z-late", "needle strongest exact match")
    store.append_events(session_id="z-late", space="productivity", project="p", events=[
        {"type": "user_message", "actor": "user", "content": f"ordinary {number}"}
        for number in range(1001)
    ])
    reader = MemoryReader(tmp_path)
    first = reader.search_conversation_history("needle strongest exact match", limit=1)
    assert first["results"][0]["session_id"] == "z-late"
    assert first["results"][0]["index"] == 0
    rows = _logical_conversation_rows("productivity", "p", memory_database_path(tmp_path,
                                                                                   "productivity"))
    assert len(rows) == 1053
    seen = [first["results"][0]["session_id"]]
    while first["next_cursor"]:
        first = reader.search_conversation_history("needle strongest exact match",
                                                   cursor=first["next_cursor"], limit=20)
        seen.extend(row["session_id"] for row in first["results"])
    assert len(seen) == 52 and len(set(seen)) == 52


@pytest.mark.parametrize("change", ["append", "rewind", "move", "delete", "replace", "new"])
def test_search_cursors_reject_changed_history_scope(tmp_path, change):
    store = SessionStore(tmp_path)
    first_event = add(store, "a", "needle first")
    append(store, "a", "needle second")
    reader = MemoryReader(tmp_path)
    first = reader.search_conversation_history("needle", limit=1)
    assert first["next_cursor"]
    if change == "append":
        append(store, "a", "needle tail")
    elif change == "rewind":
        store.append_event(session_id="a", space="productivity", project="p",
                           event_type="rewind", actor="user", data={"turn_id": first_event["id"]})
    elif change == "move":
        store.move_session("a", "q")
    elif change == "delete":
        store.delete_session("a")
    elif change == "replace":
        path = events_path(tmp_path, "productivity", "p", "a")
        path.write_text(path.read_text(encoding="utf-8").replace("first", "other"),
                        encoding="utf-8")
    else:
        add(store, "b")
    assert reader.search_conversation_history("needle", cursor=first["next_cursor"])[
        "status"] == "stale_cursor"
    if change == "rewind":
        assert reader.search_conversation_history("needle")["results"] == []
    elif change == "move":
        assert reader.search_conversation_history("needle", project="p")["results"] == []
        assert reader.search_conversation_history("needle", project="q")["results"]


def test_read_cursor_cannot_reveal_rewound_message(tmp_path):
    store = SessionStore(tmp_path)
    turn = add(store, "a", "private prior turn " * 1000)
    reader = MemoryReader(tmp_path)
    first = reader.read_thread("a", limit=1)
    store.append_event(session_id="a", space="productivity", project="p",
                       event_type="rewind", actor="user", data={"turn_id": turn["id"]})
    rest = reader.read_thread("a", cursor=first["next_cursor"])
    assert rest["status"] == "stale_cursor" and rest["results"] == []


def test_index_corruption_repair_and_restart_receipts(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    add(store, "a")
    reader = MemoryReader(tmp_path)
    reader.search_conversation_history("needle")
    database = memory_database_path(tmp_path, "productivity")
    with sqlite3.connect(database) as conn:
        conn.execute("DELETE FROM conversation_chunks WHERE projection_kind='normal'")
    assert reader.search_conversation_history("needle")["results"]
    compaction._VALIDATED.clear()  # A process restart loses in-memory receipts.
    restarted = MemoryReader(tmp_path)
    counts = observe_logs(monkeypatch)
    assert restarted.search_conversation_history("needle")["results"]
    assert counts["a"] == 0  # Matching persisted metadata survives process restart.
    counts.clear()
    assert restarted.search_conversation_history("needle")["results"]
    assert counts == {}


def test_partial_compact_publication_retries_without_serving_stale_index(tmp_path, monkeypatch):
    from cleo.sessions import compact

    store = SessionStore(tmp_path)
    add(store, "a", "old")
    reader = MemoryReader(tmp_path)
    reader.search_conversation_history("old")
    append(store, "a", "new needle")
    original = compact.update_conversation_chunks

    def fail(*args, **kwargs):
        raise OSError("publication interrupted")

    monkeypatch.setattr(compact, "update_conversation_chunks", fail)
    failed = reader.search_conversation_history("needle")
    assert failed["status"] == "partial" and failed["results"] == []
    monkeypatch.setattr(compact, "update_conversation_chunks", original)
    # Restart recovers a compact file published before its SQLite index.
    recovered = reader.search_conversation_history("needle")
    assert recovered["status"] == "ok" and recovered["results"]
    restarted = MemoryReader(tmp_path)
    recovered = restarted.search_conversation_history("needle")
    assert recovered["status"] == "ok" and recovered["results"]


def test_corrupt_log_never_serves_cached_hits_then_recovers(tmp_path):
    store = SessionStore(tmp_path)
    add(store, "a")
    reader = MemoryReader(tmp_path)
    reader.search_conversation_history("needle")
    path = events_path(tmp_path, "productivity", "p", "a")
    original = path.read_bytes()
    path.write_text("{broken", encoding="utf-8")
    assert reader.search_conversation_history("needle")["results"] == []
    path.write_bytes(original)
    assert reader.search_conversation_history("needle")["results"]
    compact_path(tmp_path, "productivity", "p", "a").write_text("broken", encoding="utf-8")
    assert reader.search_conversation_history("needle")["results"]


def test_search_snapshot_expiration_and_bounds_preserve_pagination(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    add(store, "a", "needle first")
    append(store, "a", "needle second")
    reader = MemoryReader(tmp_path)
    first = reader.search_conversation_history("needle", limit=1)
    for snapshot in reader._searches.values():
        assert all(isinstance(hit, tuple) and len(hit) == 3 for hit in snapshot["hits"])
        snapshot["created"] -= 61
    second = reader.search_conversation_history("needle", limit=1, cursor=first["next_cursor"])
    assert first["results"][0]["event_ids"] != second["results"][0]["event_ids"]
    for number in range(12):
        reader.search_conversation_history(f"needle {number}")
    assert len(reader._searches) <= 8


def test_append_during_validation_cannot_freeze_stale_results(tmp_path, monkeypatch):
    from cleo.memory import reader as module

    store = SessionStore(tmp_path)
    add(store, "a")
    store.refresh_compact("a")
    reader = MemoryReader(tmp_path)
    original = module.validated_compact_source

    def append_after_validation(**kwargs):
        receipt = original(**kwargs)
        append(store, "a", "new evidence")
        return receipt

    monkeypatch.setattr(module, "validated_compact_source", append_after_validation)
    result = reader.search_conversation_history("needle")
    assert result["status"] == "stale_cursor" and result["results"] == []


def test_move_between_discovery_and_manifest_read_does_not_escape_scope(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    add(store, "a")
    reader = MemoryReader(tmp_path)
    original = reader._threads

    def move_after_discovery(space, project):
        rows = original(space, project)
        store.move_session("a", "q")
        return rows

    monkeypatch.setattr(reader, "_threads", move_after_discovery)
    result = reader.search_conversation_history("needle", project="p")
    assert result["results"] == []


def test_repeated_query_cost_comparison(tmp_path, monkeypatch, capsys):
    """Reproducible I/O comparison; timings are reported, never flaky assertions."""
    from time import perf_counter

    from cleo.memory.store import _conversation_chunks, _lexical_score

    store = SessionStore(tmp_path)
    for number in range(8):
        identifier = f"s{number}"
        add(store, identifier)
        store.append_events(session_id=identifier, space="productivity", project="p", events=[
            {"type": "user_message", "actor": "user", "content": "needle " + "context " * 80}
            for _ in range(100)
        ])
        store.refresh_compact(identifier)
    reader = MemoryReader(tmp_path)
    reader.search_conversation_history("needle")
    counts = observe_logs(monkeypatch)
    started = perf_counter()
    from cleo.memory import store as memory_store

    original_receipt = memory_store.load_conversation_validation
    monkeypatch.setattr(memory_store, "load_conversation_validation", lambda *a, **kw: None)
    for _ in range(3):
        # Former validation+rechunk path: full hash validation for each unchanged source.
        for number in range(8):
            compaction._VALIDATED.clear()
            payload = compaction.load_validated_compact(
                memory_root=tmp_path, space="productivity", project="p", session_id=f"s{number}")
            for chunk in _conversation_chunks(payload):
                _lexical_score("needle", "", chunk["content"], [])
    baseline_seconds = perf_counter() - started
    monkeypatch.setattr(memory_store, "load_conversation_validation", original_receipt)
    baseline_reads = sum(counts.values())
    counts.clear()
    started = perf_counter()
    for _ in range(3):
        assert reader.search_conversation_history("needle")["results"]
    indexed_seconds = perf_counter() - started
    assert counts == {} and baseline_reads == 24
    with capsys.disabled():
        print(f"retrieval comparison: 8 sessions / 808 chunks / 3 repeated searches; "
              f"full validation={baseline_reads} raw reads, {baseline_seconds:.4f}s; "
              f"warm indexed={sum(counts.values())} raw reads, {indexed_seconds:.4f}s")


def test_read_only_sqlite_connections_do_not_invalidate_search_cursor(tmp_path):
    from contextlib import ExitStack, closing

    store = SessionStore(tmp_path)
    add(store, "a", "needle first")
    append(store, "a", "needle second")
    reader = MemoryReader(tmp_path)
    first = reader.search_conversation_history("needle", limit=1)
    with ExitStack() as stack:
        for path, table in [(store.index_path, "sessions"),
                            (memory_database_path(tmp_path, "productivity"),
                             "conversation_chunks")]:
            conn = stack.enter_context(closing(sqlite3.connect(path)))
            conn.execute("BEGIN")
            conn.execute(f"SELECT * FROM {table}").fetchall()
        second = reader.search_conversation_history("needle", limit=1,
                                                    cursor=first["next_cursor"])
    assert second["status"] == "ok" and second["results"]


def test_search_cursor_resumes_same_version_after_reader_restart(tmp_path):
    store = SessionStore(tmp_path)
    add(store, "a", "needle first")
    append(store, "a", "needle second")
    first = MemoryReader(tmp_path).search_conversation_history("needle", limit=1)
    compaction._VALIDATED.clear()
    second = MemoryReader(tmp_path).search_conversation_history(
        "needle", limit=1, cursor=first["next_cursor"],
    )
    assert second["status"] == "ok"
    assert first["results"][0]["event_ids"] != second["results"][0]["event_ids"]


def test_receipts_survive_cache_eviction_across_more_than_512_sessions(tmp_path, monkeypatch):
    import json

    from cleo.memory.compaction import project_compact_events, write_compact_events
    from cleo.memory.paths import manifest_path
    from cleo.memory.store import update_conversation_chunks

    # Build valid file-first fixtures without 513 interactive create/append lifecycles.
    store = SessionStore(tmp_path)
    add(store, "seed", "needle receipt")
    template = store.load_manifest("seed")
    template_events = store.read_events("seed")
    for number in range(513):
        identifier = f"s{number:04}"
        events = [{**event, "session_id": identifier, "id": f"{event['id']}-{number}"}
                  for event in template_events]
        raw = events_path(tmp_path, "productivity", "p", identifier)
        raw.parent.mkdir(parents=True)
        raw.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        _, payload = write_compact_events(memory_root=tmp_path, space="productivity", project="p",
                                           session_id=identifier, events=events)
        manifest = {**template, "id": identifier, "last_compacted_seq": events[-1]["seq"],
                    "source_hash": payload["source"]["source_content_hash"]}
        manifest_path(tmp_path, "productivity", "p", identifier).write_text(
            json.dumps(manifest), encoding="utf-8")
        projected = project_compact_events(events)
        update_conversation_chunks(payload, normal=projected["normal"], fallback=[],
                                   batch_key=events[-1]["seq"], expected_prior_hash=None,
                                   reset=True,
                                   path=memory_database_path(tmp_path, "productivity"))
    store.rebuild_index()
    reader = MemoryReader(tmp_path)
    monkeypatch.setattr(compaction, "_VALIDATION_LIMIT", 8)
    assert reader.search_conversation_history("needle")["results"]
    assert len(compaction._VALIDATED) <= 8
    counts = observe_logs(monkeypatch)
    # Different queries bypass the short-lived search-result snapshot.
    assert reader.search_conversation_history("receipt")["results"]
    assert MemoryReader(tmp_path).search_conversation_history("needle receipt")["results"]
    assert counts == {}


def test_legacy_compression_policy_and_invalid_receipt_revalidate_once(tmp_path, monkeypatch):
    import json

    from cleo.memory.compact_file import decode_compact, read_compact_file
    from cleo.memory.tool_body import TOOL_BODY_VERSION

    store = SessionStore(tmp_path)
    add(store, "a")
    store.refresh_compact("a")
    path = compact_path(tmp_path, "productivity", "p", "a")
    old = decode_compact(read_compact_file(path))
    old["compression"].pop("tool_body_version")
    path.write_text(json.dumps(old), encoding="utf-8")
    reader = MemoryReader(tmp_path)
    assert reader.search_conversation_history("needle")["results"]
    assert decode_compact(read_compact_file(path))["compression"][
        "tool_body_version"] == TOOL_BODY_VERSION
    with sqlite3.connect(memory_database_path(tmp_path, "productivity")) as conn:
        head = json.loads(conn.execute(
            "SELECT content FROM conversation_chunks WHERE projection_kind='head'").fetchone()[0])
        head["validation"] = {"revision": "broken"}
        conn.execute("UPDATE conversation_chunks SET content=? WHERE projection_kind='head'",
                     (json.dumps(head),))
    compaction._VALIDATED.clear()
    counts = observe_logs(monkeypatch)
    assert MemoryReader(tmp_path).search_conversation_history("needle")["results"]
    assert counts["a"] == 1
    counts.clear()
    assert MemoryReader(tmp_path).search_conversation_history("needle")["results"]
    assert counts == {}


def test_query_time_index_repair_preserves_visible_recency(tmp_path):
    store = SessionStore(tmp_path)
    add(store, "a")
    before = store.load_manifest("a")["updated_at"]
    assert MemoryReader(tmp_path).search_conversation_history("needle")["results"]
    assert store.load_manifest("a")["updated_at"] == before
