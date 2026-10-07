import json

import pytest

from cleo.desktop.projection import (
    change_history_from_events,
    changes_from_diff,
    final_changes_from_diff,
    finalize_stream_tools,
    latest_turn_changes,
    stream_event_item,
    timeline_from_events,
)
from cleo.harnesses.models import AgentEvent


def test_claude_text_remains_a_message_live_and_in_history() -> None:
    from cleo.harnesses.service import AgentService

    event = AgentEvent(provider="custom-claude", type="agent_message", text="正在检查文件",
                       data={"timeline_id": "turn:message:1"})
    live = stream_event_item(event, {})[0]["item"]
    stored = AgentService._stored_provider_event(event)
    history = timeline_from_events([stored])[0]
    for item in (live, history):
        assert item["id"] == "turn:message:1"
        assert item["type"] == "message"
        assert item["role"] == "assistant"
        assert item["content"] == "正在检查文件"


def test_legacy_claude_text_is_not_thinking() -> None:
    items = timeline_from_events([
        {"id": "text", "type": "thought", "content": "检查完成",
         "data": {"provider_event_type": "agent_message"}},
        {"id": "thinking", "type": "thought", "content": "推理内容",
         "data": {"provider_event_type": "thought"}},
    ])
    assert [item["type"] for item in items] == ["message", "thought"]


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


@pytest.mark.parametrize("path", ["folder b/file.log", 'a"b.log', "line\nbreak.log",
                                 "制表\t路径.log", "a\\b.log", "line\u2028break.log",
                                 "line\u0085break.log"])
def test_changes_from_diff_reads_quoted_placeholder_paths(path) -> None:
    left, right = (json.dumps(prefix + path) for prefix in ("a/", "b/"))
    diff = f"diff --git {left} {right}\nnew file mode 100644\nFile contents not included."

    changes = changes_from_diff(diff)

    assert len(changes) == 1
    assert changes[0]["path"] == path
    assert changes[0]["status"] == "added"


def test_changes_from_diff_reads_git_octal_filename_bytes() -> None:
    diff = r'diff --git "a/\303\251.txt" "b/\303\251.txt"' + "\nnew file mode 100644"

    assert changes_from_diff(diff)[0]["path"] == "é.txt"


def test_changes_from_diff_displays_non_utf8_filename_bytes() -> None:
    diff = r'diff --git "a/\377.txt" "b/\377.txt"' + "\nnew file mode 100644"

    assert changes_from_diff(diff)[0]["path"] == "\ufffd.txt"


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


