from cleo.desktop.projection import (
    changes_from_diff,
    finalize_stream_tools,
    stream_event_item,
    timeline_from_events,
)
from cleo.harnesses.models import AgentEvent


def test_changes_from_diff_splits_files_and_counts_lines() -> None:
    diff = """diff --git a/a.py b/a.py
--- a/a.py
+++ b/a.py
@@ -1 +1,2 @@
 old
+new
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
"""

    changes = changes_from_diff(diff)

    assert changes == [
        {
            "path": "a.py",
            "status": "modified",
            "additions": 1,
            "deletions": 0,
            "diff": "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1,2 @@\n old\n+new",
        },
        {
            "path": "old.txt",
            "status": "deleted",
            "additions": 0,
            "deletions": 1,
            "diff": (
                "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n"
                "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone"
            ),
        },
    ]


def test_timeline_from_events_projects_messages_and_tools() -> None:
    events = [
        {"id": "u1", "type": "user_message", "content": "hello"},
        {
            "id": "t1",
            "type": "tool_call",
            "data": {
                "payload": {"item": {"id": "call-1", "tool": "shell", "command": "git status"}}
            },
        },
        {
            "id": "t2",
            "type": "tool_result",
            "data": {
                "payload": {"item": {"id": "call-1", "status": "completed", "output": "clean"}}
            },
        },
        {"id": "a1", "type": "assistant_message", "content": "done"},
    ]

    items = timeline_from_events(events)

    assert [item["type"] for item in items] == ["message", "tool", "message"]
    assert items[1]["status"] == "done"
    assert items[1]["output"] == "clean"


def test_timeline_from_events_updates_one_plan_per_turn() -> None:
    events = [
        {"id": "u1", "type": "user_message", "content": "inspect"},
        {
            "id": "p1",
            "type": "plan_update",
            "data": {
                "payload": {
                    "turnId": "turn-1",
                    "plan": [
                        {"step": "inspect", "status": "in_progress"},
                        {"step": "verify", "status": "pending"},
                    ],
                }
            },
        },
        {
            "id": "p2",
            "type": "plan_update",
            "data": {
                "payload": {
                    "turnId": "turn-1",
                    "plan": [
                        {"step": "inspect", "status": "completed"},
                        {"step": "verify", "status": "in_progress"},
                    ],
                }
            },
        },
    ]

    items = timeline_from_events(events)

    plans = [item for item in items if item["type"] == "plan"]
    assert len(plans) == 1
    assert plans[0]["id"] == "plan-turn-1"
    assert [step["status"] for step in plans[0]["steps"]] == ["done", "running"]


def test_timeline_from_events_closes_orphaned_tools_at_session_end() -> None:
    events = [
        {
            "id": "t1",
            "type": "tool_call",
            "data": {"payload": {"item": {"id": "call-1", "tool": "shell"}}},
        },
        {"id": "done", "type": "session_completed"},
    ]

    items = timeline_from_events(events)

    assert items[0]["status"] == "error"
    assert items[0]["output"] == "任务已结束，但没有收到该工具的完成事件。"


def test_live_plan_updates_share_an_id_and_orphaned_tools_are_closed() -> None:
    state: dict[str, object] = {"run_id": "run-1"}
    first = stream_event_item(
        AgentEvent(
            provider="codex",
            type="plan_update",
            data={"payload": {"plan": [{"step": "inspect", "status": "pending"}]}},
        ),
        state,
    )
    second = stream_event_item(
        AgentEvent(
            provider="codex",
            type="plan_update",
            data={"payload": {"plan": [{"step": "inspect", "status": "completed"}]}},
        ),
        state,
    )
    stream_event_item(
        AgentEvent(
            provider="codex",
            type="tool_call",
            data={"payload": {"item": {"id": "call-1", "tool": "shell"}}},
        ),
        state,
    )

    finalized = finalize_stream_tools(state)

    assert first[0]["item"]["id"] == second[0]["item"]["id"] == "live-plan-run-1"
    assert finalized[0]["item"]["status"] == "error"
