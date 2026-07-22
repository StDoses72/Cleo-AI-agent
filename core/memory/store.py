"""Space-bound SQLite indexes for durable memory and compact session history."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from collections.abc import Iterable
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from config.settings import settings
from core.memory.compaction import load_validated_compact
from core.memory.paths import memory_database_path, validate_space

MEMORY_CATEGORIES = {
    "fact",
    "decision",
    "constraint",
    "correction",
    "preference",
    "action",
    "pattern",
    "artifact",
    "question",
}

_CJK_SEQUENCE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
_WORD = re.compile(r"[a-z0-9_][a-z0-9_.-]*", re.IGNORECASE)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _database_path(space: str, path: Path | None) -> Path:
    validate_space(space)
    return path or memory_database_path(settings.MEMORY_DIR, space)


def _connect(space: str, path: Path | None = None) -> sqlite3.Connection:
    database_path = _database_path(space, path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(database_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def ensure_memory_database(space: str, path: Path | None = None) -> Path:
    database_path = _database_path(space, path)
    with closing(_connect(space, database_path)) as conn, conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                category TEXT NOT NULL,
                subject TEXT NOT NULL,
                content TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                importance INTEGER NOT NULL DEFAULT 3,
                status TEXT NOT NULL DEFAULT 'active',
                tags_json TEXT NOT NULL DEFAULT '[]',
                fingerprint TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
                ON memory_entries(space, project, status, category, updated_at);

            CREATE TABLE IF NOT EXISTS memory_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE(memory_id, space, project, session_id, event_id, source_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_evidence_source
                ON memory_evidence(space, project, session_id, source_hash);

            CREATE TABLE IF NOT EXISTS memory_consolidations (
                id TEXT PRIMARY KEY,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                summary_markdown TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(space, project, session_id, source_hash)
            );

            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY,
                space TEXT NOT NULL,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                event_ids_json TEXT NOT NULL,
                content TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                created_at TEXT,
                ended_at TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(space, project, session_id, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS idx_conversation_chunks_scope
                ON conversation_chunks(space, project, updated_at);
            """
        )
    return database_path


def _normalize_text(value: str) -> str:
    return " ".join(value.casefold().split())


