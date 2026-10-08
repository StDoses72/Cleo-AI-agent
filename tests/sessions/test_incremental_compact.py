"""Incremental SessionStore writes preserve the full compactor's observable projection."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from cleo.memory import compact_file
from cleo.memory.compaction import compact_events, load_validated_compact
from cleo.memory.paths import compact_path, events_path, memory_database_path
from cleo.memory.store import search_conversation_history
from cleo.sessions import compact as projection_module
from cleo.sessions import messages as messages_module
from cleo.sessions.store import SessionStore

SCOPE = {"session_id": "incremental", "space": "productivity", "project": "project"}


def event(identifier, kind="assistant_message", content="needle", **data):
    return {"id": identifier, "type": kind,
            "actor": "user" if kind in {"user_message", "rewind"} else "assistant",
            "content": content, "data": data}


def setup_store(tmp_path, initial):
    store = SessionStore(tmp_path / "memory")
    store.create_session(**SCOPE, provider="fixture", owner_type="user")
    store.append_events(**SCOPE, events=initial)
    store.refresh_compact(SCOPE["session_id"], materialize=False)
    return store


def paths(store):
    scope = (store.memory_root, SCOPE["space"], SCOPE["project"], SCOPE["session_id"])
    return events_path(*scope), compact_path(*scope)


def indexed_rows(store):
    with sqlite3.connect(memory_database_path(store.memory_root, SCOPE["space"])) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(
            "SELECT * FROM conversation_chunks ORDER BY chunk_index")]


def assert_oracle(store):
    actual = load_validated_compact(memory_root=store.memory_root, **SCOPE)
    expected = compact_events(**SCOPE, events=store.read_events(SCOPE["session_id"]),
                              source_version=actual["source"]["source_version"])
    actual["compression"].pop("compressed_at")
    expected["compression"].pop("compressed_at")
    assert actual == expected
    head = next(row for row in indexed_rows(store) if row["projection_kind"] == "head")
    assert head["source_hash"] == actual["source"]["source_content_hash"]
    return actual


def test_incremental_tail_keeps_unicode_line_separators_inside_json_strings(tmp_path):
    store = setup_store(tmp_path, [event("first", "user_message")])
    text = "before\u0085middle\u2028paragraph\u2029after"
    store.append_events(**SCOPE, events=[event("unicode", content=text)])
    store.refresh_compact(SCOPE["session_id"], materialize=False)
    payload = assert_oracle(store)
    assert next(item for item in payload["events"] if item["id"] == "unicode")["content"] == text


class TrackedStream:
    def __init__(self, stream, path, reads, writes):
        self.stream, self.path, self.reads, self.writes = stream, path, reads, writes

    def __enter__(self):
        self.stream.__enter__()
        return self

    def __exit__(self, *args):
        return self.stream.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.stream, name)

    def read(self, *args):
        offset = self.stream.tell()
        value = self.stream.read(*args)
        self.reads.append((self.path, offset, len(value)))
        return value

    def write(self, value):
        self.writes.append((self.path, self.stream.tell(), len(value)))
        return self.stream.write(value)


def test_warm_refresh_reads_only_new_tail_and_keeps_old_batches_and_index_rows(
    tmp_path, monkeypatch, record_property,
):
    initial = [event("u1", "user_message"), event("large", content="old body " * 30_000),
               event("u2", "user_message"), event("a2"), event("f1", "provider_event")]
    store = setup_store(tmp_path, initial)
    raw, compact = paths(store)
    old_raw_size, old_compact = raw.stat().st_size, compact.read_bytes()
    old_tail = store._compact._cache[SCOPE["session_id"]].receipt["tail_offset"]
    old_row = next(row for row in indexed_rows(store) if row["chunk_index"] == 0)
    delta = [event("u3", "user_message"), event("a3"), event("f2", "terminal_output")]
    appended = store.append_events(**SCOPE, events=delta)
    delta_bytes = raw.stat().st_size - old_raw_size
    reads, writes, projected = [], [], []
    original_open, original_project = Path.open, projection_module.project_compact_events

    def tracked_open(path, *args, **kwargs):
        stream = original_open(path, *args, **kwargs)
        return TrackedStream(stream, path, reads, writes) if path in {raw, compact} else stream

    def project(events, **kwargs):
        projected.append([item["id"] for item in events])
        return original_project(events, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", tracked_open)
        patch.setattr(store._events, "read", lambda *_: pytest.fail("warm full event read"))
        patch.setattr(projection_module, "project_compact_events", project)
        patch.setattr(projection_module, "read_compact_file",
                      lambda *_: pytest.fail("warm compact materialization"))
        patch.setattr(projection_module, "decode_compact",
                      lambda *_: pytest.fail("warm compact decode"))
        assert store.refresh_compact(SCOPE["session_id"], materialize=False) is None
        assert projected == [[item["id"] for item in appended]]
        assert [(offset, length) for path, offset, length in reads if path == raw] == [
            (old_raw_size, delta_bytes)]
        assert [(offset, length) for path, offset, length in reads if path == compact] == [
            (old_tail, len(old_compact) - old_tail)]
        assert all(offset >= old_tail for path, offset, _ in writes if path == compact)
        compact_written = sum(length for path, _, length in writes if path == compact)
        assert compact_written < 10_000 < len(old_compact)
        before_noop = (list(reads), list(writes), list(projected), compact.stat().st_mtime_ns)
        assert store.refresh_compact(SCOPE["session_id"], materialize=False) is None
        assert (reads, writes, projected, compact.stat().st_mtime_ns) == before_noop

    assert compact.read_bytes()[:old_tail] == old_compact[:old_tail]
    assert json.loads(compact.read_bytes())["batch_count"] == 2
    assert next(row for row in indexed_rows(store) if row["chunk_index"] == 0) == old_row
    assert_oracle(store)
    record_property("old_raw_bytes", old_raw_size)
    record_property("new_raw_bytes_read", delta_bytes)
    record_property("old_compact_bytes", len(old_compact))
    record_property("compact_bytes_written", compact_written)


@pytest.mark.parametrize("operation", ["late_tool_result", "reused_tool_call", "rewind"])
def test_cross_batch_dependencies_rebuild_and_match_full_projection(
    tmp_path, monkeypatch, operation,
):
    initial = [event("u1", "user_message"),
               event("call", tool_calls=[{"id": "call-1", "name": "echo", "args": {}}]),
               event("f1", "provider_event"), event("u2", "user_message"), event("a2")]
    store = setup_store(tmp_path, initial)
    if operation == "late_tool_result":
        delta = [event("late", "tool_result", content="late result", tool_call_id="call-1",
                       name="echo", status="success")]
    elif operation == "reused_tool_call":
        delta = [event("call-again", tool_calls=[{"id": "call-1", "name": "echo", "args": {}}])]
    else:
        delta = [event("rewind", "rewind", turn_id="u2"),
                 event("u3", "user_message", content="edited request"), event("a3")]
    store.append_events(**SCOPE, events=delta)
    read, full_reads = store._events.read, []

    def read_full(path):
        full_reads.append(path)
        return read(path)

    with monkeypatch.context() as patch:
        patch.setattr(store._events, "read", read_full)
        store.refresh_compact(SCOPE["session_id"], materialize=False)
    raw, compact = paths(store)
    assert full_reads == [raw]
    assert json.loads(compact.read_bytes())["batch_count"] == 1
    actual = assert_oracle(store)
    if operation == "late_tool_result":
        tool = next(item for item in actual["events"] if item["type"] == "tool_event")
        assert tool["result"] == "late result" and tool["status"] == "success"
    elif operation == "rewind":
        assert not {"u2", "a2"} & {item["id"] for item in actual["events"]}


def test_half_written_footer_failure_retries_from_authoritative_events(tmp_path, monkeypatch):
    store = setup_store(tmp_path, [event("u1", "user_message"), event("a1")])
    store.append_events(**SCOPE, events=[event("u2", "user_message"), event("a2")])
    _, compact = paths(store)
    before = indexed_rows(store)
    lock = compact_file.compact_file_lock

    class FailingFooter:
        def __init__(self, stream):
            self.stream = stream

        def __getattr__(self, name):
            return getattr(self.stream, name)

        def write(self, value):
            if value.startswith(b'],"source":'):
                self.stream.write(value[:len(value) // 2])
                self.stream.flush()
                raise OSError("injected half-footer write")
            return self.stream.write(value)

    @contextmanager
    def fail_footer(path, *, writable=False):
        with lock(path, writable=writable) as stream:
            yield FailingFooter(stream) if writable else stream

    with monkeypatch.context() as patch:
        patch.setattr(compact_file, "compact_file_lock", fail_footer)
        with pytest.raises(OSError, match="half-footer"):
            store.refresh_compact(SCOPE["session_id"], materialize=False)
    assert indexed_rows(store) == before
    with pytest.raises(json.JSONDecodeError):
        compact_file.read_compact_file(compact)
    store.refresh_compact(SCOPE["session_id"], materialize=False)
    assert json.loads(compact.read_bytes())["batch_count"] == 1
    assert_oracle(store)


def test_sql_commit_failure_rebuilds_file_and_index_on_retry(tmp_path):
    store = setup_store(tmp_path, [event("u1", "user_message"), event("a1")])
    store.append_events(**SCOPE, events=[event("u2", "user_message"), event("a2")])
    before = indexed_rows(store)
    database = memory_database_path(store.memory_root, SCOPE["space"])
    with sqlite3.connect(database) as conn:
        conn.execute("""CREATE TRIGGER fail_head BEFORE UPDATE ON conversation_chunks
            WHEN NEW.projection_kind='head'
            BEGIN SELECT RAISE(ABORT, 'injected index commit failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="index commit"):
        store.refresh_compact(SCOPE["session_id"], materialize=False)
    assert indexed_rows(store) == before
    with sqlite3.connect(database) as conn:
        conn.execute("DROP TRIGGER fail_head")
    store.refresh_compact(SCOPE["session_id"], materialize=False)
    assert json.loads(paths(store)[1].read_bytes())["batch_count"] == 1
    assert_oracle(store)


def test_manifest_publish_retry_does_not_append_duplicate_compact_batches(tmp_path, monkeypatch):
    store = setup_store(tmp_path, [event("u1", "user_message"), event("a1")])
    store.append_events(**SCOPE, events=[event("u2", "user_message"), event("a2")])

    def fail_manifest(*args, **kwargs):
        raise OSError("injected compact manifest failure")

    with monkeypatch.context() as patch:
        patch.setattr(store, "update_manifest", fail_manifest)
        with pytest.raises(OSError, match="compact manifest"):
            store.refresh_compact(SCOPE["session_id"], materialize=False)
    compact = paths(store)[1]
    before = compact.read_bytes(), compact.stat().st_mtime_ns, indexed_rows(store)
    with monkeypatch.context() as patch:
        patch.setattr(projection_module, "append_compact_file",
                      lambda *args, **kwargs: pytest.fail("duplicate batch append"))
        patch.setattr(projection_module, "write_compact_file",
                      lambda *args, **kwargs: pytest.fail("unnecessary full rebuild"))
        store.refresh_compact(SCOPE["session_id"], materialize=False)
    assert (compact.read_bytes(), compact.stat().st_mtime_ns, indexed_rows(store)) == before
    assert json.loads(compact.read_bytes())["batch_count"] == 2
    assert_oracle(store)


def test_message_sync_serializes_only_new_messages_and_keeps_original_no_id_indices(
    tmp_path, monkeypatch,
):
    store = SessionStore(tmp_path / "memory")
    history = [HumanMessage(content="first"), AIMessage(content="old", id="fixed-ai"),
               HumanMessage(content="second", id="fixed-human")]
    store.sync_langchain_messages(**SCOPE, messages=history, materialize=False)
    new_message = AIMessage(content="new")
    serialized, serialize = [], messages_module.message_to_dict

    def serialize_new(message):
        serialized.append(message)
        return serialize(message)

    with monkeypatch.context() as patch:
        patch.setattr(messages_module, "message_to_dict", serialize_new)
        store.sync_langchain_messages(**SCOPE, messages=[*history, new_message], materialize=False)
        assert len(serialized) == 1 and serialized[0] is new_message
        serialized.clear()
        store.sync_langchain_messages(**SCOPE, messages=[*history, new_message], materialize=False)
        assert serialized == []
    events = store.read_events(SCOPE["session_id"])
    assert [item["source_message_id"] for item in events if "source_message_id" in item] == [
        "human-0", "fixed-ai", "fixed-human", "ai-3"]
    assert_oracle(store)


@pytest.mark.parametrize("missing", ["database", "head", "last_normal"])
def test_missing_derived_index_rebuilds_during_the_same_refresh(tmp_path, monkeypatch, missing):
    initial = [event("u1", "user_message"), event("a1"),
               event("u2", "user_message"), event("a2"), event("f", "provider_event")]
    store = setup_store(tmp_path, initial)
    database = memory_database_path(store.memory_root, SCOPE["space"])
    raw, compact = paths(store)
    if missing == "database":
        database.unlink()
    else:
        with closing(sqlite3.connect(database)) as conn, conn:
            if missing == "head":
                conn.execute("DELETE FROM conversation_chunks WHERE projection_kind='head'")
            else:
                conn.execute("DELETE FROM conversation_chunks "
                             "WHERE projection_kind='normal' AND chunk_index=1")
        if missing == "last_normal":
            store.append_events(**SCOPE, events=[event("continuation", content="needle continued")])
    source_before = raw.read_bytes()
    full_reads, read = [], store._events.read

    def read_full(path):
        full_reads.append(path)
        return read(path)

    with monkeypatch.context() as patch:
        patch.setattr(store._events, "read", read_full)
        store.refresh_compact(SCOPE["session_id"], materialize=False)
    assert full_reads == [raw]
    assert raw.read_bytes() == source_before
    assert json.loads(compact.read_bytes())["batch_count"] == 1
    assert_oracle(store)
    results = search_conversation_history(
        space=SCOPE["space"], project=SCOPE["project"], query="needle",
        path=database, memory_root=store.memory_root,
    )
    assert {item["chunk_index"] for item in results} == {0, 1}
    if missing == "last_normal":
        assert any("needle continued" in item["content"] for item in results)