@pytest.mark.parametrize("running_status", ["inProgress", "in_progress"])
def test_timeline_from_events_updates_one_plan_per_turn(running_status) -> None:
    events = [
        {"id": "u1", "type": "user_message", "content": "inspect"},
        {
            "id": "p1",
            "type": "plan_update",
            "data": {
                "payload": {
                    "turnId": "turn-1",
                    "plan": [
                        {"step": "inspect", "status": running_status},
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
                        {"step": "verify", "status": running_status},
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


@pytest.mark.parametrize("running_status", ["inProgress", "in_progress"])
def test_live_plan_updates_share_an_id_and_orphaned_tools_are_closed(running_status) -> None:
    state: dict[str, object] = {"run_id": "run-1"}
    first = stream_event_item(
        AgentEvent(
            provider="codex",
            type="plan_update",
            data={"payload": {"plan": [{"step": "inspect", "status": running_status}]}},
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
    assert first[0]["item"]["steps"] == [{"label": "inspect", "status": "running"}]
    assert second[0]["item"]["steps"] == [{"label": "inspect", "status": "done"}]
    assert finalized[0]["item"]["status"] == "error"


@pytest.mark.parametrize("entries_key,label_key", [("plan", "step"), ("entries", "content")])
def test_codex_plan_items_update_live_and_history(entries_key, label_key) -> None:
    from cleo.harnesses.service import AgentService
    from cleo.integrations.harnesses.codex import CodexProvider

    provider = CodexProvider(default_model="test-model")
    state = {}
    stored = []
    live = []
    for method, status in [("item/started", "inProgress"), ("item/completed", "completed")]:
        event = provider._event_from_notification(method, {
            "turnId": "turn-1",
            "item": {"id": "plan-1", "type": "plan",
                     entries_key: [{label_key: "inspect", "status": status}]},
        })
        assert event.type == "plan_update"
        stored.append(AgentService._stored_provider_event(event))
        live.extend(stream_event_item(event, state))

    assert len(live) == 2
    assert live[0]["item"]["id"] == live[1]["item"]["id"]
    assert live[0]["item"]["steps"] == [{"label": "inspect", "status": "running"}]
    assert live[1]["item"]["steps"] == [{"label": "inspect", "status": "done"}]
    history = timeline_from_events(stored)
    assert len(history) == 1
    assert history[0]["type"] == "plan"
    assert history[0]["steps"] == live[1]["item"]["steps"]


def test_plan_status_defaults_are_consistent_live_and_in_history() -> None:
    from cleo.harnesses.service import AgentService

    entries = [
        {"step": "pending", "status": "pending"},
        {"step": "unknown", "status": "unexpected"},
        {"step": "missing"},
        {"step": "running", "status": "running"},
        {"step": "done", "status": "done"},
    ]
    event = AgentEvent(provider="codex", type="plan_update", data={"plan": entries})
    live = stream_event_item(event, {})[0]["item"]
    history = timeline_from_events([AgentService._stored_provider_event(event)])[0]
    assert live["steps"] == history["steps"]
    assert [step["status"] for step in live["steps"]] == [
        "pending", "pending", "pending", "running", "done",
    ]


@pytest.mark.parametrize("payload", [
    {"item": {"id": "plan-1", "type": "plan", "text": "Inspect the code"}},
    {"delta": "Inspect"},
    {"plan": []},
])
def test_unstructured_plan_updates_preserve_existing_steps(payload) -> None:
    from cleo.harnesses.service import AgentService

    first = AgentEvent(provider="codex", type="plan_update", data={
        "plan": [{"step": "Inspect", "status": "inProgress"}],
    })
    second = AgentEvent(provider="codex", type="plan_update", data={"payload": payload})
    state = {}
    live = stream_event_item(first, state)[0]["item"]
    assert stream_event_item(second, state) == []
    history = timeline_from_events([
        AgentService._stored_provider_event(event) for event in (first, second)
    ])
    assert len(history) == 1
    assert history[0]["steps"] == live["steps"] == [{"label": "Inspect", "status": "running"}]


def test_acp_thought_chunks_share_one_item_until_the_next_event() -> None:
    state: dict[str, object] = {"run_id": "run-1"}
    first = stream_event_item(
        AgentEvent(
            provider="opencode",
            type="thought",
            text="逐",
            data={"provider_event_type": "agent_thought_chunk", "payload": {}},
        ),
        state,
    )
    second = stream_event_item(
        AgentEvent(
            provider="opencode",
            type="thought",
            text="字",
            data={"provider_event_type": "agent_thought_chunk", "payload": {}},
        ),
        state,
    )
    stream_event_item(
        AgentEvent(
            provider="opencode",
            type="tool_call",
            data={"payload": {"toolCallId": "call-1"}},
        ),
        state,
    )
    third = stream_event_item(
        AgentEvent(
            provider="opencode",
            type="thought",
            text="新",
            data={"provider_event_type": "agent_thought_chunk", "payload": {}},
        ),
        state,
    )

    assert first[0]["item"]["id"] == second[0]["item"]["id"]
    assert second[0]["item"]["content"] == "逐字"
    assert third[0]["item"]["id"] != second[0]["item"]["id"]
    assert third[0]["item"]["content"] == "新"


def test_live_approval_events_project_to_desktop_protocol() -> None:
    request = stream_event_item(
        AgentEvent(
            provider="codex",
            type="permission_request",
            data={
                "payload": {
                    "id": "approval-1",
                    "kind": "command",
                    "availableDecisions": ["accept", "decline"],
                }
            },
        ),
        {},
    )
    response = stream_event_item(
        AgentEvent(
            provider="codex",
            type="permission_response",
            data={"payload": {"id": "approval-1", "decision": "accept"}},
        ),
        {},
    )

    assert request == [
        {
            "type": "approval-request",
            "request": {
                "id": "approval-1",
                "kind": "command",
                "availableDecisions": ["accept", "decline"],
            },
        }
    ]
    assert response[:1] == [
        {
            "type": "approval-resolved",
            "response": {"id": "approval-1", "decision": "accept"},
        }
    ]
    assert response[1]["type"] == "upsert-item"
    assert response[1]["item"]["name"] == "人工审批 · 已允许"


def test_nested_repo_final_refresh_preserves_latest_streamed_diff() -> None:
    state: dict[str, object] = {}
    diff = """diff --git a/nested/file.txt b/nested/file.txt
--- a/nested/file.txt
+++ b/nested/file.txt
@@ -1 +1 @@
-before
+after
"""
    streamed = stream_event_item(
        AgentEvent(
            provider="codex",
            type="file_change",
            text=diff,
            data={"provider_event_type": "turn/diff/updated", "payload": {"diff": diff}},
        ),
        state,
    )

    final = final_changes_from_diff(None, state)

    assert streamed == [{"type": "changes", "changes": final}]
    assert final[0]["path"] == "nested/file.txt"


def test_latest_turn_changes_rebuilds_persisted_nested_repo_diff() -> None:
    diff = """diff --git a/nested/file.txt b/nested/file.txt
--- a/nested/file.txt
+++ b/nested/file.txt
@@ -1 +1 @@
-before
+after
"""
    events = [
        {"id": "user-old", "type": "user_message", "content": "old"},
        {
            "id": "diff-old",
            "type": "file_change",
            "content": "diff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ b/old.txt",
            "data": {"provider_event_type": "turn/diff/updated", "payload": {}},
        },
        {"id": "user-new", "type": "user_message", "content": "new"},
        {
            "id": "diff-new",
            "type": "file_change",
            "content": diff,
            "data": {
                "provider_event_type": "turn/diff/updated",
                "payload": {"diff": diff},
            },
        },
        {"id": "done", "type": "session_completed"},
    ]

    changes = latest_turn_changes(events)

    assert [change["path"] for change in changes] == ["nested/file.txt"]


def test_change_history_keeps_one_exact_diff_per_user_turn() -> None:
    first_diff = """diff --git a/first.py b/first.py
--- a/first.py
+++ b/first.py
@@ -1 +1 @@
-before
+first
"""
    streamed_second_diff = """diff --git a/cumulative.py b/cumulative.py
--- a/cumulative.py
+++ b/cumulative.py
@@ -1 +1 @@
-before
+cumulative
"""
    exact_second_diff = """diff --git a/second.py b/second.py
--- a/second.py
+++ b/second.py
@@ -1 +1 @@
-before
+second
"""
    events = [
        {
            "id": "user-1",
            "type": "user_message",
            "content": "make the first change",
            "created_at": "2026-09-04T12:00:00+00:00",
        },
        {
            "id": "stream-1",
            "type": "file_change",
            "content": first_diff,
            "data": {"provider_event_type": "turn/diff/updated"},
        },
        {
            "id": "user-2",
            "type": "user_message",
            "content": "make the second change",
            "created_at": "2026-09-04T12:05:00+00:00",
        },
        {
            "id": "stream-2",
            "type": "file_change",
            "content": streamed_second_diff,
            "data": {"provider_event_type": "turn/diff/updated"},
        },
        {
            "id": "exact-2",
            "type": "turn_diff",
            "content": exact_second_diff,
            "created_at": "2026-09-04T12:06:00+00:00",
            "data": {"title": "make the second change"},
        },
    ]

    history = change_history_from_events(events)

    assert [entry["id"] for entry in history] == ["exact-2", "stream-1"]
    assert [entry["title"] for entry in history] == [
        "make the second change",
        "make the first change",
    ]
    assert [entry["changes"][0]["path"] for entry in history] == ["second.py", "first.py"]


def test_codex_commentary_is_replaced_by_thought_before_final_answer() -> None:
    state: dict[str, object] = {"run_id": "run-1"}
    streamed = stream_event_item(
        AgentEvent(
            provider="codex",
            type="assistant_message_chunk",
            text="checking",
            data={"payload": {"itemId": "message-1", "turnId": "turn-1"}},
        ),
        state,
    )
    commentary = stream_event_item(
        AgentEvent(
            provider="codex",
            type="assistant_message_completed",
            text="checking the workspace",
            data={
                "payload": {
                    "item": {
                        "id": "message-1",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": "checking the workspace",
                    }
                }
            },
        ),
        state,
    )
    stream_event_item(
        AgentEvent(
            provider="codex",
            type="assistant_message_chunk",
            text="done",
            data={"payload": {"itemId": "message-2", "turnId": "turn-1"}},
        ),
        state,
    )
    final = stream_event_item(
        AgentEvent(
            provider="codex",
            type="assistant_message_completed",
            text="done",
            data={
                "payload": {
                    "item": {
                        "id": "message-2",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": "done",
                    }
                }
            },
        ),
        state,
    )

    assert streamed[0]["item"]["id"] == commentary[0]["item"]["id"]
    assert commentary[0]["item"]["type"] == "thought"
    assert commentary[0]["item"]["status"] == "done"
    assert final[0]["item"]["type"] == "message"
    assert state["assistant"] == "done"


def test_acp_tool_calls_show_their_title_and_raw_input() -> None:
    """Q4: ACP payloads carry ``title`` and ``rawInput`` instead of a tool name."""
    acp = {"toolCallId": "t1", "title": "Read README.md", "kind": "read",
           "rawInput": {"path": "README.md"}, "status": "in_progress"}
    events = [
        {"id": "u", "type": "user_message", "actor": "user", "content": "go"},
        {"id": "c1", "type": "tool_call", "actor": "scripted", "data": {"payload": acp}},
        {"id": "c2", "type": "tool_call", "actor": "scripted", "data": {"payload": {
            "toolCallId": "t2", "title": "Run tests",
            "rawInput": {"command": ["pytest", "-q"]}}}},
        {"id": "c3", "type": "tool_call", "actor": "scripted", "data": {"payload": {
            "toolCallId": "t3", "title": "Fetch", "rawInput": {"limit": 3}}}},
        {"id": "c4", "type": "tool_call", "actor": "codex", "data": {"payload": {
            "item": {"id": "x", "tool": "shell", "command": "ls -la"}}}},
    ]
    tools = [item for item in timeline_from_events(events) if item["type"] == "tool"]
    assert [(tool["name"], tool["command"]) for tool in tools] == [
        ("Read README.md", "README.md"),
        ("Run tests", "pytest -q"),
        ("Fetch", '{"limit": 3}'),
        ("shell", "ls -la"),
    ]
    live = stream_event_item(AgentEvent(provider="scripted", type="tool_call",
                                        data={"payload": acp}), {})
    assert (live[0]["item"]["name"], live[0]["item"]["command"]) == (
        "Read README.md", "README.md")
