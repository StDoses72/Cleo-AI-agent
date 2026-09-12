from pathlib import Path

import pytest

from cleo.desktop.timeline import TimelineIndex
from cleo.sessions.store import SessionStore


def fixture(tmp_path, events):
    store = SessionStore(tmp_path / "memory")
    manifest = store.create_session(
        session_id="history", space="productivity", project="p", provider="codex", owner_type="user"
    )
    store.append_events(session_id="history", space="productivity", project="p", events=events)
    return store, TimelineIndex(store, manifest)


def test_ten_thousand_items_page_both_ways_without_rereading_log(tmp_path, monkeypatch):
    events = [
        {
            "id": f"message-{i}",
            "type": "user_message" if i % 2 == 0 else "assistant_message",
            "actor": "user" if i % 2 == 0 else "codex",
            "content": f"message {i}",
        }
        for i in range(10000)
    ]
    _, index = fixture(tmp_path, events)
    page = index.page()
    assert len(page["items"]) == 80
    assert page["total"] == 10000
    original_open = Path.open

    def guarded(path, *args, **kwargs):
        assert path != index.source, "A page request reread the whole event log"
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded)
    ids = [i["id"] for i in page["items"]]
    while page["hasBefore"]:
        page = index.page(cursor=page["before"], direction="before")
        ids = [i["id"] for i in page["items"]] + ids
    assert ids == [f"message-{i}" for i in range(10000)]
    ids = [i["id"] for i in page["items"]]
    while page["hasAfter"]:
        page = index.page(cursor=page["after"], direction="after")
        ids += [i["id"] for i in page["items"]]
    assert ids == [f"message-{i}" for i in range(10000)]


def test_tool_updates_and_final_answer_survive_page_boundaries(tmp_path):
    store, index = fixture(
        tmp_path,
        [
            {"id": "u", "type": "user_message", "actor": "user", "content": "work"},
            {"id": "call", "type": "tool_call", "actor": "codex", "data": {"id": "tool"}},
            *[
                {"id": f"t{i}", "type": "thought", "actor": "codex", "content": str(i)}
                for i in range(600)
            ],
        ],
    )
    latest = index.page()
    cursor = latest["items"][-1]["cursor"]
    store.append_events(
        session_id="history",
        space="productivity",
        project="p",
        events=[
            {
                "type": "tool_result",
                "actor": "codex",
                "content": "x" * 50000,
                "data": {"id": "tool", "status": "completed"},
            },
            {"id": "answer", "type": "assistant_message", "actor": "codex", "content": "done"},
        ],
    )
    assert [i["id"] for i in index.page(cursor=cursor, direction="after")["items"]] == ["answer"]
    page = index.page()
    while page["hasBefore"]:
        page = index.page(cursor=page["before"], direction="before")
    tool = next(i for i in page["items"] if i["type"] == "tool")
    assert tool["status"] == "done"
    assert tool["turnHasAnswer"]
    assert len(tool["output"]) == 8192
    assert tool["more"]["output"] == 50000
    assert len(index.content(tool["id"], "output")["text"]) == 16384


def test_empty_history_and_rebuilt_cursor(tmp_path):
    _, index = fixture(tmp_path, [])
    page = index.page()
    assert not page["items"] and not page["hasBefore"] and not page["hasAfter"]
    index.path.unlink()
    with pytest.raises(ValueError, match="历史已变化"):
        index.page(cursor=page["before"], direction="before")


@pytest.mark.parametrize("status", ["failed", "cancelled", "completed"])
def test_unanswered_thoughts_remain_visible_after_terminal_status(tmp_path, status):
    _, index = fixture(tmp_path, [
        {"id": "u", "type": "user_message", "actor": "user", "content": "work"},
        {"id": "t", "type": "thought", "actor": "codex", "content": "Still investigating"},
        {"type": "assistant_fragment", "actor": "codex", "content": " \n",
         "data": {"timeline_id": "u:answer"}},
        {"type": f"session_{status}", "actor": "system"},
    ])
    thought = next(item for item in index.page()["items"] if item["type"] == "thought")
    assert thought["content"] == "Still investigating"
    assert not thought["turnHasAnswer"]


def test_corrupt_derived_index_rebuilds_without_changing_history(tmp_path):
    _, index = fixture(
        tmp_path,
        [
            {"id": "user", "type": "user_message", "actor": "user", "content": "preserve"},
        ],
    )
    before = index.source.read_bytes()
    index.path.write_bytes(b"broken derived cache")
    assert index.page()["items"][0]["content"] == "preserve"
    assert index.source.read_bytes() == before


def test_live_append_reads_only_new_bytes_even_in_one_long_turn(tmp_path, monkeypatch):
    store, index = fixture(
        tmp_path,
        [
            {"id": "u", "type": "user_message", "actor": "user", "content": "work"},
            *[
                {"id": f"t{i}", "type": "thought", "actor": "codex", "content": str(i)}
                for i in range(1000)
            ],
        ],
    )
    first = index.page()
    previous_size = index.source.stat().st_size
    store.append_events(
        session_id="history",
        space="productivity",
        project="p",
        events=[
            {
                "type": "assistant_fragment",
                "actor": "codex",
                "content": "first",
                "data": {"timeline_id": "u:answer"},
            },
            {"id": "u:answer", "type": "assistant_message", "actor": "codex", "content": "final"},
        ],
    )
    original_open = Path.open
    seeks = []

    class Reader:
        def __init__(self, stream):
            self.stream = stream

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stream.close()

        def seek(self, offset):
            seeks.append(offset)
            assert offset == previous_size
            return self.stream.seek(offset)

        def __getattr__(self, name):
            return getattr(self.stream, name)

    def open_log(path, *args, **kwargs):
        stream = original_open(path, *args, **kwargs)
        return Reader(stream) if path == index.source else stream

    monkeypatch.setattr(Path, "open", open_log)
    page = index.page(cursor=first["after"], direction="after")
    assert seeks == [previous_size]
    assert len(page["items"]) == 1
    assert page["items"][0]["content"] == "final"
    assert page["total"] == first["total"] + 1
