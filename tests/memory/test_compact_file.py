import copy
import json
import multiprocessing
import os
import queue
from contextlib import contextmanager
from pathlib import Path

import pytest

from cleo.memory import compact_file
from cleo.memory.compact_file import (
    append_compact_file,
    compact_file_lock,
    compact_signature,
    decode_compact,
    read_compact_file,
    write_compact_file,
)
from cleo.memory.compaction import (
    _canonical_json,
    compact_events,
    load_validated_compact,
    project_compact_events,
)
from cleo.memory.paths import compact_path
from cleo.sessions.store import SessionStore


def event(seq, kind, content="", **fields):
    return {"id": f"event-{seq}", "seq": seq, "type": kind, "content": content,
            "created_at": f"time-{seq}", **fields}


def payload(events):
    return compact_events(space="productivity", project="demo", session_id="session", events=events)


def batch(events, full, *, index_base=0):
    projected = project_compact_events(events, visible_index_base=index_base)
    return {"from_seq": events[0]["seq"] if events else 0,
            "to_seq": events[-1]["seq"] if events else 0,
            "source_hash": full["source"]["source_content_hash"],
            "normal": projected["normal"], "fallback": projected["fallback"]}


def append(path, receipt, fresh, full):
    return append_compact_file(path, fresh, full["source"], full["compression"],
                               expected_signature=receipt["signature"],
                               tail_offset=receipt["tail_offset"],
                               batch_count=receipt["batch_count"])


def test_batches_preserve_v2_order_and_existing_file_prefix(tmp_path):
    path = tmp_path / "compact.json"
    first = [event(1, "user_message", "你好"), event(2, "provider_event", "plan")]
    second = [event(3, "assistant_message", "answer"), event(4, "file_change", "é/文件.py")]
    initial = payload(first)
    receipt = write_compact_file(path, initial, batch(first, initial))
    prefix = path.read_bytes()[:receipt["tail_offset"]]
    combined = payload(first + second)
    updated = append(path, receipt, batch(second, combined, index_base=len(first)), combined)
    assert path.read_bytes().startswith(prefix)
    assert updated["signature"] == compact_signature(path)
    assert updated["batch_count"] == 2
    assert path.read_bytes()[updated["tail_offset"]:].startswith(b'],"source":')
    disk = read_compact_file(path)
    assert disk["schema_version"] == 3
    assert decode_compact(disk) == combined
    assert [record["id"] for record in combined["events"]] == [
        "event-1", "event-3", "event-2", "event-4",
    ]


def test_empty_baseline_and_footer_that_shrinks(tmp_path):
    path = tmp_path / "compact.json"
    empty = payload([])
    empty["compression"]["compressed_at"] = "long" * 300
    receipt = write_compact_file(path, empty, batch([], empty))
    events = [event(1, "user_message", "first")]
    full = payload(events)
    receipt = append(path, receipt, batch(events, full), full)
    assert decode_compact(read_compact_file(path)) == full
    assert receipt["signature"] == compact_signature(path)
    assert not list(tmp_path.glob("*.tmp"))


def test_many_complete_batches_keep_old_bytes_and_match_full_projection(tmp_path):
    path = tmp_path / "compact.json"
    history = []
    receipt = None
    for turn in range(12):
        start = len(history) + 1
        fresh = [event(start, "user_message", f"turn {turn}: 中文 😀"),
                 event(start + 1, "assistant_message", data={"tool_calls": [
                     {"id": f"call-{turn}", "name": "run", "args": {"command": "test"}},
                 ]}),
                 event(start + 2, "tool_result", "ok",
                       data={"tool_call_id": f"call-{turn}", "name": "run"}),
                 event(start + 3, "provider_event", f"plan-{turn}")]
        previous_count = len(history)
        history.extend(fresh)
        full = payload(history)
        new_batch = batch(fresh, full, index_base=previous_count)
        if receipt is None:
            receipt = write_compact_file(path, full, new_batch)
        else:
            prefix = path.read_bytes()[:receipt["tail_offset"]]
            receipt = append(path, receipt, new_batch, full)
            assert path.read_bytes().startswith(prefix)
        assert decode_compact(read_compact_file(path)) == full
        assert receipt["signature"] == compact_signature(path)
        assert receipt["batch_count"] == turn + 1


