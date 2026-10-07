"""Cached desktop timelines are rebuilt only when ``PROJECTION_VERSION`` changes.

``TimelineIndex`` keeps each session's projected items on disk and keeps using them while
the version matches, so a change to ``timeline_from_events`` output without a version bump
leaves old sessions showing the old projection next to new events projected the new way.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import closing
from pathlib import Path

from cleo.desktop.projection import timeline_from_events
from cleo.desktop.timeline import PROJECTION_VERSION, TimelineIndex
from cleo.memory.compaction import load_events
from cleo.sessions.store import SessionStore

LEGACY = (Path(__file__).resolve().parents[1] / "characterization" / "fixtures"
          / "legacy_home_v0_7_1" / "memory")
# The projection each version produces for the frozen v0.7.1 sessions.
PINNED = {9: "3301892058774d49258c4690fb3f827f4d6f86860c782a16e097daf48e0932cc"}


def _projection_digest() -> str:
    output = {}
    for path in sorted(LEGACY.glob("*/projects/*/sessions/*/events.jsonl")):
        items = timeline_from_events(load_events(path))
        # "time" is rendered in the machine's local time zone.
        output[path.parent.name] = [{key: value for key, value in item.items() if key != "time"}
                                    for item in items]
    rendered = json.dumps(output, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest()


def test_projection_changes_come_with_a_version_bump() -> None:
    digest = _projection_digest()
    assert PINNED.get(PROJECTION_VERSION) == digest, (
        "timeline_from_events now projects the v0.7.1 sessions differently. Bump "
        "PROJECTION_VERSION in cleo/desktop/timeline.py so cached timelines are rebuilt, and "
        f"pin {{{PROJECTION_VERSION + 1}: {digest!r}}} here."
    )


def test_cached_codex_plan_is_rebuilt_with_running_status(tmp_path) -> None:
    store = SessionStore(tmp_path / "memory")
    manifest = store.create_session(
        session_id="history", space="productivity", project="p",
        provider="codex", owner_type="user",
    )
    store.append_event(
        session_id="history", space="productivity", project="p", actor="codex",
        event_type="plan_update", data={"payload": {
            "plan": [{"step": "Inspect", "status": "inProgress"}],
        }},
    )
    index = TimelineIndex(store, manifest)
    index.page()
    original_log = index.source.read_bytes()
    with closing(sqlite3.connect(index.path)) as db, db:
        db.execute("UPDATE metadata SET value=json_set(value,'$.projection_version',8)")
        db.execute(
            "UPDATE items SET body=json_set(body,'$.steps[0].status','pending'), "
            "preview=json_set(preview,'$.steps[0].status','pending')",
        )

    cards = TimelineIndex(store, manifest).page()["items"]
    assert len(cards) == 1
    assert cards[0]["steps"] == [{"label": "Inspect", "status": "running"}]
    assert index.source.read_bytes() == original_log
