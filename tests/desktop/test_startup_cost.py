"""Loading the workspace must cost the same however much history there is.

A version switch waits 90 seconds for the new program to load its workspace, then rolls back; the
limit is fixed in programs that are already installed. v0.13.0 raised ``PROJECTION_VERSION``, so its
first start rebuilt every conversation's timeline index from the whole event log, and every start
also read every log for task usage and for the harness-switch status. On a 700 MB history the first
load took 95 seconds: the update was rolled back, the rollback had to rebuild the indexes again and
failed the same way, and so did the fallback program.

These tests pin the rule that came out of it: only the conversation being opened may pay for its
history. A listed conversation is neither rebuilt nor read.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from cleo.desktop.timeline import DEFER_REBUILD_BYTES, PROJECTION_VERSION, TimelineIndex
from cleo.harnesses.context import handoff_status
from tests.desktop.test_service import FakeAdapter, _service

TASKS = ("task-a", "task-b", "task-c")


def _conversation(store, session_id: str, space: str, project: str, text: str | None) -> dict:
    manifest = store.create_session(
        session_id=session_id, space=space, project=project, provider="codex", owner_type="user",
        **({"cwd": None} if space == "non_productivity" else {}),
    )
    if text is not None:
        store.append_events(session_id=session_id, space=space, project=project, events=[
            {"id": f"{session_id}-u", "type": "user_message", "actor": "user", "content": text},
            # Enough history that listing must not rebuild this conversation's index.
            {"id": f"{session_id}-t", "type": "thought", "actor": "codex",
             "content": "considering " * (DEFER_REBUILD_BYTES // 8)},
            {"id": f"{session_id}-a", "type": "assistant_message", "actor": "codex",
             "content": f"answer to {text}"},
        ])
    return manifest


def _stored_version(index: TimelineIndex) -> int | None:
    """The projection version an index file holds, or None when it was never built."""
    with closing(sqlite3.connect(index.path)) as db:
        row = db.execute("SELECT value FROM metadata WHERE id=1").fetchone()
    return json.loads(row[0])["projection_version"] if row else None


def _written_by_another_version(index: TimelineIndex) -> None:
    """Make an index look like one a different program version wrote: it needs a full rebuild."""
    with closing(sqlite3.connect(index.path)) as db, db:
        db.execute("UPDATE metadata SET value=json_set(value,'$.projection_version',0)")


def _desktop(tmp_path: Path):
    service = _service(tmp_path)
    service._adapter_instance = FakeAdapter(service.store)
    store = service.store
    indexes = {}
    for name in TASKS:
        manifest = _conversation(store, name, "productivity", "p", f"work on {name}")
        indexes[name] = TimelineIndex(store, manifest)
    chat = _conversation(store, "chat-a", "non_productivity", "general", "hello")
    indexes["chat-a"] = TimelineIndex(store, chat)
    for index in indexes.values():
        index.page()
        _written_by_another_version(index)
    read = []
    original = store.read_events

    def recording(session_id):
        read.append(session_id)
        return original(session_id)

    store.read_events = recording
    return service, indexes, read


def test_loading_the_workspace_rebuilds_and_reads_only_the_open_conversation(tmp_path) -> None:
    async def scenario() -> None:
        service, indexes, read = _desktop(tmp_path)

        workspace = await service.load_workspace()

        threads = {thread["id"]: thread for thread in workspace["threads"]}
        assert set(threads) == set(indexes), "every conversation is still listed"
        opened = workspace["activeThreadId"]
        assert opened in indexes
        rebuilt = {name for name, index in indexes.items()
                   if _stored_version(index) == PROJECTION_VERSION}
        assert rebuilt == {opened}, "only the open conversation's index may be rebuilt"
        assert set(read) <= {opened}, f"whole event logs were read for {sorted(set(read) - {opened})}"
        for name, thread in threads.items():
            if name == opened:
                continue
            # A sidebar row: what the index already held, and nothing computed from the log.
            assert thread["items"] == []
            assert "taskUsage" not in thread
            assert thread["skills"] is None
            assert thread["runtime"].get("handoffStatus") is None
            assert "stale" not in thread["history"]
        listed = next(name for name in TASKS if name != opened)
        assert threads[listed]["summary"] == f"answer to work on {listed}"

    asyncio.run(scenario())


def test_opening_a_conversation_rebuilds_its_index_and_fills_in_what_the_row_left_out(tmp_path) -> None:
    async def scenario() -> None:
        service, indexes, _read = _desktop(tmp_path)
        workspace = await service.load_workspace()
        other = next(name for name in TASKS if name != workspace["activeThreadId"])
        assert _stored_version(indexes[other]) == 0

        thread = await service.load_thread(thread_id=other)

        assert _stored_version(indexes[other]) == PROJECTION_VERSION
        contents = [item.get("content") for item in thread["items"]]
        assert contents[0] == f"work on {other}" and contents[-1] == f"answer to work on {other}"
        assert "taskUsage" in thread
        assert isinstance(thread["skills"], list)
        assert "handoffStatus" in thread["runtime"]

    asyncio.run(scenario())


def test_a_conversation_whose_index_is_missing_is_listed_without_building_it(tmp_path) -> None:
    async def scenario() -> None:
        service, indexes, read = _desktop(tmp_path)
        # The open conversation is rebuilt either way; look at the others.
        first = await service.load_workspace()
        others = [name for name in indexes if name != first["activeThreadId"]]
        for name in others:
            indexes[name].path.unlink()
        read.clear()

        workspace = await service.load_workspace()

        assert {thread["id"] for thread in workspace["threads"]} == set(indexes)
        assert "chat-a" in {thread["id"] for thread in workspace["threads"]}, (
            "a chat with messages must not be hidden because its index is not built yet")
        for name in others:
            assert _stored_version(indexes[name]) is None
        assert set(read) <= {first["activeThreadId"]}

    asyncio.run(scenario())


def test_a_chat_that_was_never_used_stays_hidden(tmp_path) -> None:
    async def scenario() -> None:
        service, _indexes, _read = _desktop(tmp_path)
        store = service.store
        _conversation(store, "chat-empty", "non_productivity", "general", None)
        # Its log is small, so listing still indexes it and can tell that nothing was said.
        empty = TimelineIndex(store, store.load_manifest("chat-empty"))
        assert not empty.path.exists()

        workspace = await service.load_workspace()

        assert "chat-empty" not in {thread["id"] for thread in workspace["threads"]}
        assert _stored_version(empty) == PROJECTION_VERSION

    asyncio.run(scenario())


def test_new_events_reach_a_listed_conversation_without_a_rebuild(tmp_path) -> None:
    store = _service(tmp_path).store
    manifest = _conversation(store, "task-a", "productivity", "p", "first")
    index = TimelineIndex(store, manifest)
    first_total = index.page()["total"]
    store.append_events(session_id="task-a", space="productivity", project="p", events=[
        {"id": "u2", "type": "user_message", "actor": "user", "content": "second"},
    ])

    page = TimelineIndex(store, manifest).page(limit=1, rebuild=False)

    # A current index only needs the appended bytes, so listing keeps it up to date.
    assert "stale" not in page
    assert page["total"] == first_total + 1
    assert page["items"][0]["content"] == "second"


def test_listing_serves_the_rows_an_older_index_holds(tmp_path) -> None:
    store = _service(tmp_path).store
    manifest = _conversation(store, "task-a", "productivity", "p", "first")
    index = TimelineIndex(store, manifest)
    built = index.page()
    _written_by_another_version(index)
    before = index.path.read_bytes()

    page = TimelineIndex(store, manifest).page(limit=1, rebuild=False)

    assert page["stale"] is True
    assert page["total"] == built["total"]
    assert page["items"][0]["content"] == "answer to first"
    assert index.path.read_bytes() == before, "listing must not rewrite an index it cannot trust"


def _switch(store, session_id: str, switch_id: str, kind: str) -> None:
    payload = {} if kind == "cleo/harness_switch" else {"switch_id": switch_id}
    store.append_events(session_id=session_id, space="productivity", project="p", events=[{
        **({"id": switch_id} if kind == "cleo/harness_switch" else {}),
        "type": "provider_event", "actor": "system",
        "data": {"provider_event_type": kind, "payload": payload},
    }])


def test_harness_switch_status_from_the_index_matches_the_whole_log(tmp_path) -> None:
    store = _service(tmp_path).store
    manifest = _conversation(store, "task-a", "productivity", "p", "switch harness")
    index = TimelineIndex(store, manifest)

    def both() -> tuple[str | None, str | None]:
        return (handoff_status(TimelineIndex(store, manifest).handoff_events()),
                handoff_status(store.read_events("task-a")))

    assert both() == (None, None)
    # Text that only mentions the event names, from a tool and from the user, is not a switch.
    store.append_events(session_id="task-a", space="productivity", project="p", events=[
        {"type": "provider_event", "actor": "codex",
         "data": {"provider_event_type": "tool_result",
                  "payload": {"output": '"provider_event_type":"cleo/harness_switch"'}}},
        {"id": "u2", "type": "user_message", "actor": "user", "content": "cleo/handoff_delivered"},
    ])
    assert both() == (None, None)
    _switch(store, "task-a", "switch-1", "cleo/harness_switch")
    assert both() == ("prepared", "prepared")
    _switch(store, "task-a", "switch-1", "cleo/handoff_submitted")
    assert both() == ("submitted", "submitted")
    _switch(store, "task-a", "switch-1", "cleo/handoff_delivered")
    assert both() == ("completed", "completed")
    _switch(store, "task-a", "switch-2", "cleo/harness_switch")
    assert both() == ("prepared", "prepared")
    assert len(index.handoff_events()) == 4, "only the four switch events are decoded"


def test_rebuilding_the_session_index_replaces_it_in_one_step(tmp_path) -> None:
    store = _service(tmp_path).store
    for name in TASKS:
        _conversation(store, name, "productivity", "p", name)
    # A row for a session whose files are gone, as a copied or cleaned-up home can leave behind.
    ghost = dict(store.load_manifest("task-a"), id="ghost")
    store._index.upsert(ghost, tmp_path / "memory" / "gone" / "manifest.json")
    assert store._index.row("ghost") is not None

    assert store.rebuild_index() == len(TASKS)

    assert store._index.row("ghost") is None
    assert {row["id"] for row in store.list_sessions()} == set(TASKS)
