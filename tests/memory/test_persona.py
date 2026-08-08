import sqlite3
from pathlib import Path

from cleo.memory.persona import (
    list_persona_traits,
    render_persona_markdown,
    upsert_persona_trait,
)


def test_persona_traits_are_global_evidence_backed_and_rendered_without_scope_leaks(
    tmp_path: Path,
) -> None:
    memory_root = tmp_path / "memory"
    persona_path = tmp_path / "PERSONA.md"
    first = upsert_persona_trait(
        memory_root=memory_root,
        category="communication",
        trait="Uses concise Chinese when the user starts in Chinese.",
        space="non_productivity",
        project="general",
        session_id="session-a",
        source_hash="hash-a",
        evidence_event_ids=["event-a"],
        confidence=0.8,
    )
    repeated = upsert_persona_trait(
        memory_root=memory_root,
        category="communication",
        trait="Uses concise Chinese when the user starts in Chinese.",
        space="productivity",
        project="secret-project",
        session_id="session-b",
        source_hash="hash-b",
        evidence_event_ids=["event-b"],
        confidence=0.9,
    )

    assert repeated["id"] == first["id"]
    assert repeated["evidence_count"] == 2
    entries = list_persona_traits(memory_root=memory_root)
    assert len(entries) == 1
    assert entries[0]["confidence"] == 0.9

    text = render_persona_markdown(
        memory_root=memory_root,
        persona_path=persona_path,
    )
    assert "Uses concise Chinese" in text
    assert "evidence: 2 observation(s)" in text
    assert "Core Identity" not in text
    assert "secret-project" not in text
    assert "session-b" not in text
    assert "event-b" not in text

    with sqlite3.connect(memory_root / "persona.sqlite3") as conn:
        evidence = conn.execute(
            "SELECT space, project, session_id, event_id FROM persona_evidence ORDER BY id"
        ).fetchall()
    assert evidence == [
        ("non_productivity", "general", "session-a", "event-a"),
        ("productivity", "secret-project", "session-b", "event-b"),
    ]


def test_persona_rejects_unknown_categories_and_empty_evidence(tmp_path: Path) -> None:
    common = {
        "memory_root": tmp_path / "memory",
        "trait": "A trait.",
        "space": "non_productivity",
        "project": "general",
        "session_id": "session-a",
        "source_hash": "hash-a",
    }

    try:
        upsert_persona_trait(
            **common,
            category="policy",
            evidence_event_ids=["event-a"],
        )
    except ValueError as exc:
        assert "unsupported persona category" in str(exc)
    else:
        raise AssertionError("unsupported persona category must be rejected")

    try:
        upsert_persona_trait(
            **common,
            category="communication",
            evidence_event_ids=[],
        )
    except ValueError as exc:
        assert "requires at least one evidence" in str(exc)
    else:
        raise AssertionError("persona evidence must be required")
