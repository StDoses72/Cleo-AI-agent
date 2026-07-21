"""SQLite-backed atomic memory, evidence, and lightweight history retrieval."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from config.settings import settings
from core.memory.compaction import load_validated_compact

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


def _database_path(path: Path | None) -> Path:
    return path or settings.MEMORY_DATABASE_PATH


def _connect(path: Path | None = None) -> sqlite3.Connection:
    database_path = _database_path(path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(database_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def ensure_memory_database(path: Path | None = None) -> Path:
    database_path = _database_path(path)
    with _connect(database_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
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
            CREATE INDEX IF NOT EXISTS idx_memory_entries_project
                ON memory_entries(project, status, category, updated_at);

            CREATE TABLE IF NOT EXISTS memory_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
                project TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                UNIQUE(memory_id, project, thread_id, message_id, source_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_evidence_source
                ON memory_evidence(project, thread_id, source_hash);

            CREATE TABLE IF NOT EXISTS memory_consolidations (
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                summary_markdown TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(project, thread_id, source_hash)
            );

            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                message_ids_json TEXT NOT NULL,
                content TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                created_at TEXT,
                ended_at TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(project, thread_id, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS idx_conversation_chunks_project
                ON conversation_chunks(project, updated_at);
            """
        )
    return database_path


def _normalize_text(value: str) -> str:
    return " ".join(value.casefold().split())


