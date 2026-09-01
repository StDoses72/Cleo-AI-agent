from pathlib import Path

from cleo.memory.overview import build_memory_overview
from cleo.memory.paths import memory_database_path, memory_state_path
from cleo.memory.persona import upsert_persona_trait
from cleo.memory.state import mark_consolidation_skipped, touch_session_source
from cleo.memory.store import upsert_memory


def test_memory_overview_matches_desktop_contract(tmp_path: Path) -> None:
    memory_root = tmp_path / "memory"
    for space, project in (
        ("non_productivity", "general"),
        ("productivity", "cleo"),
    ):
        upsert_memory(
            space=space,
            project=project,
            session_id=f"session-{project}",
            source_hash=f"hash-{project}",
            category="preference" if project == "general" else "decision",
            subject=f"Memory for {project}",
            content="Durable content.",
            evidence_event_ids=[f"event-{project}"],
            path=memory_database_path(memory_root, space),
        )

    upsert_persona_trait(
        memory_root=memory_root,
        category="communication",
        trait="Lead with the result.",
        space="non_productivity",
        project="general",
        session_id="session-general",
        source_hash="hash-general",
        evidence_event_ids=["event-persona"],
        tags=["style"],
    )

    non_productivity_state = memory_state_path(memory_root, "non_productivity")
    touch_session_source(
        space="non_productivity",
        project="general",
        session_id="session-general",
        source_hash="hash-general",
        last_event_seq=2,
        path=non_productivity_state,
    )
    mark_consolidation_skipped(
        "non_productivity",
        "general",
        "session-general",
        "hash-general",
        reason="No new durable facts.",
        review_result={"provider": "manual", "decision": "skip"},
        path=non_productivity_state,
    )
    touch_session_source(
        space="productivity",
        project="cleo",
        session_id="session-cleo",
        source_hash="hash-cleo",
        last_event_seq=1,
        path=memory_state_path(memory_root, "productivity"),
    )

    overview = build_memory_overview(memory_root=memory_root)

    assert overview["schema_version"] == 1
    assert overview["summary"] == {
        "active_memories": 3,
        "project_memories": 2,
        "project_scopes": 2,
        "persona_traits": 1,
        "pending_sources": 1,
    }
    assert overview["dream_agent"]["status"] == "idle"
    assert overview["dream_agent"]["pending_count"] == 1
    assert overview["dream_agent"]["last_processed_at"] is not None
    assert {
        (entry["space"], entry["project"], entry["memory_count"])
        for entry in overview["project_summaries"]
    } == {
        ("non_productivity", "general", 1),
        ("productivity", "cleo", 1),
    }
    assert overview["review_sources"] == [
        {
            "id": "productivity:cleo:session-cleo",
            "space": "productivity",
            "project": "cleo",
            "session_id": "session-cleo",
            "status": "pending",
            "source_version": 1,
            "last_event_seq": 1,
            "failure_count": 0,
            "last_error": None,
            "updated_at": overview["review_sources"][0]["updated_at"],
        }
    ]
    assert {entry["scope"] for entry in overview["entries"]} == {"project", "persona"}
    project_memory = next(entry for entry in overview["entries"] if entry["scope"] == "project")
    assert project_memory["evidence"][0]["event_id"].startswith("event-")
    persona = next(entry for entry in overview["entries"] if entry["scope"] == "persona")
    assert persona["tags"] == ["style"]
    assert persona["evidence"] == []


def test_memory_overview_is_empty(tmp_path: Path) -> None:
    overview = build_memory_overview(memory_root=tmp_path / "memory")

    assert overview["summary"]["active_memories"] == 0
    assert overview["entries"] == []
    assert overview["project_summaries"] == []
    assert overview["review_sources"] == []
