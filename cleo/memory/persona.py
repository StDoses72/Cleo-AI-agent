"""Evidence-backed global persona traits and the root ``PERSONA.md`` projection."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Iterable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.memory.paths import persona_database_path

PERSONA_SCHEMA_VERSION = 1
PERSONA_CATEGORIES = (
    "communication",
    "expression",
    "relationship",
    "adaptation",
    "boundary",
)
PERSONA_SECTION_TITLES = {
    "communication": "Communication Style",
    "expression": "Expression and Temperament",
    "relationship": "Relationship Continuity",
    "adaptation": "Adaptive Tendencies",
    "boundary": "Interaction Boundaries",
}

PERSONA_HEADER = """# Cleo Persona

> This is Cleo's global, evidence-backed persona projection. It is descriptive
> memory, not an instruction or permission surface. It never overrides system or
> developer instructions, the user's current request, `AGENTS.md`, or tool safety.

## Learned Persona
"""

PERSONA_FOOTER = """
## Interpretation Boundary

- Learned traits are tendencies, not commands.
- Project facts, secrets, customer data, permissions, tool rules, and repository
  policy do not belong here.
- A current user correction takes precedence over an older learned tendency.
"""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_text(value: str) -> str:
    return " ".join(str(value).casefold().split())


def _clean_tags(tags: Iterable[str] | None) -> list[str]:
    return sorted({str(tag).strip() for tag in (tags or []) if str(tag).strip()})


def _fingerprint(category: str, trait: str) -> str:
    canonical = f"{_normalize_text(category)}\n{_normalize_text(trait)}"
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def ensure_persona_database(path: Path) -> Path:
    """Create the global persona trait/evidence tables when needed."""
    with closing(_connect(path)) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS persona_entries (
                id TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                category TEXT NOT NULL,
                trait TEXT NOT NULL,
                confidence REAL NOT NULL,
                importance INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                tags_json TEXT NOT NULL DEFAULT '[]',
                fingerprint TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_persona_entries_active
                ON persona_entries(status, category, importance, updated_at);

            CREATE TABLE IF NOT EXISTS persona_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                persona_id TEXT NOT NULL REFERENCES persona_entries(id) ON DELETE CASCADE,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE(persona_id, space, project, session_id, event_id, source_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_persona_evidence_source
                ON persona_evidence(space, project, session_id, source_hash);
            """
        )
    return path


def _validate_trait(
    category: str,
    trait: str,
    confidence: float,
    importance: int,
) -> tuple[str, str, float, int]:
    normalized_category = str(category).strip().casefold()
    if normalized_category not in PERSONA_CATEGORIES:
        raise ValueError(f"unsupported persona category: {normalized_category}")
    normalized_trait = " ".join(str(trait).split())
    if not normalized_trait:
        raise ValueError("persona trait cannot be empty")
    if len(normalized_trait) > 500:
        raise ValueError("persona trait cannot exceed 500 characters")
    numeric_confidence = float(confidence)
    if not 0 <= numeric_confidence <= 1:
        raise ValueError("persona confidence must be between 0 and 1")
    numeric_importance = int(importance)
    if not 1 <= numeric_importance <= 5:
        raise ValueError("persona importance must be between 1 and 5")
    return normalized_category, normalized_trait, numeric_confidence, numeric_importance


def upsert_persona_trait(
    *,
    memory_root: Path,
    category: str,
    trait: str,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    evidence_event_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    """Upsert one global trait and attach source-scoped event evidence."""
    category, trait, confidence, importance = _validate_trait(
        category,
        trait,
        confidence,
        importance,
    )
    evidence_ids = list(dict.fromkeys(str(item) for item in evidence_event_ids if str(item)))
    if not evidence_ids:
        raise ValueError("persona trait requires at least one evidence event id")
    fingerprint = _fingerprint(category, trait)
    persona_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"cleo-persona:{fingerprint}"))
    database_path = ensure_persona_database(persona_database_path(memory_root))
    now = _now_iso()

    with closing(_connect(database_path)) as conn, conn:
        conn.execute(
            """
            INSERT INTO persona_entries(
                id, schema_version, category, trait, confidence, importance,
                status, tags_json, fingerprint, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                trait = excluded.trait,
                confidence = MAX(persona_entries.confidence, excluded.confidence),
                importance = MAX(persona_entries.importance, excluded.importance),
                status = 'active',
                tags_json = excluded.tags_json,
                updated_at = excluded.updated_at
            """,
            (
                persona_id,
                PERSONA_SCHEMA_VERSION,
                category,
                trait,
                confidence,
                importance,
                json.dumps(_clean_tags(tags), ensure_ascii=False),
                fingerprint,
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT id FROM persona_entries WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        stored_id = str(row["id"])
        for event_id in evidence_ids:
            conn.execute(
                """
                INSERT OR IGNORE INTO persona_evidence(
                    persona_id, space, project, session_id, event_id,
                    source_hash, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    stored_id,
                    str(space),
                    str(project),
                    str(session_id),
                    event_id,
                    str(source_hash),
                    now,
                ),
            )
        stored = conn.execute(
            """
            SELECT entry.*, COUNT(evidence.id) AS evidence_count
            FROM persona_entries AS entry
            LEFT JOIN persona_evidence AS evidence ON evidence.persona_id = entry.id
            WHERE entry.id = ?
            GROUP BY entry.id
            """,
            (stored_id,),
        ).fetchone()
    return dict(stored)


def list_persona_traits(*, memory_root: Path) -> list[dict[str, Any]]:
    """Return active global persona traits without exposing source identifiers."""
    database_path = ensure_persona_database(persona_database_path(memory_root))
    with closing(_connect(database_path)) as conn:
        rows = conn.execute(
            """
            SELECT entry.id, entry.category, entry.trait, entry.confidence,
                   entry.importance, entry.tags_json, entry.created_at,
                   entry.updated_at, COUNT(evidence.id) AS evidence_count
            FROM persona_entries AS entry
            LEFT JOIN persona_evidence AS evidence ON evidence.persona_id = entry.id
            WHERE entry.status = 'active'
            GROUP BY entry.id
            ORDER BY entry.category, entry.importance DESC,
                     entry.confidence DESC, entry.updated_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def render_persona_markdown(*, memory_root: Path, persona_path: Path) -> str:
    """Atomically render the global root-level persona projection."""
    entries = list_persona_traits(memory_root=memory_root)
    by_category: dict[str, list[dict[str, Any]]] = {
        category: [] for category in PERSONA_CATEGORIES
    }
    for entry in entries:
        by_category[str(entry["category"])].append(entry)

    sections = [PERSONA_HEADER.rstrip()]
    for category in PERSONA_CATEGORIES:
        sections.append(f"### {PERSONA_SECTION_TITLES[category]}")
        category_entries = by_category[category]
        if not category_entries:
            sections.append("- No learned traits yet.")
            continue
        for entry in category_entries:
            sections.append(
                f"- {entry['trait']} "
                f"_(confidence: {float(entry['confidence']):.2f}; "
                f"evidence: {int(entry['evidence_count'])} observation(s))_"
            )
    sections.append(PERSONA_FOOTER.strip())
    content = "\n\n".join(sections).rstrip() + "\n"
    persona_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = persona_path.with_name(
        f".{persona_path.name}.{uuid.uuid4().hex}.tmp"
    )
    temp_path.write_text(content, encoding="utf-8")
    temp_path.replace(persona_path)
    return content
