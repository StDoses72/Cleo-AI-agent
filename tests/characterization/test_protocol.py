"""B1 — JSON-lines protocol envelope between Electron and the Python backend.

These behaviours are what ``ui/electron/backend.mjs`` relies on regardless of which
use case is called: request/response correlation, error shape, streaming, cancellation
and shutdown.
"""

from __future__ import annotations

from .support.backend import Backend
from .support.golden import assert_golden


def test_unknown_private_and_malformed_requests(backend: Backend) -> None:
    unknown = backend.call_error("no_such_method")
    private = backend.call_error("_thread", manifest={})
    missing = backend.call_error("stream_turn", thread_id="x", prompt="hi")
    unexpected = backend.call_error("load_workspace", surprise=True)
    assert_golden("protocol/errors", {
        "unknown": [unknown.name, unknown.message],
        "private": [private.name, private.message],
        "missing_required_param": missing.name,
        "unexpected_param": unexpected.name,
    })


def test_malformed_lines_are_ignored_and_non_object_params_mean_no_params(
    backend: Backend,
) -> None:
    backend.write_line("{this is not json")
    backend.write_line("")
    reply = backend.request("load_workspace", ["not", "an", "object"]).finish()
    assert reply["type"] == "result"
    assert set(reply) == {"id", "type", "result"}
    assert reply["result"]["threads"] == []


def test_requests_are_served_concurrently_and_cancel_is_task_scoped(
    backend: Backend,
) -> None:
    thread = backend.call("create_thread", space="chat", project_id_value="chat:general")
    slow = backend.stream_turn(thread["id"], "please wait [[slow]]", run_id="run-1")
    slow.wait_for(lambda event: event["type"] == "upsert-item"
                  and event["item"].get("role") == "assistant")
    # A second request is answered while the first one is still streaming.
    while_running = backend.call("load_thread", thread_id=thread["id"], activate=False)
    wrong_run = backend.call("cancel_run", thread_id=thread["id"], run_id="other-run")
    cancelled = backend.call("cancel_run", thread_id=thread["id"], run_id="run-1")
    final = slow.finish()
    assert_golden("protocol/cancel_chat_run", {
        "status_while_running": while_running["status"],
        "active_run_id_while_running": while_running["activeRunId"],
        "cancel_with_wrong_run_id": wrong_run,
        "cancel": cancelled,
        "stream_reply": {key: final[key] for key in ("type", "result")},
        "last_event": slow.events[-1],
        "status_after": backend.call("load_thread", thread_id=thread["id"])["status"],
    })


def test_shutdown_replies_then_exits_cleanly(backend: Backend) -> None:
    reply = backend.request("shutdown").finish()
    assert reply["type"] == "result" and reply["result"] == {"stopped": True}
    assert backend.wait_exit(30) == 0


def test_end_of_input_stops_the_backend(backend: Backend) -> None:
    backend.call("load_workspace")
    assert backend._process is not None and backend._process.stdin is not None
    backend._process.stdin.close()
    assert backend.wait_exit(30) == 0
