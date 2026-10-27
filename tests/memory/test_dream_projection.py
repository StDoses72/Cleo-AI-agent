import json

import pytest

from cleo.memory.consolidation import Extraction
from cleo.memory.dream_projection import MAX_BLOCK_BYTES, build_blocks, project_events, token_count


def event(seq, kind, *, content=None, method=None, payload=None):
    result = {"id": f"event-{seq}", "seq": seq, "type": kind}
    if content is not None:
        result["content"] = content
    if method:
        result["data"] = {
            "provider": "codex", "provider_event_type": method,
            "payload": {"threadId": "thread", "turnId": "turn", **(payload or {})},
        }
    return result


def delta(seq, text):
    return event(seq, "terminal_output", content=text,
                 method="item/commandExecution/outputDelta",
                 payload={"itemId": "call", "delta": text})


def result(seq, output):
    return event(seq, "tool_result", method="item/completed", payload={"item": {
        "id": "call", "type": "commandExecution", "status": "completed",
        "exitCode": 0, "aggregatedOutput": output,
    }})


def test_streams_keep_repeated_text_and_all_source_evidence():
    records = project_events([delta(1, "ha"), delta(2, "ha"), result(3, "haha")])
    assert records[0].body["output"] == "haha"
    assert records[0].event_ids == ["event-1", "event-2"]
    assert records[1].body["item"]["aggregatedOutput"] == "haha"
    blocks = build_blocks(records, budget=2000)
    assert "same_output_as" in blocks[0].text
    assert blocks[0].evidence["E1"] == ["event-1", "event-2"]


def test_intervening_user_and_mismatched_result_are_not_merged():
    records = project_events([
        delta(1, "a"), event(2, "user_message", content="stop"),
        delta(3, "b"), result(4, "different"),
    ])
    assert [r.seq for r in records] == [1, 2, 3, 4]
    text = "\n".join(b.text for b in build_blocks(records, budget=2000))
    assert "different" in text and "same_output_as" not in text


def test_full_large_json_and_unicode_message_survive_splitting():
    content = "用户更正：0012可以使用。" * 500
    records = project_events([
        event(1, "user_message", content=content),
        event(2, "tool_result", content={"values": list(range(2000))}),
        event(3, "future_event", content="unknown retained"),
    ])
    blocks = build_blocks(records, budget=1000)
    parts = {}
    for block in blocks:
        assert token_count(block.text) <= 1000
        assert len(block.text.encode("utf-8")) <= MAX_BLOCK_BYTES
        for line in block.text.splitlines():
            row = json.loads(line)
            parts.setdefault(row["record"], []).append(row)
    for record in records:
        rows = parts[record.ref]
        restored = (json.loads("".join(r["fragment"] for r in rows))
                    if "fragment" in rows[0] else rows[0])
        assert restored["body"] == record.body
    assert records[0].body["content"] == content


def test_no_dangling_references_after_block_boundary():
    records = project_events([delta(1, "x " * 700), result(2, "x " * 700)])
    first_size = token_count(build_blocks(records[:1], budget=5000)[0].text)
    blocks = build_blocks(records, budget=first_size)
    assert len(blocks) > 1
    assert "same_output_as" not in blocks[-1].text
    assert "x " * 100 in "".join(b.text for b in blocks)


def test_binary_and_secrets_redacted_and_tool_body_excerpted():
    records = project_events([event(1, "tool_result", content={
        "content": "real tool body" * 1000,
        "api_key": "private-key", "token_count": 100,
        "image": {"type": "image_url", "image_url": {"url": "data:image/png;base64,secret"}},
    })])
    body = records[0].body
    assert "omitted content" in body["content"]["content"]
    assert len(body["content"]["content"]) < 3000
    assert body["content"]["api_key"] == "<redacted>"
    assert "base64" not in json.dumps(body)
    assert body["content"]["token_count"] == 100


