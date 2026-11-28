"""Custom workflows through the real backend process and a real ACP harness connection.

The scripted agent answers every prompt with ``ACP reply: <prompt>``, so a node's reply shows
what the node was told, and a ``/create-workflow`` reply carries the example block of the request.
"""

from __future__ import annotations

from typing import Any

from .support.backend import Backend
from .support.home import CleoHome


def _node(key: str, role: str) -> dict[str, Any]:
    # The scripted harness is ACP: nothing holds a node on it to reading, so these may edit.
    return {"id": key, "role": role, "instructions": f"You are the {role}.", "harness": None,
            "model": None, "effort": None, "speed": None, "access": "write",
            "workspace": "shared", "delegation": "default", "permission": "ask", "each": None,
            "x": 0, "y": 0}


def _workflow() -> dict[str, Any]:
    return {"id": "wf-two-steps", "name": "Two steps", "description": "",
            "nodes": [_node("plan", "Planner"), _node("do", "Executor")],
            "edges": [{"id": "e0", "from": "start", "to": "plan"},
                      {"id": "e1", "from": "plan", "to": "do"},
                      {"id": "e2", "from": "do", "to": "end"}],
            "start": {"x": 0, "y": 0}, "end": {"x": 0, "y": 300}, "origin": "user"}


def _task(backend: Backend, home: CleoHome) -> dict[str, Any]:
    return backend.call("create_thread", space="productivity",
                        project_id_value="productivity:workspace",
                        project_path=str(home.workspace))


def _items(thread: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [item for item in thread["items"] if item["type"] == kind]


def test_a_saved_workflow_runs_in_a_conversation(backend: Backend, cleo_home: CleoHome) -> None:
    saved = backend.call("save_workflow", definition=_workflow())
    library = backend.call("get_workflow_library")
    assert [item["id"] for item in library["workflows"]] == ["wf-two-steps"]
    scripted = next(item for item in library["harnesses"] if item["id"] == "scripted")
    assert (scripted["readOnly"], scripted["permissions"]) == (False, [])

    task = _task(backend, cleo_home)
    stream = backend.stream_turn(task["id"], f"/workflow {saved['id']} ship the export")
    assert stream.result(timeout=120) is None
    kinds = [event["type"] for event in stream.events]
    assert kinds[0] == "turn-started" and kinds[-1] == "done"
    assert stream.events[0]["item"]["content"] == "ship the export"

    thread = backend.call("load_thread", thread_id=task["id"])
    (card,) = _items(thread, "workflow")
    run = card["run"]
    assert run["status"] == "completed" and "progress" not in run
    assert [(session["role"], session["status"]) for session in run["sessions"]] == [
        ("Planner", "done"), ("Executor", "done")]
    # The second node was handed what the first produced, and its reply is the run's result.
    assert "From Planner:" in run["result"] and "You are the Executor." in run["result"]
    messages = [(item["role"], item["content"]) for item in _items(thread, "message")]
    assert messages[0] == ("user", "ship the export")
    assert messages[-1] == ("assistant", run["result"])
    assert thread["status"] == "completed" and thread["title"] == "ship the export"

    # Each node session is a conversation under the one the workflow ran in.
    workspace = backend.call("load_workspace")
    nodes = [item for item in workspace["threads"] if item.get("parentId") == task["id"]]
    assert sorted(item["title"] for item in nodes) == ["Executor", "Planner"]
    planner = next(item for item in nodes if item["title"] == "Planner")
    assert planner["workflowSession"] == {
        "runId": run["id"], "nodeId": "plan", "sessionId": run["sessions"][0]["id"]}
    opened = backend.call("load_thread", thread_id=planner["id"])
    assert any("You are the Planner." in item["content"] for item in _items(opened, "message"))

    # Nothing is left to take up, and a workflow that is not there is refused.
    assert backend.call_error("stream_turn", thread_id=task["id"], prompt="/workflow retry",
                              attachments=None).name == "ValueError"
    assert backend.call_error("stream_turn", thread_id=task["id"], prompt="/workflow nope x",
                              attachments=None).name == "ValueError"


def test_create_workflow_hands_back_a_card(backend: Backend, cleo_home: CleoHome) -> None:
    task = _task(backend, cleo_home)
    stream = backend.stream_turn(task["id"], "/create-workflow review every change twice")
    assert stream.result(timeout=120) is None
    thread = backend.call("load_thread", thread_id=task["id"])
    (proposal,) = _items(thread, "workflow-proposal")
    definition = proposal["definition"]
    assert definition["origin"] == "drafted"
    assert [node["role"] for node in definition["nodes"]] == ["Planner", "Reviewer", "Executor"]
    assert _items(thread, "message")[0]["content"] == "/create-workflow review every change twice"
    assert backend.call("get_workflow_library")["workflows"] == [], "saving is the user's"
    # What was handed back can be saved as it is.
    assert backend.call("save_workflow", definition=definition)["name"] == definition["name"]


def test_a_node_asks_for_approval_in_the_conversation_and_stops_with_it(
    backend: Backend, cleo_home: CleoHome,
) -> None:
    definition = _workflow()
    definition["nodes"][0]["instructions"] = "Run the check. [[permission]]"
    definition["nodes"][1]["instructions"] = "Keep going. [[slow]]"
    backend.call("save_workflow", definition=definition)
    task = _task(backend, cleo_home)
    stream = backend.stream_turn(task["id"], "/workflow wf-two-steps check it")
    request = stream.wait_for(lambda event: event["type"] == "approval-request")["request"]
    assert request["threadId"] == task["id"], "asked where the user is, not in the node's session"
    waiting = backend.call("load_thread", thread_id=task["id"], activate=False)
    assert [item["id"] for item in waiting["pendingApprovals"]] == [request["id"]]
    backend.call("resolve_approval", thread_id=task["id"], approval_id=request["id"],
                 decision="accept")
    # The second node never ends by itself: stopping the conversation's run stops the workflow.
    stream.wait_for(lambda event: event["type"] == "upsert-item"
                    and event["item"]["type"] == "workflow"
                    and len(event["item"]["run"]["sessions"]) == 2
                    and event["item"]["run"]["sessions"][1].get("threadId"))
    assert backend.call("cancel_run", thread_id=task["id"]) == {"cancelled": True}
    stream.finish()
    thread = backend.call("load_thread", thread_id=task["id"])
    (card,) = _items(thread, "workflow")
    run = card["run"]
    assert run["status"] == "cancelled"
    assert [session["status"] for session in run["sessions"]] == ["done", "cancelled"]
    assert "(permission: allow)" in run["sessions"][0]["output"]
    assert thread["pendingApprovals"] == []
