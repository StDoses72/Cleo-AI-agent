"""B3 — Cleo chat (non_productivity) threads: create, stream, persist, resume, edit, delete.

The model is reached over HTTP through an ordinary OpenAI-compatible profile, so the
LangChain/deepagents runtime, prompt assembly, tool binding and persistence all run as in
production. ``FakeLLM`` records each outbound request for the "what Cleo sends" snapshots.
"""

from __future__ import annotations

import base64
from typing import Any

from .support.backend import Backend
from .support.fake_llm import FakeLLM
from .support.golden import assert_golden
from .support.home import AGENTS_MD, MEMORY_POLICY_MD, CleoHome
from .support.views import (
    collapse_stream,
    index_rows,
    memory_state,
    runtime_state,
    session_files,
    streamed_partial_content,
)


def _new_chat(backend: Backend) -> dict[str, Any]:
    return backend.call("create_thread", space="chat", project_id_value="chat:general")


def _request_view(body: dict[str, Any]) -> dict[str, Any]:
    """Outbound chat request without the volatile system prompt text."""
    messages = []
    for message in body.get("messages", []):
        if message.get("role") == "system":
            text = str(message.get("content"))
            messages.append({
                "role": "system",
                "includes_agents_md": AGENTS_MD.splitlines()[0] in text,
                "includes_memory_policy": MEMORY_POLICY_MD.splitlines()[0] in text,
            })
        else:
            messages.append({key: message[key] for key in ("role", "content", "tool_calls")
                             if key in message})
    return {
        "model": body.get("model"),
        "stream": body.get("stream"),
        "temperature": body.get("temperature"),
        "stream_options": body.get("stream_options"),
        "tools": sorted(tool["function"]["name"] for tool in body.get("tools", [])),
        "messages": messages,
    }