def test_projection_preserves_fallback_message_indices_and_statistics():
    first = [event(1, "user_message", "one"), event(2, "provider_event", "plan")]
    second = [event(3, "assistant_message", message={"type": "ai", "data": {"content": "two"}})]
    projected = project_compact_events(second, visible_index_base=2)
    assert projected["normal"][0]["source_message_id"] == "ai-2"
    full = payload(first + second)
    assert projected["normal"][0] == full["events"][1]
    whole = project_compact_events(first + second)
    stats = whole["stats"]
    assert stats["visible_event_count"] == 3
    assert stats["record_characters"] + max(0, stats["totalrecords"] - 1) + 2 == len(
        _canonical_json(full["events"]),
    )


def test_full_projection_keeps_tool_pairing_redaction_and_rewind():
    events = [event(1, "user_message", "first"),
              event(2, "assistant_message", data={"tool_calls": [
                  {"id": "call", "name": "read_file", "args": {"api_key": "secret"}},
              ]}),
              event(3, "tool_result", "x" * 1200,
                    data={"tool_call_id": "call", "name": "read_file"})]
    projected = project_compact_events(events)
    tool = projected["normal"][1]
    assert tool["source_event_ids"] == ["event-2", "event-3"]
    assert tool["args"]["api_key"] == "<redacted>"
    assert tool["result_omitted"] is True
    assert projected["stats"]["omitted_tool_characters"] == 1200
    assert projected["stats"]["tool_event_count"] == 1
    events.append(event(4, "rewind", data={"turn_id": "event-1"}))
    assert project_compact_events(events)["normal"] == []
    assert payload(events)["events"] == []


def test_legacy_and_v3_use_the_same_validated_reader(tmp_path):
    store = SessionStore(tmp_path)
    store.create_session(session_id="session", space="productivity", project="demo",
                         provider="test", owner_type="user")
    events = store.read_events("session")
    full = payload(events)
    path = compact_path(tmp_path, "productivity", "demo", "session")
    path.write_text(json.dumps(full), encoding="utf-8")
    arguments = dict(memory_root=tmp_path, space="productivity", project="demo",
                     session_id="session")
    assert load_validated_compact(**arguments) == full
    write_compact_file(path, full, batch(events, full))
    assert load_validated_compact(**arguments) == full
    store.append_event(session_id="session", space="productivity", project="demo",
                       event_type="user_message", actor="user", content="new")
    with pytest.raises(ValueError, match="stale"):
        load_validated_compact(**arguments)


@pytest.mark.parametrize("change", ["signature", "offset", "count", "source"])
def test_append_rejects_stale_receipts_before_writing(tmp_path, change):
    path = tmp_path / "compact.json"
    first = [event(1, "user_message", "one")]
    full = payload(first)
    receipt = write_compact_file(path, full, batch(first, full))
    new_events = [event(2, "assistant_message", "two")]
    combined = payload(first + new_events)
    if change == "signature":
        path.write_bytes(path.read_bytes() + b" ")
    elif change == "offset":
        receipt["tail_offset"] -= 1
    elif change == "count":
        receipt["batch_count"] += 1
    else:
        combined["source"]["from_seq"] = 999
    before = path.read_bytes()
    with pytest.raises(ValueError):
        append(path, receipt, batch(new_events, combined), combined)
    assert path.read_bytes() == before


