from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

import cleo.sessions.event_log as event_log
import cleo.sessions.manifests as manifests
from cleo.memory.compaction import _canonical_json, event_content_hash, load_events
from cleo.sessions.event_log import JsonlEventStore
from cleo.sessions.store import SessionStore

SCOPE = {"session_id": "cached", "space": "non_productivity", "project": "general"}


def append(log, path, items):
    known, last = log.committed("cached", path)
    events, last = log.prepare(items, **SCOPE, known_ids=known, last_seq=last)
    return log.append("cached", path, events, known_ids=known, last_seq=last, fsync=False)


def item(identifier, content="中文 🐈", **extra):
    return {"id": identifier, "type": "user_message", "actor": "user", "content": content,
            "source_message_id": f"message-{identifier}", **extra}


def assert_revision(log, path):
    events = load_events(path) if path.exists() else []
    revision = log.revision("cached", path)
    assert revision.source_hash == event_content_hash(events)
    assert revision.raw_characters == len(_canonical_json(events))
    assert revision.event_count == len(events)
    assert revision.last_seq == (events[-1]["seq"] if events else 0)
    assert revision.end_offset == (path.stat().st_size if path.exists() else 0)
    return revision


def test_incremental_hash_matches_original_array_hash_across_batches_and_restart(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    assert_revision(log, path)
    for number in range(5):
        append(log, path, [item(str(number), {"nested": ["你好", number, None]})])
        assert_revision(log, path)
    assert assert_revision(JsonlEventStore(tmp_path), path) == log.revision("cached", path)
    assert log.source_message_ids("cached", path) == {f"message-{i}" for i in range(5)}


def test_warm_append_does_not_reserialize_or_read_old_events_or_copy_id_sets(tmp_path, monkeypatch):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item(str(number)) for number in range(500)])
    state = log._cache["cached"]
    ids, message_ids = state.ids, state.message_ids
    serialized = []
    canonical = event_log._canonical_json

    def serialize(event):
        serialized.append(event["id"])
        return canonical(event)

    monkeypatch.setattr(event_log, "_canonical_json", serialize)
    monkeypatch.setattr(event_log, "load_events", lambda *_: pytest.fail("warm log reread"))
    revision = append(log, path, [item("500")])
    assert serialized == ["500"] and revision.event_count == 501
    assert log._cache["cached"].ids is ids
    assert log._cache["cached"].message_ids is message_ids
    assert len(log.source_message_ids("cached", path)) == 501


def test_preparation_isolated_from_committed_ids_and_duplicate_retry_keeps_hash(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    before = append(log, path, [item("first")])
    known, last = log.committed("cached", path)
    log.prepare([item("not-written"), item("not-written")], **SCOPE,
                known_ids=known, last_seq=last)
    assert "not-written" in known
    assert "not-written" not in log.committed("cached", path)[0]
    after = append(log, path, [item("first")])
    assert before.source_hash == after.source_hash and after.event_count == 1
    assert "message-not-written" not in log.source_message_ids("cached", path)


def test_captured_revision_does_not_change_after_later_append(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    first = append(log, path, [item("first")])
    first_bytes = path.read_bytes()
    append(log, path, [item("second")])
    assert first.last_seq == 1 and first.end_offset == len(first_bytes)
    assert first.source_hash == event_content_hash(
        JsonlEventStore.read_prefix(path, first.last_seq),
    )
    assert first.event_count == 1


def test_external_append_and_path_change_rebuild_all_cached_metadata(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item("first")])
    other = JsonlEventStore(tmp_path)
    append(other, path, [item("outside")])
    assert_revision(log, path)
    assert log.source_message_ids("cached", path) == {"message-first", "message-outside"}
    replacement = tmp_path / "replacement.jsonl"
    append(other, replacement, [item("replacement")])
    assert_revision(log, replacement)
    assert log.committed("cached", replacement) == ({"replacement"}, 1)


def test_failed_append_invalidates_cache_without_remembering_unwritten_ids(tmp_path, monkeypatch):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item("first")])
    original_open = Path.open

    def fail_open(target, *args, **kwargs):
        if target == path and args and args[0] == "a":
            raise OSError("disk full")
        return original_open(target, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", fail_open)
        with pytest.raises(OSError, match="disk full"):
            append(log, path, [item("retry")])
        assert "cached" not in log._cache
    assert "retry" not in log.committed("cached", path)[0]
    append(log, path, [item("retry")])
    assert assert_revision(log, path).event_count == 2


def test_fsync_failure_rereads_successful_raw_append_without_duplicating_it(tmp_path, monkeypatch):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    known, last = log.committed("cached", path)
    events, last = log.prepare([item("first")], **SCOPE, known_ids=known, last_seq=last)

    def fail_fsync(*_args):
        raise OSError("fsync failed")

    with monkeypatch.context() as patch:
        patch.setattr(event_log.os, "fsync", fail_fsync)
        with pytest.raises(OSError, match="fsync failed"):
            log.append("cached", path, events, known_ids=known, last_seq=last, fsync=True)
    assert "cached" not in log._cache
    append(log, path, [item("first")])
    assert assert_revision(log, path).event_count == 1


def test_partial_json_tail_is_preserved_and_prevents_another_append(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item("first")])
    with path.open("ab") as stream:
        stream.write(b'{"id":"incomplete"')
    before = path.read_bytes()
    with pytest.raises(ValueError):
        append(log, path, [item("second")])
    assert path.read_bytes() == before
    assert "cached" not in log._cache


