import json

from cleo.memory.compaction import load_validated_compact
from cleo.memory.paths import compact_path, memory_database_path
from cleo.memory.store import search_conversation_history
from cleo.sessions.store import SessionStore


def test_v3_v2_v3_round_trip_preserves_source_and_search(tmp_path):
    store = SessionStore(tmp_path / "memory")
    scope = {"space": "productivity", "project": "demo", "session_id": "round-trip"}
    store.create_session(**scope, provider="fixture", owner_type="user")
    for turn in range(2):
        store.append_events(**scope, events=[
            {"type": "user_message", "actor": "user", "content": f"question {turn}"},
            {"type": "assistant_message", "actor": "assistant", "content": f"needle {turn}"},
            {"type": "provider_event", "actor": "tool", "content": "file details"},
        ])
        store.refresh_compact(scope["session_id"], materialize=False)
    events = store.read_events(scope["session_id"])
    path = compact_path(store.memory_root, **scope)
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == 3
    before = load_validated_compact(memory_root=store.memory_root, **scope)
    exported = store.export_legacy_compact(scope["session_id"])
    assert json.loads(path.read_text(encoding="utf-8")) == exported
    assert exported["schema_version"] == 2
    assert exported["events"] == before["events"]
    assert exported["source"] == before["source"]
    assert search_conversation_history(space=scope["space"], project=scope["project"],
                                       query="needle 0", memory_root=store.memory_root,
                                       path=memory_database_path(store.memory_root, scope["space"]))
    store.refresh_compact(scope["session_id"], materialize=False)
    assert json.loads(path.read_text(encoding="utf-8"))["schema_version"] == 3
    after = load_validated_compact(memory_root=store.memory_root, **scope)
    assert after["events"] == before["events"]
    assert store.read_events(scope["session_id"]) == events
