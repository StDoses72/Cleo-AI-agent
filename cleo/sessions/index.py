"""The global session index (``sessions.sqlite3``), rebuildable from the manifests."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from threading import RLock
from typing import Any


class SqliteSessionIndex:
    """Look sessions up by id, scope or native harness session.

    The manifests on disk are the source of truth; every row can be rebuilt from them.
    """

    def __init__(self, path: Path, lock: RLock) -> None:
        self.path = path
        self._lock = lock
        self._ready = False

    def ensure(self) -> bool:
        """Purpose: Create the table once per instance, again if the file was deleted.

        Output: Whether the database file was created by this call (it is then empty).
        """
        if self._ready and self.path.exists():
            return False
        with self._lock:
            if self._ready and self.path.exists():
                return False
            created = not self.path.exists()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(self.path)) as conn, conn:
                conn.execute("PRAGMA journal_mode = WAL")
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        space TEXT NOT NULL,
                        project TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        native_session_id TEXT,
                        owner_type TEXT NOT NULL,
                        owner_id TEXT,
                        status TEXT NOT NULL,
                        title TEXT,
                        cwd TEXT,
                        parent_session_id TEXT,
                        manifest_path TEXT NOT NULL UNIQUE,
                        last_event_seq INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_sessions_scope
                        ON sessions(space, project, status, updated_at);
                    CREATE INDEX IF NOT EXISTS idx_sessions_native
                        ON sessions(provider, native_session_id);
                    """
                )
                columns = {
                    str(row[1]) for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
                }
                if "title" not in columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN title TEXT")
            self._ready = True
            return created

    def upsert(self, manifest: dict[str, Any], manifest_path: Path) -> None:
        """Purpose: Insert or refresh the row of one manifest stored at ``manifest_path``."""
        self.ensure()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute(
                """
                INSERT INTO sessions(
                    id, space, project, provider, native_session_id, owner_type,
                    owner_id, status, title, cwd, parent_session_id, manifest_path,
                    last_event_seq, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    space = excluded.space,
                    project = excluded.project,
                    provider = excluded.provider,
                    native_session_id = excluded.native_session_id,
                    owner_type = excluded.owner_type,
                    owner_id = excluded.owner_id,
                    status = excluded.status,
                    title = excluded.title,
                    cwd = excluded.cwd,
                    parent_session_id = excluded.parent_session_id,
                    manifest_path = excluded.manifest_path,
                    last_event_seq = excluded.last_event_seq,
                    updated_at = excluded.updated_at
                """,
                (
                    manifest["id"],
                    manifest["space"],
                    manifest["project"],
                    manifest["provider"],
                    manifest.get("native_session_id"),
                    manifest["owner_type"],
                    manifest.get("owner_id"),
                    manifest["status"],
                    manifest.get("title"),
                    manifest.get("cwd"),
                    manifest.get("parent_session_id"),
                    str(manifest_path),
                    int(manifest.get("last_event_seq", 0)),
                    manifest["created_at"],
                    manifest["updated_at"],
                ),
            )

    def row(self, session_id: str) -> sqlite3.Row | None:
        self.ensure()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            return conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()

    def delete(self, session_id: str) -> None:
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def clear(self) -> None:
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.execute("DELETE FROM sessions")

    def native_manifest_path(
        self, *, provider: str, native_session_id: str, space: str,
    ) -> str | None:
        """Purpose: Find the newest session bound to a native harness session."""
        self.ensure()
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT manifest_path FROM sessions
                WHERE provider = ? AND native_session_id = ? AND space = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (provider, native_session_id, space),
            ).fetchone()
        return None if row is None else str(row["manifest_path"])

    def rows(
        self,
        *,
        space: str | None = None,
        project: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        """Purpose: List rows newest first, filtered by already validated scope values."""
        clauses: list[str] = []
        values: list[str] = []
        if space is not None:
            clauses.append("space = ?")
            values.append(space)
        if project is not None:
            clauses.append("project = ?")
            values.append(project)
        if status is not None:
            clauses.append("status = ?")
            values.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with closing(sqlite3.connect(self.path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT * FROM sessions {where} ORDER BY updated_at DESC",
                values,
            ).fetchall()
        return [dict(row) for row in rows]