def test_repeated_user_events_remain_distinct_and_noise_is_explicit():
    records = project_events([
        event(1, "user_message", content="same"),
        event(2, "user_message", content="same"),
        event(3, "status", method="thread/tokenUsage/updated", payload={"tokens": 99}),
        event(4, "session_cancelled"),
    ])
    assert [r.seq for r in records] == [1, 2, 4]
    assert records[-1].kind == "session_cancelled"


def test_langchain_tool_content_excerpt_keeps_source_reference():
    raw = event(1, "tool_result")
    raw["message"] = {"type": "tool", "data": {"content": "z" * 10000,
                                                 "tool_call_id": "call"}}
    records = project_events([raw])
    assert "omitted content" in records[0].body["message"]["data"]["content"]
    assert records[0].event_ids == ["event-1"]


def test_projection_uses_active_history_after_multiple_rewinds():
    first = event(1, "user_message", content="keep")
    removed = event(2, "user_message", content="removed preference")
    marker = {**event(4, "rewind"), "data": {"turn_id": removed["id"]}}
    replacement = event(5, "user_message", content="replacement")
    records = project_events([first, removed, delta(3, "removed output"), marker, replacement])
    assert [record.seq for record in records] == [1, 5]
    text = "\n".join(block.text for block in build_blocks(records))
    assert "removed" not in text


def test_long_tool_transcript_retains_lifecycle_and_user_constraints_without_raw_mutation():
    output = ("checking unchanged dependency\n" * 20_000
              + "ERROR: connection failed\nCancelled: retry after reconnect\n"
              + "checking unchanged dependency\n" * 20_000
              + "Recovered: resumed successfully\n312 tests passed\n")
    raw = [event(1, "user_message", content="Always preserve my original files."),
           delta(2, output), result(3, output),
           event(4, "session_cancelled"), event(5, "session_resumed")]
    original = json.dumps(raw)
    records = project_events(raw)
    blocks = build_blocks(records)
    projected = "\n".join(block.text for block in blocks)
    assert len(projected) < len(original) // 100
    assert json.dumps(raw) == original
    assert all(text in projected for text in [
        "Always preserve my original files.", "connection failed", "Cancelled",
        "Recovered", "312 tests passed", "session_cancelled", "session_resumed",
        "omitted content", "same_output_as",
    ])
    assert blocks[0].evidence["E2"] == ["event-2"]
    with pytest.raises(ValueError, match="direct user evidence"):
        Extraction.model_validate({"edits": [{"new": "Prefer retries.",
                                               "evidence_refs": ["E2"]}]}).validate_evidence(
            blocks[0],
        )


def test_compact_file_read_failure_retains_tail_and_raw_reference():
    from cleo.memory.compaction import _compact_tool_result

    body, omitted = _compact_tool_result(
        "read_file", "error", "progress\n" * 1000 + "ERROR: permission denied; no files changed",
    )
    assert "permission denied" in body["result"]
    assert body["result_truncated"] and omitted > 0


def test_deleting_conflicting_default_requires_direct_user_evidence():
    block = build_blocks(project_events([
        event(1, "user_message", content="Remove the old English default; use Chinese."),
        event(2, "tool_result", content="Default English."),
    ]))[0]
    for refs in ([], ["E2"]):
        with pytest.raises(ValueError, match="evidence"):
            result = Extraction.model_validate({"edits": [{"old": "Default English.",
                                                          "evidence_refs": refs}]})
            result.validate_evidence(block)
    Extraction.model_validate({"edits": [{"old": "Default English.",
                                           "evidence_refs": ["E1"]}]}).validate_evidence(block)


def test_large_structured_tool_excerpt_cannot_reintroduce_redacted_secrets():
    from cleo.memory.compaction import _compact_tool_result

    result, _ = _compact_tool_result("query", "success", json.dumps({
        "api_key": "private-credential", "rows": list(range(3000)),
        "nested": {"password": "private-password"},
    }))
    rendered = json.dumps(result)
    assert "private-credential" not in rendered and "private-password" not in rendered
    assert "<redacted>" in rendered and result["result_truncated"]