def _memory_fingerprint(project: str, category: str, subject: str, content: str) -> str:
    canonical = "\n".join(
        _normalize_text(value) for value in (project, category, subject, content)
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _clean_tags(tags: Iterable[str] | None) -> list[str]:
    return sorted({str(tag).strip() for tag in (tags or []) if str(tag).strip()})


def _row_to_memory(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    evidence = conn.execute(
        """
        SELECT project, thread_id, message_id, source_hash, observed_at
        FROM memory_evidence WHERE memory_id = ?
        ORDER BY observed_at, id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
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
    project: str,
    thread_id: str,
    source_hash: str,
    category: str,
    subject: str,
    content: str,
    evidence_message_ids: list[str],
    confidence: float = 1.0,
    importance: int = 3,
    tags: list[str] | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    """Upsert one project-scoped atomic memory and immutable source evidence."""
    category = category.strip().casefold()
    subject = subject.strip()
    content = content.strip()
    if category not in MEMORY_CATEGORIES:
        raise ValueError(f"unsupported memory category: {category}")
    if not project.strip() or not thread_id.strip() or not source_hash.strip():
        raise ValueError("project, thread_id, and source_hash are required")
    if not subject or not content:
        raise ValueError("memory subject and content are required")
    evidence_ids = list(dict.fromkeys(str(item).strip() for item in evidence_message_ids))
    evidence_ids = [item for item in evidence_ids if item]
    if not evidence_ids:
        raise ValueError("at least one evidence message id is required")
    if not 0 <= confidence <= 1:
        raise ValueError("confidence must be between 0 and 1")
    if not 1 <= importance <= 5:
        raise ValueError("importance must be between 1 and 5")

    ensure_memory_database(path)
    fingerprint = _memory_fingerprint(project, category, subject, content)
    memory_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"cleo-memory:{fingerprint}"))
    now = _now_iso()
    clean_tags = _clean_tags(tags)
    with _connect(path) as conn:
        row = conn.execute(
            "SELECT * FROM memory_entries WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        if row is None:
            conn.execute(
                """
                INSERT INTO memory_entries(
                    id, project, category, subject, content, confidence, importance,
                    status, tags_json, fingerprint, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
                """,
                (
                    memory_id,
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

        for message_id in evidence_ids:
            conn.execute(
                """
                INSERT OR IGNORE INTO memory_evidence(
                    memory_id, project, thread_id, message_id, source_hash, observed_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (memory_id, project, thread_id, message_id, source_hash, now),
            )
        row = conn.execute("SELECT * FROM memory_entries WHERE id = ?", (memory_id,)).fetchone()
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
    project: str,
    query: str = "",
    categories: list[str] | None = None,
    tags: list[str] | None = None,
    limit: int = 10,
    path: Path | None = None,
) -> list[dict[str, Any]]:
    ensure_memory_database(path)
    limit = max(1, min(int(limit), 100))
    category_filter = {item.strip().casefold() for item in (categories or []) if item.strip()}
    tag_filter = {item.casefold() for item in _clean_tags(tags)}
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT * FROM memory_entries
            WHERE project = ? AND status = 'active'
            ORDER BY importance DESC, updated_at DESC
            """,
            (project,),
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
    project: str,
    thread_id: str,
    source_hash: str,
    summary_markdown: str,
    path: Path | None = None,
) -> None:
    ensure_memory_database(path)
    consolidation_id = str(
        uuid.uuid5(uuid.NAMESPACE_URL, f"cleo-consolidation:{project}:{thread_id}:{source_hash}")
    )
    with _connect(path) as conn:
        conn.execute(
            """
            INSERT INTO memory_consolidations(
                id, project, thread_id, source_hash, summary_markdown, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(project, thread_id, source_hash) DO UPDATE SET
                summary_markdown = excluded.summary_markdown,
                created_at = excluded.created_at
            """,
            (consolidation_id, project, thread_id, source_hash, summary_markdown, _now_iso()),
        )


def has_consolidation(
    project: str,
    thread_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> bool:
    ensure_memory_database(path)
    with _connect(path) as conn:
        row = conn.execute(
            """
            SELECT 1 FROM memory_consolidations
            WHERE project = ? AND thread_id = ? AND source_hash = ?
            """,
            (project, thread_id, source_hash),
        ).fetchone()
        return row is not None


def count_source_memories(
    project: str,
    thread_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> int:
    ensure_memory_database(path)
    with _connect(path) as conn:
        row = conn.execute(
            """
            SELECT COUNT(DISTINCT memory_id) AS memory_count
            FROM memory_evidence
            WHERE project = ? AND thread_id = ? AND source_hash = ?
            """,
            (project, thread_id, source_hash),
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
    for event in payload.get("messages") or []:
        if not isinstance(event, dict):
            continue
        if event.get("type") == "human" and current:
            chunks.append(current)
            current = []
        current.append(event)
    if current:
        chunks.append(current)

    results = []
    for index, events in enumerate(chunks):
        message_ids: list[str] = []
        for event in events:
            message_ids.extend(str(item) for item in event.get("source_message_ids") or [])
            if event.get("id"):
                message_ids.append(str(event["id"]))
        message_ids = list(dict.fromkeys(message_ids))
        results.append(
            {
                "index": index,
                "message_ids": message_ids,
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
    project = str(payload.get("project") or "")
    thread_id = str(payload.get("thread_id") or "")
    source_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
    if not project or not thread_id or not source_hash:
        raise ValueError("compact payload is missing project, thread id, or source hash")
    chunks = _conversation_chunks(payload)
    ensure_memory_database(path)
    now = _now_iso()
    with _connect(path) as conn:
        conn.execute(
            "DELETE FROM conversation_chunks WHERE project = ? AND thread_id = ?",
            (project, thread_id),
        )
        for chunk in chunks:
            first_id = chunk["message_ids"][0] if chunk["message_ids"] else "empty"
            chunk_id = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"cleo-chunk:{project}:{thread_id}:{chunk['index']}:{first_id}",
                )
            )
            conn.execute(
                """
                INSERT INTO conversation_chunks(
                    id, project, thread_id, chunk_index, message_ids_json, content,
                    source_hash, created_at, ended_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk_id,
                    project,
                    thread_id,
                    chunk["index"],
                    json.dumps(chunk["message_ids"], ensure_ascii=False),
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
    project: str,
    query: str,
    thread_ids: list[str] | None = None,
    top_k: int = 5,
    path: Path | None = None,
    compact_dir: Path | None = None,
    thread_objects_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Lexically retrieve project-bound history and reject stale indexed chunks."""
    ensure_memory_database(path)
    top_k = max(1, min(int(top_k), 20))
    compact_root = compact_dir or settings.COMPACT_THREADS_DIR
    raw_root = thread_objects_dir or settings.THREAD_OBJECTS_DIR
    selected_threads = {str(item) for item in (thread_ids or []) if str(item)}
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT * FROM conversation_chunks
            WHERE project = ? ORDER BY updated_at DESC LIMIT 1000
            """,
            (project,),
        ).fetchall()

    current_hashes: dict[str, str | None] = {}
    results: list[dict[str, Any]] = []
    for row in rows:
        thread_id = row["thread_id"]
        if selected_threads and thread_id not in selected_threads:
            continue
        if thread_id not in current_hashes:
            try:
                payload = load_validated_compact(
                    project=project,
                    thread_id=thread_id,
                    thread_objects_dir=raw_root,
                    compact_dir=compact_root,
                )
                current_hashes[thread_id] = (payload.get("source") or {}).get(
                    "source_content_hash"
                )
            except (OSError, json.JSONDecodeError, ValueError):
                current_hashes[thread_id] = None
        if current_hashes[thread_id] != row["source_hash"]:
            continue
        score = _lexical_score(query, "", row["content"], [])
        if score <= 0:
            continue
        results.append(
            {
                "thread_id": thread_id,
                "chunk_index": row["chunk_index"],
                "message_ids": json.loads(row["message_ids_json"]),
                "content": row["content"],
                "score": round(score, 4),
                "retrieval": "local_lexical_v1",
                "source_hash": row["source_hash"],
                "created_at": row["created_at"],
                "ended_at": row["ended_at"],
            }
        )
    results.sort(key=lambda item: item["score"], reverse=True)
    return results[:top_k]
