from __future__ import annotations

import json
from threading import RLock

import pytest

from cleo.sessions.event_log import JsonlEventStore, is_durable_handoff
from cleo.sessions.index import SqliteSessionIndex
from cleo.sessions.messages import title_from_events
from cleo.sessions.store import SessionStore

SCOPE = {"session_id": "s1", "space": "productivity", "project": "cleo"}


def test_prepare_skips_known_ids_numbers_new_events_and_drops_empty_fields() -> None:
    known = {"old"}
    events, last = JsonlEventStore.prepare(
        [{"id": "old", "type": "user_message", "actor": "user"},
         {"id": "new", "type": "user_message", "actor": "user", "content": "hi",
          "data": {}, "message": None, "created_at": "2026-01-01T00:00:00+00:00"},
         {"type": "steer", "actor": "user", "data": {"text": "x"}}],
        **SCOPE, known_ids=known, last_seq=4,
    )
    assert last == 6
    assert [event["seq"] for event in events] == [5, 6]
    assert events[0] == {"schema_version": 1, "id": "new", "seq": 5, "session_id": "s1",
                         "space": "productivity", "project": "cleo", "type": "user_message",
                         "actor": "user", "created_at": "2026-01-01T00:00:00+00:00",
                         "content": "hi"}
    assert events[1]["id"].startswith("evt_") and events[1]["data"] == {"text": "x"}
    assert known == {"old", "new", events[1]["id"]}
    with pytest.raises(ValueError):
        JsonlEventStore.prepare([{"type": "", "actor": "user"}], **SCOPE,
                                known_ids=set(), last_seq=0)


def test_committed_state_is_reread_after_an_external_append(tmp_path) -> None:
    log = JsonlEventStore(tmp_path)
    path = tmp_path / "events.jsonl"
    events, last = log.prepare([{"id": "a", "type": "x", "actor": "user"}], **SCOPE,
                               known_ids=set(), last_seq=0)
    log.append("s1", path, events, known_ids={"a"}, last_seq=last, fsync=False)
    assert log.committed("s1", path) == ({"a"}, 1)

    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({**events[0], "id": "b", "seq": 2}) + "\n")
    assert log.committed("s1", path) == ({"a", "b"}, 2)


def test_handoff_detection_and_titles() -> None:
    assert is_durable_handoff([{"data": {"provider_event_type": "cleo/handoff"}}])
    assert not is_durable_handoff([{"data": {"provider_event_type": "tool"}}, {}])
    assert title_from_events([
        {"type": "session_created", "actor": "system"},
        {"type": "user_message", "actor": "user", "content": "   "},
        {"type": "user_message", "actor": "user", "content": "internal prompt",
         "data": {"display_prompt": "What the user typed"}},
    ]) == "What the user typed"


def test_index_is_rebuilt_from_manifests_after_it_is_deleted(tmp_path) -> None:
    store = SessionStore(tmp_path / "memory")
    store.create_session(**SCOPE, provider="fake", owner_type="user")
    store.index_path.unlink()

    assert store.load_manifest("s1")["id"] == "s1"
    index = SqliteSessionIndex(store.index_path, RLock())
    assert [row["id"] for row in index.rows(space="productivity")] == ["s1"]


def test_listing_rebuilds_an_index_that_went_missing(tmp_path) -> None:
    store = SessionStore(tmp_path / "memory")
    store.create_session(**SCOPE, provider="fake", owner_type="user")
    store.index_path.unlink()
    assert [row["id"] for row in store.list_sessions()] == ["s1"]

    store.index_path.unlink()
    reopened = SessionStore(tmp_path / "memory")
    assert [row["id"] for row in reopened.list_sessions(space="productivity")] == ["s1"]