def test_first_turn_streams_persists_and_reloads(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    created = _new_chat(backend)
    stream = backend.stream_turn(created["id"], "Hello Cleo, plan my week")
    assert stream.result() is None
    answer_id = next(event["item"]["id"] for event in stream.events
                     if event["type"] == "upsert-item")
    partials = streamed_partial_content(stream.events, answer_id)
    assert len(partials) > 1 and partials[-1].startswith(partials[0])  # incremental stream
    manifest = session_files(cleo_home, {**created, "space": "non_productivity",
                                         "project": "general"})["manifest.json"]
    assert_golden("chat/first_turn", {
        "created": created,
        "stream": collapse_stream(stream.events),
        "llm_requests": [_request_view(body) for body in fake_llm.chat_requests()],
        "reloaded_thread": backend.call("load_thread", thread_id=created["id"]),
        "workspace_threads": [
            {key: thread[key] for key in ("id", "title", "summary", "status", "space")}
            for thread in backend.call("load_workspace")["threads"]
        ],
        "disk": {
            "session": session_files(cleo_home, manifest),
            "index": index_rows(cleo_home),
            "runtime.json": runtime_state(cleo_home),
            "memory_state": memory_state(cleo_home, "non_productivity"),
        },
    }, replacements)


def test_history_survives_a_backend_restart(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    thread = _new_chat(backend)
    backend.run_turn(thread["id"], "first message")
    backend.kill()  # A crash must not lose completed turns.
    restarted = Backend(cleo_home).start()
    try:
        workspace = restarted.call("load_workspace")
        restarted.run_turn(thread["id"], "second message")
        timeline = restarted.call("load_timeline", thread_id=thread["id"])
    finally:
        restarted.kill()
    assert_golden("chat/resume_after_restart", {
        "active_thread_after_restart": workspace["activeThreadId"] == thread["id"],
        "second_request": _request_view(fake_llm.chat_requests()[-1]),
        "timeline": timeline,
    }, replacements)


def test_failed_model_call_is_persisted_as_interrupted(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _new_chat(backend)
    stream = backend.stream_turn(thread["id"], "this will [[fail]]")
    reply = stream.finish()
    manifest = {**thread, "space": "non_productivity", "project": "general"}
    files = session_files(cleo_home, manifest)
    assert_golden("chat/model_failure", {
        # The exception class comes from the model SDK; the UI only shows the message.
        "reply_type": reply["type"],
        "stream": collapse_stream(stream.events),
        "persisted_event_types": [event["type"] for event in files["events.jsonl"]],
        "manifest_status": files["manifest.json"]["status"],
        "reloaded_items": backend.call("load_thread", thread_id=thread["id"])["items"],
    }, replacements)


def test_turn_validation_errors(backend: Backend) -> None:
    thread = _new_chat(backend)
    empty = backend.call_error("stream_turn", thread_id=thread["id"], prompt="   ",
                               attachments=[])
    bad_run = backend.call_error("stream_turn", thread_id=thread["id"], prompt="hi",
                                 attachments=[], run_id="")
    unknown = backend.call_error("stream_turn", thread_id="cleo_000000000000", prompt="hi",
                                 attachments=[])
    slow = backend.stream_turn(thread["id"], "hold [[slow]]")
    slow.wait_for(lambda event: event["type"] == "upsert-item")
    busy = backend.call_error("stream_turn", thread_id=thread["id"], prompt="again",
                              attachments=[])
    delete_running = backend.call_error("delete_thread", thread_id=thread["id"])
    backend.call("cancel_run", thread_id=thread["id"])
    slow.finish()
    assert_golden("chat/validation_errors", {
        "empty_prompt": [empty.name, empty.message],
        "invalid_run_id": [bad_run.name, bad_run.message],
        "unknown_thread": unknown.name,
        "already_running": [busy.name, busy.message],
        "delete_while_running": [delete_running.name, delete_running.message],
    })


def test_edit_earlier_message_rewinds_history(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    thread = _new_chat(backend)
    backend.run_turn(thread["id"], "keep this")
    backend.run_turn(thread["id"], "edit this")
    before = backend.call("load_thread", thread_id=thread["id"])
    target = before["editableTurnIds"][-1]
    rewound = backend.call("rewind_thread", thread_id=thread["id"], item_id=target)
    not_editable = backend.call_error("rewind_thread", thread_id=thread["id"],
                                      item_id="turn-000000000000000000000000")
    backend.run_turn(thread["id"], "edited text")
    files = session_files(cleo_home, {**thread, "space": "non_productivity",
                                      "project": "general"})
    assert_golden("chat/rewind", {
        "editable_before": before["editableTurnIds"],
        "rewound_thread": rewound,
        "not_editable": not_editable.message,
        "request_after_edit": _request_view(fake_llm.chat_requests()[-1]),
        "events_after_edit": [
            {key: event.get(key) for key in ("seq", "type", "actor", "content", "data")}
            for event in files["events.jsonl"]
        ],
        "compact_after_edit": files["compact.json"],
        "timeline_after_edit": backend.call("load_timeline", thread_id=thread["id"]),
    }, replacements)


def test_attachments_reach_the_model(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    text_file = cleo_home.root / "brief.txt"
    text_file.write_text("Quarterly goals", encoding="utf-8")
    image = cleo_home.root / "pixel.png"
    image.write_bytes(base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="))
    thread = _new_chat(backend)
    stream = backend.stream_turn(thread["id"], "Review these", attachments=[
        {"name": "brief.txt", "path": str(text_file), "mimeType": "text/plain"},
        {"name": "pixel.png", "path": str(image), "mimeType": "image/png"},
    ])
    stream.result()
    too_many = backend.call_error("stream_turn", thread_id=thread["id"], prompt="x",
                                  attachments=[{"name": f"{i}.txt", "path": str(text_file),
                                                "mimeType": "text/plain"} for i in range(21)])
    assert_golden("chat/attachments", {
        "stream": collapse_stream(stream.events),
        "user_message_sent": _request_view(fake_llm.chat_requests()[0])["messages"][-1],
        "too_many": [too_many.name, too_many.message],
        "reloaded_items": backend.call("load_thread", thread_id=thread["id"])["items"],
    }, replacements)


def test_slash_commands(backend: Backend, cleo_home: CleoHome, replacements: dict) -> None:
    thread = _new_chat(backend)
    backend.run_turn(thread["id"], "start a conversation")
    outputs = {}
    for command in ("/help", "/sessions", "/project", "/rename  Weekly plan ", "/attach",
                    "/productivity", "/quit", "/project research", "/new"):
        stream = backend.stream_turn(thread["id"], command)
        reply = stream.finish()
        outputs[command] = {"reply": reply["type"], "events": collapse_stream(stream.events)}
    unknown = backend.call_error("stream_turn", thread_id=thread["id"], prompt="/bogus",
                                 attachments=[])
    moved = backend.stream_turn(thread["id"], "/project move archive")
    moved.result()
    workspace = backend.call("load_workspace")
    assert_golden("chat/slash_commands", {
        "commands": outputs,
        "unknown": [unknown.name, unknown.message],
        "project_move": collapse_stream(moved.events),
        "threads_after": sorted(
            ({key: item[key] for key in ("title", "projectId", "space")}
             for item in workspace["threads"]), key=lambda item: (item["projectId"],
                                                                  item["title"])),
        "projects_after": [project["id"] for project in workspace["projects"]],
        "moved_manifest_dir": sorted(
            path.relative_to(cleo_home.memory).as_posix()
            for path in (cleo_home.memory / "non_productivity" / "projects").glob("*/sessions/*")
        ),
    }, replacements)


def test_delete_thread_removes_its_data(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    keep = _new_chat(backend)
    backend.run_turn(keep["id"], "keep me")
    drop = _new_chat(backend)
    backend.run_turn(drop["id"], "delete me")
    workspace = backend.call("delete_thread", thread_id=drop["id"])
    sessions = cleo_home.memory / "non_productivity" / "projects" / "general" / "sessions"
    assert_golden("chat/delete", {
        "active_after_delete": workspace["activeThreadId"] == keep["id"],
        "threads": [thread["id"] == keep["id"] for thread in workspace["threads"]],
        "session_dirs": sorted(path.name == keep["id"] for path in sessions.iterdir()),
        "index_ids": [row["id"] == keep["id"] for row in index_rows(cleo_home)],
        "runtime.json": runtime_state(cleo_home),
        "missing": backend.call_error("delete_thread", thread_id=drop["id"]).name,
    }, replacements)


def test_empty_chat_threads_are_hidden_from_the_workspace(backend: Backend) -> None:
    empty = _new_chat(backend)
    used = _new_chat(backend)
    backend.run_turn(used["id"], "hello")
    visible = {thread["id"] for thread in backend.call("load_workspace")["threads"]}
    assert used["id"] in visible
    assert empty["id"] not in visible
