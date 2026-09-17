import json
import sqlite3

import pytest
from openai_codex.generated.v2_all import ItemGuardianApprovalReviewCompletedNotification

from cleo.desktop.projection import finalize_stream_tools, stream_event_item, timeline_from_events
from cleo.desktop.timeline import TimelineIndex
from cleo.harnesses.service import AgentService
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.sessions.store import SessionStore


@pytest.mark.parametrize("status,label", [
    ("approved", "已允许"), ("denied", "已拒绝"), ("timedOut", "审查超时"), ("aborted", "已取消"),
])
def test_native_review_result_is_visible_live_and_after_cache_rebuild(tmp_path, status, label):
    payload = ItemGuardianApprovalReviewCompletedNotification.model_validate({
        "reviewId": "review", "threadId": "native", "turnId": "turn", "targetItemId": "tool",
        "action": {"type": "command", "command": "test-command", "cwd": str(tmp_path),
                   "source": "unifiedExec"},
        "review": {"status": status, "rationale": "native review reason"},
        "decisionSource": "agent", "startedAtMs": 1, "completedAtMs": 2,
    }).model_dump(by_alias=True, mode="json", exclude_none=True)
    event = CodexProvider(None)._event_from_notification(
        "item/autoApprovalReview/completed", payload,
    )
    assert event.type == "approval_review"
    event.data.update(turn_id="user-turn", timeline_id="user-turn:approval:review")
    live = stream_event_item(event, {})
    assert [e["type"] for e in live] == ["upsert-item"]  # Never opens a manual approval prompt.
    item = live[0]["item"]
    assert item["name"] == f"自动审查 · {label}"
    assert item["command"] == "test-command"
    assert "agent" in item["output"] and "native review reason" in item["output"]
    assert item["status"] == ("done" if status == "approved" else "error")
    store = SessionStore(tmp_path / "memory")
    manifest = store.create_session(
        session_id="history", space="productivity", project="test",
        provider="codex", owner_type="user",
    )
    stored = AgentService._stored_provider_event(event)
    # Older app versions saved native reviews as provider_event.
    stored["type"] = "provider_event"
    store.append_events(session_id="history", space="productivity", project="test", events=[
        {"id": "user-turn", "type": "user_message", "actor": "user", "content": "test"}, stored,
    ])
    index = TimelineIndex(store, manifest)
    assert index.page()["items"][-1]["name"] == item["name"]
    # Simulate a pre-upgrade index that had silently omitted the review event.
    with sqlite3.connect(index.path) as db:
        meta = json.loads(db.execute("SELECT value FROM metadata WHERE id=1").fetchone()[0])
        meta.pop("projection_version")
        db.execute("UPDATE metadata SET value=? WHERE id=1", (json.dumps(meta),))
        db.execute("DELETE FROM items WHERE json_extract(body,'$.type')='tool'")
    restored = index.page()["items"][-1]
    for field in ("id", "name", "command", "output", "status"):
        assert restored[field] == item[field]


def test_interrupted_review_never_becomes_an_approval():
    event = CodexProvider(None)._event_from_notification("item/autoApprovalReview/started", {
        "reviewId": "review", "action": {"command": "test-command"},
        "review": {"status": "inProgress"},
    })
    state = {}
    stream_event_item(event, state)
    result = finalize_stream_tools(state)[0]["item"]
    assert result["name"] == "自动审查 · 未完成"
    assert result["status"] == "error"
    assert "未收到审查结果" in result["output"]
    history = timeline_from_events([
        AgentService._stored_provider_event(event), {"type": "session_cancelled"},
    ])
    assert history[0]["name"] == result["name"]


def test_manual_decision_retains_request_and_source():
    history = timeline_from_events([{
        "type": "permission_response", "actor": "codex", "data": {"payload": {
            "id": "manual", "decision": "decline", "source": "user",
            "request": {"command": "test-command", "reason": "outside workspace"},
        }},
    }])
    assert history[0]["name"] == "人工审批 · 已拒绝"
    assert history[0]["command"] == "test-command"
    assert "outside workspace" in history[0]["output"]
