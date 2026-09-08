import json

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


def test_binary_and_secrets_redacted_but_tool_content_preserved():
    records = project_events([event(1, "tool_result", content={
        "content": "real tool body" * 1000,
        "api_key": "private-key", "token_count": 100,
        "image": {"type": "image_url", "image_url": {"url": "data:image/png;base64,secret"}},
    })])
    body = records[0].body
    assert body["content"]["content"] == "real tool body" * 1000
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


def test_langchain_tool_content_not_dropped_by_legacy_compactor():
    raw = event(1, "tool_result")
    raw["message"] = {"type": "tool", "data": {"content": "z" * 10000,
                                                 "tool_call_id": "call"}}
    records = project_events([raw])
    assert records[0].body["message"]["data"]["content"] == "z" * 10000
