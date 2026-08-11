from cleo.desktop.projection import changes_from_diff, timeline_from_events


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