@pytest.mark.parametrize("mutation", ["replacement", "truncation"])
def test_append_receipt_rejects_file_changed_after_handle_closes(tmp_path, monkeypatch, mutation):
    path = tmp_path / "compact.json"
    first = [event(1, "user_message", "one")]
    full = payload(first)
    receipt = write_compact_file(path, full, batch(first, full))
    baseline = path.read_bytes()
    new_events = [event(2, "assistant_message", "two")]
    combined = payload(first + new_events)
    original_lock = compact_file.compact_file_lock

    @contextmanager
    def change_after_close(target, *, writable=False):
        with original_lock(target, writable=writable) as stream:
            yield stream
        if writable:
            if mutation == "replacement":
                # Preserve the size to ensure inode identity, not just length, is checked.
                replacement = tmp_path / "replacement.json"
                replacement.write_bytes(baseline + b" " * (target.stat().st_size - len(baseline)))
                os.replace(replacement, target)
            else:
                target.write_bytes(baseline)

    monkeypatch.setattr(compact_file, "compact_file_lock", change_after_close)
    with pytest.raises(ValueError, match="receipt"):
        append(path, receipt, batch(new_events, combined), combined)
    assert decode_compact(read_compact_file(path)) == full


def test_failed_rebuild_keeps_old_file_and_cleans_temporary(tmp_path, monkeypatch):
    path = tmp_path / "compact.json"
    first = [event(1, "user_message", "one")]
    full = payload(first)
    write_compact_file(path, full, batch(first, full))
    before = path.read_bytes()
    def fail(*_args):
        raise OSError("replacement failed")
    monkeypatch.setattr(compact_file.os, "replace", fail)
    with pytest.raises(OSError, match="replacement failed"):
        write_compact_file(path, full, batch(first, full))
    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]


def test_torn_tail_is_rejected_and_can_be_rebuilt(tmp_path):
    path = tmp_path / "compact.json"
    events = [event(1, "user_message", "one")]
    full = payload(events)
    receipt = write_compact_file(path, full, batch(events, full))
    with path.open("r+b") as stream:
        stream.seek(receipt["tail_offset"])
        stream.write(b',{"from_seq":')
        stream.truncate()
    with pytest.raises(ValueError):
        read_compact_file(path)
    write_compact_file(path, full, batch(events, full))
    assert decode_compact(read_compact_file(path)) == full


def test_decode_rejects_complete_json_with_mismatched_footer(tmp_path):
    path = tmp_path / "compact.json"
    events = [event(1, "user_message", "one")]
    full = payload(events)
    write_compact_file(path, full, batch(events, full))
    disk = read_compact_file(path)
    for key, value in (("to_seq", 7), ("source_content_hash", "sha256:wrong")):
        corrupt = copy.deepcopy(disk)
        corrupt["source"][key] = value
        with pytest.raises(ValueError, match="footer"):
            decode_compact(corrupt)


def _partial_writer(path, offset, acquired, release):
    with compact_file_lock(Path(path), writable=True) as stream:
        stream.seek(offset)
        footer = stream.read()
        stream.seek(offset)
        stream.write(b",partial")
        stream.flush()
        acquired.set()
        if not release.wait(10):
            raise RuntimeError("Reader test did not release writer")
        stream.seek(offset)
        stream.write(footer)
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())


def _separate_reader(path, started, results):
    started.set()
    try:
        result = decode_compact(read_compact_file(Path(path)))
        results.put(("ok", [record["id"] for record in result["events"]]))
    except Exception as error:
        results.put(("error", repr(error)))


def test_separate_process_reader_waits_for_footer_writer(tmp_path):
    path = tmp_path / "compact.json"
    events = [event(1, "user_message", "one")]
    full = payload(events)
    receipt = write_compact_file(path, full, batch(events, full))
    context = multiprocessing.get_context("spawn")
    acquired, release, started = context.Event(), context.Event(), context.Event()
    results = context.Queue()
    writer = context.Process(target=_partial_writer,
                             args=(str(path), receipt["tail_offset"], acquired, release))
    reader = context.Process(target=_separate_reader, args=(str(path), started, results))
    writer.start()
    try:
        assert acquired.wait(10)
        reader.start()
        assert started.wait(10)
        with pytest.raises(queue.Empty):
            results.get(timeout=0.3)
        release.set()
        assert results.get(timeout=10) == ("ok", ["event-1"])
    finally:
        release.set()
        for process in (writer, reader):
            if process.pid is not None:
                process.join(10)
                if process.is_alive():
                    process.terminate()
                    process.join(5)
        results.close()
        results.join_thread()
    assert writer.exitcode == reader.exitcode == 0
