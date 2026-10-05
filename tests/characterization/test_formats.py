"""B8 — Algorithms whose results are stored in, or derived from, user data.

These run in-process on the real v0.7.1 event logs from ``legacy_home_v0_7_1``. A refactor
may move these functions, but must keep their outputs: ``source_hash`` values are already
persisted in manifests and memory state, and the compact/timeline projections define what
DreamAgent and the renderer see.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from cleo.desktop.projection import changes_from_diff, timeline_from_events
from cleo.memory.compaction import compact_events, event_content_hash
from cleo.sessions.policy import has_user_interaction
from cleo.sessions.rewind import active_events

from .support.golden import assert_golden

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "legacy_home_v0_7_1" / "memory"
SESSIONS = {
    "chat": ("non_productivity", "general"),
    "research": ("non_productivity", "research"),
    "task": ("productivity", "workspace"),
}


def _session(name: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    space, project = SESSIONS[name]
    (directory,) = (FIXTURE / space / "projects" / project / "sessions").iterdir()
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    events = [json.loads(line) for line in
              (directory / "events.jsonl").read_text(encoding="utf-8").splitlines() if line]
    return manifest, events


FROZEN_HASHES = json.loads(
    (FIXTURE.parent.with_name("legacy_home_v0_7_1.hashes.json")).read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", sorted(SESSIONS))
def test_source_hash_of_v071_logs_is_reproduced(name: str) -> None:
    """Persisted hashes must stay recomputable, or every old session looks modified.

    ``FROZEN_HASHES`` were computed by v0.7.1 over these exact (tokenized) logs.
    """
    manifest, events = _session(name)
    assert event_content_hash(events) == FROZEN_HASHES[manifest["id"]]
    # The manifest records how far the log had been compacted when the hash was stored.
    assert manifest["last_compacted_seq"] <= manifest["last_event_seq"] == len(events)
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))


@pytest.mark.parametrize("name", sorted(SESSIONS))
def test_compact_and_timeline_projections(name: str) -> None:
    manifest, events = _session(name)
    compact = compact_events(space=manifest["space"], project=manifest["project"],
                             session_id=manifest["id"], events=events, source_version=1)
    assert_golden(f"formats/projections_{name}", {
        "active_event_seqs": [event["seq"] for event in active_events(events)],
        "has_user_interaction": has_user_interaction(events),
        "compact": compact,
        "timeline": timeline_from_events(active_events(events)),
    })


def test_compaction_redacts_secrets_and_bounds_tool_payloads() -> None:
    def event(seq: int, kind: str, **fields: Any) -> dict[str, Any]:
        return {"schema_version": 1, "id": f"evt_{seq:032x}", "seq": seq, "session_id": "s1",
                "space": "productivity", "project": "p", "type": kind,
                "actor": fields.pop("actor", "system"),
                "created_at": "2026-01-01T00:00:00+00:00", **fields}

    secret = "sk-" + "a" * 40
    events = [
        event(1, "session_created", data={"provider": "x"}),
        event(2, "user_message", actor="user",
              content=f"Use api_key={secret} and Authorization: Bearer {'b' * 30}"),
        event(3, "assistant_message", actor="assistant", content="ok", message={
            "type": "ai", "data": {"type": "ai", "id": "m1", "content": "ok", "tool_calls": [
                {"id": "c1", "name": "read_file", "args": {"path": "a.txt"}},
                {"id": "c2", "name": "write_file",
                 "args": {"path": "b.txt", "content": "x" * 5000, "token": secret}},
            ]}}),
        event(4, "tool_result", actor="tool", content="file body " * 500, message={
            "type": "tool", "data": {"type": "tool", "id": "t1", "tool_call_id": "c1",
                                     "name": "read_file", "content": "file body " * 500}}),
        event(5, "tool_result", actor="tool", content="written", message={
            "type": "tool", "data": {"type": "tool", "id": "t2", "tool_call_id": "c2",
                                     "name": "write_file", "content": "written"}}),
        event(6, "terminal_output", content="line\n" * 3000),
    ]
    compact = compact_events(space="productivity", project="p", session_id="s1",
                             events=events, source_version=3)
    assert secret not in json.dumps(compact)
    assert_golden("formats/redaction", {
        "hash": event_content_hash(events),
        "compact": compact,
    })


def test_git_diff_projection() -> None:
    diff = (
        "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n"
        "@@ -1,2 +1,2 @@\n-old\n+new\n same\n"
        "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n"
        "+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n"
        "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n"
        "+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
    )
    assert_golden("formats/git_diff", {"changes": changes_from_diff(diff),
                                        "empty": changes_from_diff(None)})