def test_failure_mid_write_invalidates_cache_and_preserves_the_partial_tail(tmp_path, monkeypatch):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item("first")])
    previous = path.read_bytes()
    original_open = Path.open

    class PartialWriter:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.stream.close()

        def write(self, text):
            self.stream.write(text[:len(text) // 2])
            raise OSError("partial write")

    def partial_open(target, *args, **kwargs):
        stream = original_open(target, *args, **kwargs)
        return PartialWriter(stream) if target == path and args and args[0] == "a" else stream

    with monkeypatch.context() as patch:
        patch.setattr(Path, "open", partial_open)
        with pytest.raises(OSError, match="partial write"):
            append(log, path, [item("second")])
    partial = path.read_bytes()
    assert partial.startswith(previous) and len(partial) > len(previous)
    assert "cached" not in log._cache
    with pytest.raises(ValueError):
        append(log, path, [item("second")])
    assert path.read_bytes() == partial


def test_complete_legacy_json_line_without_newline_keeps_a_valid_append_boundary(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item("first")])
    original = path.read_bytes().rstrip(b"\n")
    path.write_bytes(original)
    append(log, path, [item("second")])
    assert path.read_bytes().startswith(original + b"\n")
    assert assert_revision(log, path).event_count == 2


def test_manifest_failure_keeps_cache_aligned_with_committed_log(tmp_path, monkeypatch):
    store = SessionStore(tmp_path / "memory")
    store.create_session(**SCOPE, provider="cleo", owner_type="user")
    path = store._events.path(SCOPE["space"], SCOPE["project"], SCOPE["session_id"])

    def fail(*_args):
        raise OSError("manifest failed")

    with monkeypatch.context() as patch:
        patch.setattr(manifests, "atomic_write_json", fail)
        with pytest.raises(OSError, match="manifest failed"):
            store.append_events(**SCOPE, events=[item("first")])
    assert "first" in store._events.committed("cached", path)[0]
    assert "message-first" in store._events.source_message_ids("cached", path)
    assert_revision(store._events, path)
    assert store.append_events(**SCOPE, events=[item("first")]) == []


def test_cache_evicts_old_sessions_and_recovers_from_raw_logs(tmp_path):
    log = JsonlEventStore(tmp_path)
    paths = []
    for number in range(33):
        path = tmp_path / f"{number}.jsonl"
        path.write_text(json.dumps({"id": str(number), "seq": 1}) + "\n", encoding="utf-8")
        paths.append(path)
        log.revision(str(number), path)
    assert len(log._cache) == 32 and "0" not in log._cache
    assert log.revision("0", paths[0]).source_hash == event_content_hash(load_events(paths[0]))
    assert len(log._cache) == 32


def test_empty_revision_matches_legacy_empty_digest(tmp_path):
    revision = JsonlEventStore(tmp_path).revision("cached", tmp_path / "missing.jsonl")
    assert revision.source_hash == f"sha256:{hashlib.sha256(b'[]').hexdigest()}"
    assert (revision.event_count, revision.raw_characters, revision.end_offset) == (0, 2, 0)


@pytest.mark.parametrize("content", [
    {"nested": {2: "two", 10: "ten"}},
    {"nested": {1: "one", "two": "two"}},
    {"nested": {1: "numeric", "1": "string"}},
    {"nested": ("tuple", {2: ("two", "second")})},
    {"when": datetime(2026, 10, 8, 12, 30, tzinfo=UTC)},
])
def test_cached_digest_uses_json_normalized_events_as_they_are_read_from_disk(tmp_path, content):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    append(log, path, [item("before")])
    revision = append(log, path, [item("normalized", content)])
    assert revision == assert_revision(log, path)
    assert JsonlEventStore(tmp_path).revision("cached", path) == revision
    assert load_events(path)[-1]["content"] == json.loads(json.dumps(content, default=str))


def test_unserializable_batch_leaves_existing_source_unchanged(tmp_path):
    log, path = JsonlEventStore(tmp_path), tmp_path / "events.jsonl"
    previous = append(log, path, [item("before")])
    before = path.read_bytes()
    with pytest.raises(TypeError):
        append(log, path, [item("would-have-been-first"), item("invalid", {(1, 2): "bad key"})])
    assert path.read_bytes() == before
    assert "cached" not in log._cache
    assert assert_revision(log, path) == previous
    assert "would-have-been-first" not in log.committed("cached", path)[0]
    append(log, path, [item("invalid", "fixed")])
    assert assert_revision(log, path).event_count == 2
