"""B4 — Development tasks (productivity space) through a real ACP harness connection.

``fake_acp_agent.py`` is configured as the ``scripted`` provider in harnesses.json. The
ACP provider, AgentService, desktop approvals, timeline projection, Git checkpoints and
undo all run unchanged.
"""

from __future__ import annotations

import subprocess
from typing import Any

from .support.backend import Backend
from .support.golden import assert_golden
from .support.home import CleoHome, _git
from .support.views import collapse_stream, index_rows, session_files


def _new_task(backend: Backend, home: CleoHome, **extra: Any) -> dict[str, Any]:
    return backend.call("create_thread", space="productivity",
                        project_id_value="productivity:workspace",
                        project_path=str(home.workspace), **extra)


def _manifest(thread: dict[str, Any]) -> dict[str, Any]:
    return {"id": thread["id"], "space": "productivity",
            "project": thread["projectId"].split(":", 1)[1]}


def _git_status(home: CleoHome) -> list[str]:
    return subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"],
                          cwd=home.workspace, capture_output=True, text=True,
                          check=True).stdout.splitlines()


def test_task_turn_with_tools_plan_and_file_change(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    created = _new_task(backend, cleo_home)
    stream = backend.stream_turn(created["id"], "Update notes [[plan]] [[tool]] [[write]]")
    assert stream.result() is None
    files = session_files(cleo_home, _manifest(created))
    assert_golden("productivity/tool_turn", {
        "created": created,
        "stream": collapse_stream(stream.events),
        "workspace_git_status": _git_status(cleo_home),
        "reloaded_thread": backend.call("load_thread", thread_id=created["id"]),
        "disk": {"session": files, "index": index_rows(cleo_home)},
    }, replacements)


def test_undo_restores_the_latest_turn(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home)
    no_checkpoint = backend.call_error("undo_changes", thread_id=thread["id"])
    backend.run_turn(thread["id"], "write it [[write]]")
    before = backend.call("load_thread", thread_id=thread["id"])
    undone = backend.call("undo_changes", thread_id=thread["id"])
    again = backend.call_error("undo_changes", thread_id=thread["id"])
    chat = backend.call("create_thread", space="chat", project_id_value="chat:general")
    chat_undo = backend.call_error("undo_changes", thread_id=chat["id"])
    assert_golden("productivity/undo", {
        "before_first_turn": no_checkpoint.message,
        "can_undo_after_turn": before["canUndo"],
        "restored": undone["restoredFiles"],
        "git_status_after_undo": _git_status(cleo_home),
        "can_undo_after_undo": backend.call("load_thread", thread_id=thread["id"])["canUndo"],
        "second_undo": again.message,
        "chat_undo": chat_undo.message,
    }, replacements)


def test_default_policy_denies_permission_requests(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home)
    stream = backend.stream_turn(thread["id"], "needs approval [[permission]]")
    stream.result()
    assert_golden("productivity/permission_denied_by_policy", {
        "stream": collapse_stream(stream.events),
        "items": backend.call("load_thread", thread_id=thread["id"])["items"],
    }, replacements)


def test_user_approval_round_trip(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home)
    runtime = backend.call("update_runtime", thread_id=thread["id"],
                           update={"approval": "user"})
    stream = backend.stream_turn(thread["id"], "needs approval [[permission]]")
    request = stream.wait_for(lambda event: event["type"] == "approval-request")["request"]
    waiting = backend.call("load_thread", thread_id=thread["id"], activate=False)
    chat = backend.call("create_thread", space="chat", project_id_value="chat:general")
    wrong_space = backend.call_error("resolve_approval", thread_id=chat["id"],
                                     approval_id=request["id"], decision="accept")
    resolved = backend.call("resolve_approval", thread_id=thread["id"],
                            approval_id=request["id"], decision="accept")
    stream.result()
    assert_golden("productivity/user_approval", {
        "runtime_after_update": runtime,
        "pending_while_waiting": waiting["pendingApprovals"],
        "status_while_waiting": waiting["status"],
        "wrong_space": wrong_space.message,
        "resolved": resolved,
        "stream": collapse_stream(stream.events),
        "items": backend.call("load_thread", thread_id=thread["id"])["items"],
    }, replacements)


def test_cancel_and_non_completed_stop_reasons(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home)
    slow = backend.stream_turn(thread["id"], "long job [[slow]]")
    slow.wait_for(lambda event: event["type"] == "upsert-item"
                  and event["item"].get("role") == "assistant")
    cancelled = backend.call("cancel_run", thread_id=thread["id"])
    slow_reply = slow.finish()
    refused = backend.stream_turn(thread["id"], "not allowed [[refuse]]")
    refused.result()
    files = session_files(cleo_home, _manifest(thread))
    assert_golden("productivity/cancel_and_refusal", {
        "cancel": cancelled,
        "cancel_reply": slow_reply["type"],
        "cancel_stream": collapse_stream(slow.events),
        "refusal_stream": collapse_stream(refused.events),
        "persisted": [
            {key: event.get(key) for key in ("seq", "type", "actor", "content")}
            for event in files["events.jsonl"]
        ],
        "manifest_status": files["manifest.json"]["status"],
        "thread_status": backend.call("load_thread", thread_id=thread["id"])["status"],
    }, replacements)


def test_resume_after_restart_reconnects_the_native_session(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home)
    backend.run_turn(thread["id"], "first task message")
    backend.kill()
    restarted = Backend(cleo_home).start()
    try:
        stream = restarted.stream_turn(thread["id"], "second task message")
        stream.result()
        reloaded = restarted.call("load_timeline", thread_id=thread["id"])
    finally:
        restarted.kill()
    files = session_files(cleo_home, _manifest(thread))
    assert_golden("productivity/resume_after_restart", {
        "stream": collapse_stream(stream.events),
        "timeline": reloaded,
        "native_session_id": files["manifest.json"]["native_session_id"],
    }, replacements)


def test_runtime_options_and_validation(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home, model="fake-model-b", effort="low")
    model = backend.call("update_runtime", thread_id=thread["id"],
                         update={"model": "fake-model-a", "effort": "high"})
    errors = {}
    for name, update in {
        "unknown_model": {"model": "nope"},
        "sandbox_unsupported": {"access": "read-only"},
        "bad_approval": {"approval": "sometimes"},
        "fast_mode_unsupported": {"serviceTier": "fast"},
        "provider_mismatch": {"permissionProvider": "codex", "approval": "user"},
    }.items():
        error = backend.call_error("update_runtime", thread_id=thread["id"], update=update)
        errors[name] = [error.name, error.message]
    chat = backend.call("create_thread", space="chat", project_id_value="chat:general")
    assert_golden("productivity/runtime_options", {
        "created_runtime": thread["runtime"],
        "after_update": model,
        "errors": errors,
        "chat_ignores_task_options": backend.call(
            "update_runtime", thread_id=chat["id"], update={"model": "x"}),
        "manifest_runtime_options": session_files(
            cleo_home, _manifest(thread))["manifest.json"].get("runtime_options"),
    }, replacements)


def test_slash_commands(backend: Backend, cleo_home: CleoHome, replacements: dict) -> None:
    thread = _new_task(backend, cleo_home)
    backend.run_turn(thread["id"], "first [[write]]")
    outputs = {}
    for command in ("/help", "/cwd", "/project", "/git", "/diff", "/model", "/effort",
                    "/approval", "/sessions", "/back", "/quit", "/effort low"):
        stream = backend.stream_turn(thread["id"], command)
        reply = stream.finish()
        outputs[command] = {"reply": reply["type"],
                            "error": reply.get("error", {}).get("message"),
                            "events": collapse_stream(stream.events)}
    unknown = backend.call_error("stream_turn", thread_id=thread["id"], prompt="/bogus",
                                 attachments=[])
    assert_golden("productivity/slash_commands", {
        "commands": outputs, "unknown": [unknown.name, unknown.message],
    }, replacements)


def test_boundary_steering_queues_follow_up_until_the_turn_ends(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_task(backend, cleo_home)
    stream = backend.stream_turn(thread["id"], "first step [[delay]]", run_id="run-steer")
    stream.wait_for(lambda event: event["type"] == "turn-started")
    receipt = backend.call("steer_run", thread_id=thread["id"], run_id="run-steer",
                           request_id="steer-1", text="also do the second step")
    duplicate = backend.call_error("steer_run", thread_id=thread["id"], run_id="run-steer",
                                   request_id="steer-1", text="different text")
    stream.result()
    late = backend.call("steer_run", thread_id=thread["id"], run_id="run-steer",
                        request_id="steer-2", text="too late")
    assert_golden("productivity/boundary_steering", {
        "receipt": receipt,
        "duplicate_request_id": duplicate.message,
        "stream": collapse_stream(stream.events),
        "late_receipt": late,
        "timeline": backend.call("load_timeline", thread_id=thread["id"]),
    }, replacements)


def test_rewind_is_not_offered_for_acp_tasks(backend: Backend, cleo_home: CleoHome) -> None:
    thread = _new_task(backend, cleo_home)
    backend.run_turn(thread["id"], "one")
    reloaded = backend.call("load_thread", thread_id=thread["id"])
    error = backend.call_error("rewind_thread", thread_id=thread["id"],
                               item_id=reloaded["items"][0]["id"])
    assert reloaded["editableTurnIds"] == []
    assert error.message == "当前任务不支持编辑之前的消息。"


def test_create_and_delete_task_errors(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    missing_dir = backend.call_error("create_thread", space="productivity",
                                     project_id_value="productivity:x",
                                     project_path=str(cleo_home.root / "missing"))
    unknown_project = backend.call_error("create_thread", space="productivity",
                                         project_id_value="productivity:unknown")
    bad_space = backend.call_error("create_thread", space="elsewhere",
                                   project_id_value="productivity:x")
    unknown_provider = backend.call_error(
        "create_thread", space="productivity", project_id_value="productivity:workspace",
        project_path=str(cleo_home.workspace), provider="does-not-exist")
    fast = backend.call_error("create_thread", space="productivity",
                              project_id_value="productivity:workspace",
                              project_path=str(cleo_home.workspace), service_tier="fast")
    thread = _new_task(backend, cleo_home)
    backend.run_turn(thread["id"], "hello")
    deleted = backend.call("delete_thread", thread_id=thread["id"])
    assert_golden("productivity/create_delete", {
        "errors": {
            "missing_dir": missing_dir.message,
            "unknown_project": unknown_project.message,
            "bad_space": bad_space.message,
            "unknown_provider": [unknown_provider.name, unknown_provider.message],
            "fast_mode": fast.message,
        },
        "threads_after_delete": deleted["threads"],
        "index_after_delete": index_rows(cleo_home),
    }, replacements)


def test_long_workspace_paths_keep_the_undo_record(
    backend: Backend, cleo_home: CleoHome,
) -> None:
    """Q12 (fixed in S9): a long workspace path used to drop the turn's undo record silently.

    At about 190 characters the old ``refs/cleo/undo/<sha256>.lock`` path passed Windows'
    260-character limit, while the repository itself still worked.
    """
    root = cleo_home.root
    workspace = root / ("p" * (190 - len(str(root)) - len("workspace") - 2)) / "workspace"
    workspace.mkdir(parents=True)
    assert len(str(workspace)) == 190
    _git(workspace, "init", "-q", "-b", "main")
    (workspace / "README.md").write_text("# Long path\n", encoding="utf-8")
    _git(workspace, "add", "README.md")
    _git(workspace, "commit", "-q", "-m", "fixture")

    thread = backend.call("create_thread", space="productivity",
                          project_id_value="productivity:workspace",
                          project_path=str(workspace))
    events = backend.run_turn(thread["id"], "write it [[write]]")
    reloaded = backend.call("load_thread", thread_id=thread["id"])

    assert reloaded["canUndo"] is True
    assert [change["title"] for change in reloaded["changeHistory"]]
    assert not [event for event in events if event.get("type") == "upsert-item"
                and event["item"].get("title") == "这一轮无法撤销"]
