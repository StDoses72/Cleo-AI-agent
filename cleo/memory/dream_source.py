"""Read authoritative DreamAgent evidence without rewriting historical compact caches."""

import json

from cleo.memory.compaction import event_content_hash, load_events
from cleo.memory.paths import events_path, memory_state_path
from cleo.memory.state import SCHEMA_VERSION, touch_session_source


def validate_dream_state(memory_root, space):
    """Purpose: Refuse unsafe state before existing consolidation writers run.
    Input: Memory root and space. Output: No writes; malformed/newer state raises.
    """
    path = memory_state_path(memory_root, space)
    if path.exists():
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if (not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION
                or not isinstance(payload.get("sources"), dict)):
            raise ValueError("Unsupported or unreadable memory state; existing data was preserved")


def read_dream_source(store, space, project, session_id):
    """Purpose: Share one evidence snapshot between preview and extraction.
    Input: Session store and expected identity. Output: Manifest, raw events, content hash.
    Missing logs, unsupported schemas and moved sessions fail without cache/data writes.
    """
    from cleo.sessions.store import EVENT_SCHEMA_VERSION

    manifest = store.load_manifest(session_id)
    if (manifest["space"], manifest["project"], manifest["id"]) != (space, project, session_id):
        raise ValueError("session manifest binding does not match")
    events = load_events(events_path(store.memory_root, space, project, session_id))
    if any(event.get("schema_version", EVENT_SCHEMA_VERSION) != EVENT_SCHEMA_VERSION
           for event in events):
        raise ValueError("session event schema is not supported")
    return manifest, events, event_content_hash(events)


def register_dream_source(store, space, project, session_id, events):
    """Purpose: Track raw evidence revisions using the existing shared state format.
    Input: Validated event snapshot. Output: Current source entry; compact caches stay untouched.
    """
    validate_dream_state(store.memory_root, space)
    return touch_session_source(
        space=space, project=project, session_id=session_id,
        source_hash=event_content_hash(events), last_event_seq=events[-1]["seq"] if events else 0,
        path=memory_state_path(store.memory_root, space),
    )