def _memory_fingerprint(
    space: str,
    project: str,
    category: str,
    subject: str,
    content: str,
) -> str:
    canonical = "\n".join(
        _normalize_text(value)
        for value in (space, project, category, subject, content)
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _clean_tags(tags: Iterable[str] | None) -> list[str]:
    return sorted({str(tag).strip() for tag in (tags or []) if str(tag).strip()})


def _row_to_memory(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    evidence = conn.execute(
        """
        SELECT space, project, session_id, event_id, source_hash, observed_at
        FROM memory_evidence WHERE memory_id = ?
        ORDER BY observed_at, id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "space": row["space"],
        "project": row["project"],
        "category": row["category"],
        "subject": row["subject"],
        "content": row["content"],
        "confidence": row["confidence"],
        "importance": row["importance"],
        "status": row["status"],
        "tags": json.loads(row["tags_json"] or "[]"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "evidence": [dict(item) for item in evidence],
        "evidence_count": len(evidence),
    }


def upsert_memory(
    *,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    category: str,
    subject: str,
    content: str,
    evidence_event_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    """Upsert one scoped atomic memory with immutable event evidence."""
    space = validate_space(space)
    category = category.strip().casefold()
    subject = subject.strip()
    content = content.strip()
    if category not in MEMORY_CATEGORIES:
        raise ValueError(f"unsupported memory category: {category}")
    if not project.strip() or not session_id.strip() or not source_hash.strip():
        raise ValueError("project, session_id, and source_hash are required")
    if not subject or not content:
        raise ValueError("memory subject and content are required")
    evidence_ids = list(dict.fromkeys(str(item).strip() for item in evidence_event_ids))
    evidence_ids = [item for item in evidence_ids if item]
    if not evidence_ids:
        raise ValueError("at least one evidence event id is required")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence must be between 0 and 1")
    if not 1 <= importance <= 5:
        raise ValueError("importance must be between 1 and 5")

    ensure_memory_database(space, path)
    fingerprint = _memory_fingerprint(space, project, category, subject, content)
    memory_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"cleo-memory:{fingerprint}"))
    now = _now_iso()
    clean_tags = _clean_tags(tags)
    with closing(_connect(space, path)) as conn, conn:
        row = conn.execute(
            "SELECT * FROM memory_entries WHERE fingerprint = ?",
            (fingerprint,),
        ).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO memory_entries(
                    id, space, project, category, subject, content, confidence,
                    importance, status, tags_json, fingerprint, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
                """,
                (
                    memory_id,
                    space,
                    project,
                    category,
                    subject,
                    content,
                    confidence,
                    importance,
                    json.dumps(clean_tags, ensure_ascii=False),
                    fingerprint,
                    now,
                    now,
                ),
            )
        else:
            memory_id = row["id"]
            merged_tags = _clean_tags([*json.loads(row["tags_json"] or "[]"), *clean_tags])
            conn.execute(
                """
                UPDATE memory_entries
                SET confidence = MAX(confidence, ?), importance = MAX(importance, ?),
                    tags_json = ?, status = 'active', updated_at = ?
                WHERE id = ?
                """,
                (
                    confidence,
                    importance,
                    json.dumps(merged_tags, ensure_ascii=False),
                    now,
                    memory_id,
                ),
            )

        for event_id in evidence_ids:
            conn.execute(
                """
                INSERT OR IGNORE INTO memory_evidence(
                    memory_id, space, project, session_id, event_id,
                    source_hash, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (memory_id, space, project, session_id, event_id, source_hash, now),
            )
        row = conn.execute(
            "SELECT * FROM memory_entries WHERE id = ?",
            (memory_id,),
        ).fetchone()
        return _row_to_memory(conn, row)


def _search_tokens(value: str) -> set[str]:
    normalized = _normalize_text(value)
    tokens = set(_WORD.findall(normalized))
    for sequence in _CJK_SEQUENCE.findall(normalized):
        if len(sequence) == 1:
            tokens.add(sequence)
        else:
            tokens.update(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return tokens


def _lexical_score(query: str, subject: str, content: str, tags: list[str]) -> float:
    normalized_query = _normalize_text(query)
    if not normalized_query:
        return 0.0
    subject_text = _normalize_text(subject)
    combined = _normalize_text(" ".join([subject, content, *tags]))
    query_tokens = _search_tokens(normalized_query)
    if not query_tokens:
        return 0.0
    combined_tokens = _search_tokens(combined)
    subject_tokens = _search_tokens(subject_text)
    shared = query_tokens & combined_tokens
    if not shared and normalized_query not in combined:
        return 0.0
    coverage = len(shared) / len(query_tokens)
    subject_coverage = len(query_tokens & subject_tokens) / len(query_tokens)
    phrase_bonus = 1.0 if normalized_query in combined else 0.0
    return coverage * 3.0 + subject_coverage * 1.5 + phrase_bonus


def search_memories(
    *,
    space: str,
    project: str,
    query: str = "",
    categories: list[str] | None = None,
    tags: list[str] | None = None,
    limit: int = 10,
    path: Path | None = None,
) -> list[dict[str, Any]]:
    space = validate_space(space)
    ensure_memory_database(space, path)
    limit = max(1, min(int(limit), 100))
    category_filter = {item.strip().casefold() for item in (categories or []) if item.strip()}
    tag_filter = {item.casefold() for item in _clean_tags(tags)}
    with closing(_connect(space, path)) as conn, conn:
        rows = conn.execute(
            """
            SELECT * FROM memory_entries
            WHERE space = ? AND project = ? AND status = 'active'
            ORDER BY importance DESC, updated_at DESC
            """,
            (space, project),
        ).fetchall()
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            if category_filter and row["category"] not in category_filter:
                continue
            row_tags = json.loads(row["tags_json"] or "[]")
            if tag_filter and not tag_filter.issubset({item.casefold() for item in row_tags}):
                continue
            score = _lexical_score(query, row["subject"], row["content"], row_tags)
            if query.strip() and score <= 0:
                continue
            item = _row_to_memory(conn, row)
            item["score"] = round(score, 4)
            scored.append((score + row["importance"] * 0.01, item))
        scored.sort(key=lambda pair: (pair[0], pair[1]["updated_at"]), reverse=True)
        return [item for _, item in scored[:limit]]


def record_consolidation(
    *,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    summary_markdown: str,
    path: Path | None = None,
) -> None:
    space = validate_space(space)
    ensure_memory_database(space, path)
    identity = f"cleo-consolidation:{space}:{project}:{session_id}:{source_hash}"
    consolidation_id = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
    with closing(_connect(space, path)) as conn, conn:
        conn.execute(
            """
            INSERT INTO memory_consolidations(
                id, space, project, session_id, source_hash,
                summary_markdown, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(space, project, session_id, source_hash) DO UPDATE SET
                summary_markdown = excluded.summary_markdown,
                created_at = excluded.created_at
            """,
            (
                consolidation_id,
                space,
                project,
                session_id,
                source_hash,
                summary_markdown,
                _now_iso(),
            ),
        )


def has_consolidation(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> bool:
    ensure_memory_database(space, path)
    with closing(_connect(space, path)) as conn, conn:
        row = conn.execute(
            """
            SELECT 1 FROM memory_consolidations
            WHERE space = ? AND project = ? AND session_id = ? AND source_hash = ?
            """,
            (space, project, session_id, source_hash),
        ).fetchone()
        return row is not None


def count_source_memories(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> int:
    ensure_memory_database(space, path)
    with closing(_connect(space, path)) as conn, conn:
        row = conn.execute(
            """
            SELECT COUNT(DISTINCT memory_id) AS memory_count
            FROM memory_evidence
            WHERE space = ? AND project = ? AND session_id = ? AND source_hash = ?
            """,
            (space, project, session_id, source_hash),
        ).fetchone()
        return int(row["memory_count"])


def _event_text(event: dict[str, Any]) -> str:
    event_type = event.get("type")
    content = event.get("content")
    if event_type == "human":
        return f"User: {content}"
    if event_type == "ai":
        return f"Assistant: {content}"
    if event_type == "tool_event":
        result = event.get("result")
        if result is None and event.get("result_omitted"):
            result = f"<omitted:{event.get('original_result_characters', 0)} chars>"
        return (
            f"Tool {event.get('name', 'unknown')} ({event.get('status', 'unknown')}): "
            f"args={json.dumps(event.get('args', {}), ensure_ascii=False, default=str)}; "
            f"result={json.dumps(result, ensure_ascii=False, default=str)}"
        )
    return f"{event_type}: {content}"


def _conversation_chunks(payload: dict[str, Any]) -> list[dict[str, Any]]:
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for event in payload.get("events") or []:
        if not isinstance(event, dict):
            continue
        if event.get("type") == "human" and current:
            chunks.append(current)
            current = []
        current.append(event)
    if current:
        chunks.append(current)

    results: list[dict[str, Any]] = []
    for index, events in enumerate(chunks):
        event_ids: list[str] = []
        for event in events:
            event_ids.extend(str(item) for item in event.get("source_event_ids") or [])
            if event.get("id"):
                event_ids.append(str(event["id"]))
        results.append(
            {
                "index": index,
                "event_ids": list(dict.fromkeys(event_ids)),
                "content": "\n".join(_event_text(event) for event in events),
                "created_at": events[0].get("created_at"),
                "ended_at": events[-1].get("created_at"),
            }
        )
    return results


def replace_conversation_chunks(
    payload: dict[str, Any],
    *,
    path: Path | None = None,
) -> int:
    space = validate_space(str(payload.get("space") or ""))
    project = str(payload.get("project") or "")
    session_id = str(payload.get("session_id") or "")
    source_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
    if not project or not session_id or not source_hash:
        raise ValueError("compact payload is missing project, session id, or source hash")
    chunks = _conversation_chunks(payload)
    ensure_memory_database(space, path)
    now = _now_iso()
    with closing(_connect(space, path)) as conn, conn:
        conn.execute(
            """
            DELETE FROM conversation_chunks
            WHERE space = ? AND project = ? AND session_id = ?
            """,
            (space, project, session_id),
        )
        for chunk in chunks:
            first_id = chunk["event_ids"][0] if chunk["event_ids"] else "empty"
            identity = (
                f"cleo-chunk:{space}:{project}:{session_id}:"
                f"{chunk['index']}:{first_id}"
            )
            chunk_id = str(uuid.uuid5(uuid.NAMESPACE_URL, identity))
            conn.execute(
                """
                INSERT INTO conversation_chunks(
                    id, space, project, session_id, chunk_index, event_ids_json,
                    content, source_hash, created_at, ended_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk_id,
                    space,
                    project,
                    session_id,
                    chunk["index"],
                    json.dumps(chunk["event_ids"], ensure_ascii=False),
                    chunk["content"],
                    source_hash,
                    chunk["created_at"],
                    chunk["ended_at"],
                    now,
                ),
            )
    return len(chunks)


def search_conversation_history(
    *,
    space: str,
    project: str,
    query: str,
    session_ids: list[str] | None = None,
    top_k: int = 5,
    path: Path | None = None,
    memory_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Lexically retrieve scoped history and reject stale compact projections."""
    space = validate_space(space)
    ensure_memory_database(space, path)
    top_k = max(1, min(int(top_k), 20))
    root = memory_root or settings.MEMORY_DIR
    selected_sessions = {str(item) for item in (session_ids or []) if str(item)}
    with closing(_connect(space, path)) as conn, conn:
        rows = conn.execute(
            """
            SELECT * FROM conversation_chunks
            WHERE space = ? AND project = ?
            ORDER BY updated_at DESC LIMIT 1000
            """,
            (space, project),
        ).fetchall()

    current_hashes: dict[str, str | None] = {}
    results: list[dict[str, Any]] = []
    for row in rows:
        session_id = row["session_id"]
        if selected_sessions and session_id not in selected_sessions:
            continue
        if session_id not in current_hashes:
            try:
                payload = load_validated_compact(
                    memory_root=root,
                    space=space,
                    project=project,
                    session_id=session_id,
                )
                current_hashes[session_id] = (payload.get("source") or {}).get(
                    "source_content_hash"
                )
            except (OSError, json.JSONDecodeError, ValueError):
                current_hashes[session_id] = None
        if current_hashes[session_id] != row["source_hash"]:
            continue
        score = _lexical_score(query, "", row["content"], [])
        if score <= 0:
            continue
        results.append(
            {
                "space": space,
                "project": project,
                "session_id": session_id,
                "chunk_index": row["chunk_index"],
                "event_ids": json.loads(row["event_ids_json"]),
                "content": row["content"],
                "score": round(score, 4),
                "retrieval": "local_lexical_v2",
                "source_hash": row["source_hash"],
                "created_at": row["created_at"],
                "ended_at": row["ended_at"],
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    return results[:top_k]
