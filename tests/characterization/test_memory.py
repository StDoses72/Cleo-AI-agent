"""B5 — Memory review queue, DreamAgent consolidation and the shutdown hand-off.

DreamAgent talks to the same fake OpenAI-compatible server; its replies are schema-valid
extractions, so the real projection, validation, Markdown publication and state machine
run end to end.
"""

from __future__ import annotations

import json
import subprocess
import time
from typing import Any

from .support.backend import Backend
from .support.fake_llm import DREAM_MARKER, FakeLLM
from .support.golden import assert_golden
from .support.home import CleoHome
from .support.views import memory_state, read_jsonl, session_dir, sqlite_rows, tree


def _chat_turn(backend: Backend, text: str) -> dict[str, Any]:
    thread = backend.call("create_thread", space="chat", project_id_value="chat:general")
    backend.run_turn(thread["id"], text)
    return thread


def _source(thread: dict[str, Any]) -> dict[str, str]:
    return {"space": "non_productivity", "project": "general", "session_id": thread["id"]}


def _dream_requests(fake_llm: FakeLLM) -> list[dict[str, Any]]:
    return [body for body in fake_llm.chat_requests()
            if any(DREAM_MARKER in str(m.get("content")) for m in body.get("messages", []))]


def _memory_git_log(home: CleoHome) -> list[str]:
    """Memory Markdown is versioned in a private Git repository under ``memory/``."""
    if not (home.memory / ".git").exists():
        return []
    output = subprocess.run(["git", "log", "--format=%s", "--name-only"], cwd=home.memory,
                            capture_output=True, text=True, encoding="utf-8", check=True)
    return [line for line in output.stdout.splitlines() if line.strip()]


def _memory_disk(home: CleoHome) -> dict[str, Any]:
    project = home.memory / "non_productivity" / "projects" / "general"
    return {
        "MEMORY.md": (project / "MEMORY.md").read_text(encoding="utf-8")
        if (project / "MEMORY.md").exists() else None,
        "memory_state": memory_state(home, "non_productivity"),
        # Git internals vary with the installed git version; the log is the contract.
        "files": tree(home.memory, skip=(".desktop-timeline", "-wal", "-shm", ".git/")),
        "memory_git_log": _memory_git_log(home),
    }


def test_pending_source_review_details_and_skip(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    thread = _chat_turn(backend, "Remember that I review plans on Sunday")
    memory = backend.call("load_memory")
    details = backend.call("get_memory_review_details", **_source(thread))
    skipped = backend.call("review_memory_source", action="skip", **_source(thread))
    again = backend.call_error("review_memory_source", action="skip", **_source(thread))
    bad_action = backend.call_error("review_memory_source", action="delete", **_source(thread))
    gone = backend.call_error("get_memory_review_details", **_source(thread))
    assert_golden("memory/review_skip", {
        "pending": memory,
        "details": details,
        "after_skip": {"memoryOverview": skipped["memoryOverview"],
                       "memories": skipped["memories"]},
        "errors": {"skip_twice": again.message, "bad_action": bad_action.message,
                   "details_after_skip": gone.message},
        "disk": _memory_disk(cleo_home),
    }, replacements)


def test_manual_consolidation_publishes_a_preference(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    thread = _chat_turn(backend, "I like concise weekly plans [[prefer]]")
    workspace = backend.call("review_memory_source", action="consolidate", **_source(thread))
    requests = _dream_requests(fake_llm)
    assert_golden("memory/consolidate", {
        "memoryOverview": workspace["memoryOverview"],
        "memories": workspace["memories"],
        "dream_request": {
            "count": len(requests),
            "model": requests[0]["model"],
            "max_tokens": requests[0].get("max_tokens") or requests[0].get("max_completion_tokens"),
            "roles": [message["role"] for message in requests[0]["messages"]],
        },
        "disk": _memory_disk(cleo_home),
        "dream_checkpoint": json.loads(
            (session_dir(cleo_home, "non_productivity", "general", thread["id"])
             / "dream.json").read_text(encoding="utf-8"))
        if (session_dir(cleo_home, "non_productivity", "general", thread["id"])
            / "dream.json").exists() else None,
        "memory_db_schema_tables": [row["name"] for row in sqlite_rows(
            cleo_home.memory / "non_productivity" / "memory.sqlite3",
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")],
    }, replacements)


def test_graceful_shutdown_hands_chatted_threads_to_the_dream_worker(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    thread = _chat_turn(backend, "Shutdown should consolidate this [[prefer]]")
    events_before = len(read_jsonl(session_dir(
        cleo_home, "non_productivity", "general", thread["id"]) / "events.jsonl"))
    backend.stop()  # Electron's normal exit path: a ``shutdown`` request.
    key = f"session:non_productivity:general:{thread['id']}"
    deadline = time.monotonic() + 90
    state = None
    while time.monotonic() < deadline:
        state = (memory_state(cleo_home, "non_productivity") or {}).get("sources", {}).get(key)
        if state and state.get("status") not in {"pending", "running"}:
            break
        time.sleep(0.5)
    events_after = read_jsonl(session_dir(
        cleo_home, "non_productivity", "general", thread["id"]) / "events.jsonl")
    assert_golden("memory/shutdown_worker", {
        "new_events_written_on_shutdown": [event["type"] for event in events_after[events_before:]],
        "dream_requests": len(_dream_requests(fake_llm)),
        "disk": _memory_disk(cleo_home),
    }, replacements)
