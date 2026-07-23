"""Persistent session manifests, append-only events, and the global session index."""

from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from langchain_core.messages import BaseMessage, messages_from_dict, messages_to_dict

from core.memory.compaction import (
    event_content_hash,
    load_events,
    write_compact_events,
)
from core.memory.paths import (
    MEMORY_SPACES,
    events_path,
    manifest_path,
    memory_database_path,
    memory_state_path,
    session_directory,
    validate_name,
    validate_space,
)
from core.memory.state import (
    discard_session_source,
    get_session_source,
    touch_session_source,
)
from core.memory.store import delete_conversation_chunks, replace_conversation_chunks

MANIFEST_SCHEMA_VERSION = 1
EVENT_SCHEMA_VERSION = 1


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    temp_path.replace(path)


def _atomic_write_jsonl(path: Path, payloads: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
        for payload in payloads:
            stream.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    temp_path.replace(path)


def _title_text(content: Any) -> str:
    if isinstance(content, str):
        return " ".join(content.split())
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return " ".join(" ".join(parts).split())
    return ""


def _automatic_title(content: Any, limit: int = 60) -> str | None:
    title = _title_text(content)
    if not title:
        return None
    if len(title) <= limit:
        return title
    return title[: limit - 3].rstrip() + "..."


def _message_type(serialized: dict[str, Any]) -> str:
    data = serialized.get("data") if isinstance(serialized.get("data"), dict) else serialized
    return str(serialized.get("type") or data.get("type") or "unknown")


def _message_data(serialized: dict[str, Any]) -> dict[str, Any]:
    data = serialized.get("data")
    return data if isinstance(data, dict) else serialized


def _message_content(serialized: dict[str, Any]) -> Any:
    return _message_data(serialized).get("content")


def _event_type_for_message(message_type: str) -> str:
    return {
        "human": "user_message",
        "ai": "assistant_message",
        "system": "system_message",
        "tool": "tool_result",
    }.get(message_type, "provider_event")


def _actor_for_message(message_type: str) -> str:
    return {
        "human": "user",
        "ai": "assistant",
        "system": "system",
        "tool": "tool",
    }.get(message_type, "provider")


class SessionStore:
    """File-first session storage with a rebuildable global SQLite registry."""

    def __init__(self, memory_root: Path | str, index_path: Path | str | None = None) -> None:
        self.memory_root = Path(memory_root).expanduser().resolve()
        self.index_path = (
            Path(index_path).expanduser().resolve()
            if index_path is not None
            else self.memory_root / "sessions.sqlite3"
        )
        self._lock = RLock()
        self._ensure_index()

    def create_session(
        self,
        *,
        session_id: str,
        space: str,
        project: str,
        provider: str,
        owner_type: str,
        native_session_id: str | None = None,
        owner_id: str | None = None,
        cwd: str | None = None,
        parent_session_id: str | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        space = validate_space(space)
        project = validate_name(project, "project")
        session_id = validate_name(session_id, "session_id")
        provider = validate_name(provider, "provider")
        owner_type = validate_name(owner_type, "owner_type")
        path = manifest_path(self.memory_root, space, project, session_id)
        with self._lock:
            if path.exists() or self._session_index_row(session_id) is not None:
                raise ValueError(f"session already exists: {session_id}")
            now = _now_iso()
            manifest = {
                "schema_version": MANIFEST_SCHEMA_VERSION,
                "id": session_id,
                "space": space,
                "project": project,
                "provider": provider,
                "native_session_id": native_session_id,
                "owner_type": owner_type,
                "owner_id": owner_id,
                "status": "created",
                "title": None,
                "cwd": cwd,
                "parent_session_id": parent_session_id,
                "tags": sorted({str(tag).strip() for tag in (tags or []) if str(tag).strip()}),
                "last_event_seq": 0,
                "last_compacted_seq": 0,
                "source_hash": None,
                "source_version": 0,
                "created_at": now,
                "updated_at": now,
            }
            _atomic_write_json(path, manifest)
            self._upsert_index(manifest, path)
            self.append_event(
                space=space,
                project=project,
                session_id=session_id,
                event_type="session_created",
                actor="system",
                data={
                    "provider": provider,
                    "owner_type": owner_type,
                    "native_session_id": native_session_id,
                    "owner_id": owner_id,
                    "cwd": cwd,
                    "parent_session_id": parent_session_id,
                    "tags": manifest["tags"],
                },
            )
            return self.load_manifest(session_id)

    def ensure_session(self, **kwargs: Any) -> dict[str, Any]:
        session_id = validate_name(str(kwargs["session_id"]), "session_id")
        try:
            return self.load_manifest(session_id)
        except FileNotFoundError:
            return self.create_session(**kwargs)

    def load_manifest(self, session_id: str) -> dict[str, Any]:
        session_id = validate_name(session_id, "session_id")
        with self._lock:
            row = self._session_index_row(session_id)
            if row is None:
                self.rebuild_index()
                row = self._session_index_row(session_id)
            if row is None:
                raise FileNotFoundError(session_id)
            path = Path(row["manifest_path"])
            try:
                manifest = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError) as exc:
                raise FileNotFoundError(session_id) from exc
            self._validate_manifest(manifest)
            return manifest

    def update_manifest(self, session_id: str, **changes: Any) -> dict[str, Any]:
        with self._lock:
            manifest = self.load_manifest(session_id)
            protected = {"schema_version", "id", "space", "project", "created_at"}
            if protected & changes.keys():
                raise ValueError("session identity fields cannot be updated")
            manifest.update(changes)
            manifest["updated_at"] = _now_iso()
            path = manifest_path(
                self.memory_root,
                manifest["space"],
                manifest["project"],
                manifest["id"],
            )
            _atomic_write_json(path, manifest)
            self._upsert_index(manifest, path)
            return manifest

    def append_event(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
        event_type: str,
        actor: str,
        content: Any = None,
        data: dict[str, Any] | None = None,
        message: dict[str, Any] | None = None,
        source_message_id: str | None = None,
        event_id: str | None = None,
        created_at: str | None = None,
    ) -> dict[str, Any]:
        events = self.append_events(
            space=space,
            project=project,
            session_id=session_id,
            events=[
                {
                    "type": event_type,
                    "actor": actor,
                    "content": content,
                    "data": data or {},
                    "message": message,
                    "source_message_id": source_message_id,
                    "id": event_id,
                    "created_at": created_at,
                }
            ],
        )
        return events[0]

    def append_events(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
        events: list[dict[str, Any]],
        manifest_updates: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        space = validate_space(space)
        project = validate_name(project, "project")
        session_id = validate_name(session_id, "session_id")
        if not events:
            return []
        with self._lock:
            manifest = self.load_manifest(session_id)
            if (manifest["space"], manifest["project"]) != (space, project):
                raise ValueError("session event binding does not match its manifest")
            output_path = events_path(self.memory_root, space, project, session_id)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            existing_ids = {
                str(event.get("id")) for event in self.read_events(session_id) if event.get("id")
            }
            next_seq = int(manifest.get("last_event_seq", 0))
            appended: list[dict[str, Any]] = []
            for item in events:
                event_type = validate_name(str(item.get("type") or ""), "event_type")
                actor = validate_name(str(item.get("actor") or ""), "actor")
                event_id = str(item.get("id") or f"evt_{uuid.uuid4().hex}")
                if event_id in existing_ids:
                    continue
                next_seq += 1
                event: dict[str, Any] = {
                    "schema_version": EVENT_SCHEMA_VERSION,
                    "id": event_id,
                    "seq": next_seq,
                    "session_id": session_id,
                    "space": space,
                    "project": project,
                    "type": event_type,
                    "actor": actor,
                    "created_at": item.get("created_at") or _now_iso(),
                }
                for key in ("content", "data", "message", "source_message_id"):
                    value = item.get(key)
                    if value not in (None, {}, []):
                        event[key] = value
                appended.append(event)
                existing_ids.add(event_id)

            if appended:
                with output_path.open("a", encoding="utf-8", newline="\n") as stream:
                    for event in appended:
                        stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
                    stream.flush()
                manifest["last_event_seq"] = appended[-1]["seq"]
                if not manifest.get("title"):
                    for event in appended:
                        if (
                            event.get("type") == "user_message"
                            or event.get("actor") == "user"
                        ):
                            title = _automatic_title(event.get("content"))
                            if title:
                                manifest["title"] = title
                                break
            if manifest_updates:
                manifest.update(manifest_updates)
            manifest["updated_at"] = _now_iso()
            manifest_file = manifest_path(self.memory_root, space, project, session_id)
            _atomic_write_json(manifest_file, manifest)
            self._upsert_index(manifest, manifest_file)
            return appended

    def read_events(self, session_id: str) -> list[dict[str, Any]]:
        manifest = self.load_manifest(session_id)
        path = events_path(
            self.memory_root,
            manifest["space"],
            manifest["project"],
            session_id,
        )
        return load_events(path) if path.exists() else []

    def sync_langchain_messages(
        self,
        *,
        session_id: str,
        space: str,
        project: str,
        messages: list[BaseMessage],
        provider: str = "cleo",
        owner_type: str = "user",
        cwd: str | None = None,
        status: str = "active",
    ) -> dict[str, Any]:
        manifest = self.ensure_session(
            session_id=session_id,
            space=space,
            project=project,
            provider=provider,
            owner_type=owner_type,
            cwd=cwd,
        )
        existing_source_ids = {
            str(event.get("source_message_id"))
            for event in self.read_events(session_id)
            if event.get("source_message_id")
        }
        serialized_messages = messages_to_dict(messages)
        new_events: list[dict[str, Any]] = []
        for index, serialized in enumerate(serialized_messages):
            data = _message_data(serialized)
            message_type = _message_type(serialized)
            source_message_id = str(data.get("id") or f"{message_type}-{index}")
            data["id"] = source_message_id
            if source_message_id in existing_source_ids:
                continue
            new_events.append(
                {
                    "type": _event_type_for_message(message_type),
                    "actor": _actor_for_message(message_type),
                    "content": _message_content(serialized),
                    "message": serialized,
                    "source_message_id": source_message_id,
                    "created_at": data.get("created_at"),
                }
            )

        if status != manifest.get("status"):
            new_events.append(
                {
                    "type": f"session_{status}",
                    "actor": "system",
                    "data": {"previous_status": manifest.get("status")},
                }
            )
        self.append_events(
            space=space,
            project=project,
            session_id=session_id,
            events=new_events,
            manifest_updates={"status": status},
        )
        return self.refresh_compact(session_id)

    def load_langchain_messages(self, session_id: str) -> list[BaseMessage]:
        serialized = [
            event["message"]
            for event in self.read_events(session_id)
            if isinstance(event.get("message"), dict)
        ]
        return messages_from_dict(serialized)

    def set_status(
        self,
        session_id: str,
        status: str,
        *,
        error: str | None = None,
        refresh_compact: bool = True,
    ) -> dict[str, Any]:
        manifest = self.load_manifest(session_id)
        if manifest.get("status") == status and error is None:
            return manifest
        event_type = status if status.startswith("session_") else f"session_{status}"
        self.append_events(
            space=manifest["space"],
            project=manifest["project"],
            session_id=session_id,
            events=[
                {
                    "type": event_type,
                    "actor": "system",
                    "content": error,
                    "data": {"previous_status": manifest.get("status")},
                }
            ],
            manifest_updates={"status": status.removeprefix("session_"), "error": error},
        )
        if refresh_compact:
            self.refresh_compact(session_id)
        return self.load_manifest(session_id)

    def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        normalized = " ".join(str(title).split())
        if not normalized:
            raise ValueError("title cannot be empty")
        return self.update_manifest(session_id, title=normalized[:120])

    def move_session(self, session_id: str, target_project: str) -> dict[str, Any]:
        target_project = validate_name(target_project, "project")
        with self._lock:
            manifest = self.load_manifest(session_id)
            source_project = str(manifest["project"])
            if source_project == target_project:
                return manifest

            state_path = memory_state_path(self.memory_root, manifest["space"])
            source_state = get_session_source(
                manifest["space"],
                source_project,
                session_id,
                path=state_path,
            )
            if source_state and source_state.get("consolidated_hash"):
                raise ValueError(
                    "thread has already been consolidated into its current project"
                )

            source_directory = session_directory(
                self.memory_root,
                manifest["space"],
                source_project,
                session_id,
            )
            target_directory = session_directory(
                self.memory_root,
                manifest["space"],
                target_project,
                session_id,
            )
            if target_directory.exists():
                raise ValueError(f"target session already exists: {target_directory}")

            events = self.read_events(session_id)
            moved_at = _now_iso()
            for event in events:
                event["project"] = target_project
            next_seq = int(manifest.get("last_event_seq", 0)) + 1
            events.append(
                {
                    "schema_version": EVENT_SCHEMA_VERSION,
                    "id": f"evt_{uuid.uuid4().hex}",
                    "seq": next_seq,
                    "session_id": session_id,
                    "space": manifest["space"],
                    "project": target_project,
                    "type": "session_project_moved",
                    "actor": "system",
                    "created_at": moved_at,
                    "data": {
                        "previous_project": source_project,
                        "project": target_project,
                    },
                }
            )

            target_directory.parent.mkdir(parents=True, exist_ok=True)
            source_directory.replace(target_directory)
            manifest["project"] = target_project
            manifest["last_event_seq"] = next_seq
            manifest["updated_at"] = moved_at
            target_manifest = manifest_path(
                self.memory_root,
                manifest["space"],
                target_project,
                session_id,
            )
            _atomic_write_jsonl(
                events_path(
                    self.memory_root,
                    manifest["space"],
                    target_project,
                    session_id,
                ),
                events,
            )
            _atomic_write_json(target_manifest, manifest)
            self._upsert_index(manifest, target_manifest)

            discard_session_source(
                manifest["space"],
                source_project,
                session_id,
                path=state_path,
            )
            delete_conversation_chunks(
                space=manifest["space"],
                project=source_project,
                session_id=session_id,
                path=memory_database_path(self.memory_root, manifest["space"]),
            )
            self.refresh_compact(session_id)
            return self.load_manifest(session_id)

    def refresh_compact(self, session_id: str) -> dict[str, Any]:
        manifest = self.load_manifest(session_id)
        events = self.read_events(session_id)
        source_hash = event_content_hash(events)
        source_state = touch_session_source(
            space=manifest["space"],
            project=manifest["project"],
            session_id=session_id,
            source_hash=source_hash,
            last_event_seq=int(manifest.get("last_event_seq", 0)),
            path=memory_state_path(self.memory_root, manifest["space"]),
        )
        _, payload = write_compact_events(
            memory_root=self.memory_root,
            space=manifest["space"],
            project=manifest["project"],
            session_id=session_id,
            events=events,
            source_version=int(source_state["source_version"]),
        )
        replace_conversation_chunks(
            payload,
            path=memory_database_path(self.memory_root, manifest["space"]),
        )
        self.update_manifest(
            session_id,
            last_compacted_seq=int(manifest.get("last_event_seq", 0)),
            source_hash=source_hash,
            source_version=int(source_state["source_version"]),
        )
        return payload

    def find_by_native_session(
        self,
        *,
        provider: str,
        native_session_id: str,
        space: str = "productivity",
    ) -> dict[str, Any] | None:
        self._ensure_index()
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT manifest_path FROM sessions
                WHERE provider = ? AND native_session_id = ? AND space = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (provider, native_session_id, validate_space(space)),
            ).fetchone()
        if row is None:
            return None
        return json.loads(Path(row["manifest_path"]).read_text(encoding="utf-8-sig"))

    def list_sessions(
        self,
        *,
        space: str | None = None,
        project: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[str] = []
        if space is not None:
            clauses.append("space = ?")
            values.append(validate_space(space))
        if project is not None:
            clauses.append("project = ?")
            values.append(validate_name(project, "project"))
        if status is not None:
            clauses.append("status = ?")
            values.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT * FROM sessions {where} ORDER BY updated_at DESC",
                values,
            ).fetchall()
        return [dict(row) for row in rows]

    def rebuild_index(self) -> int:
        manifests: list[tuple[dict[str, Any], Path]] = []
        for space in MEMORY_SPACES:
            pattern = f"{space}/projects/*/sessions/*/manifest.json"
            for path in self.memory_root.glob(pattern):
                try:
                    manifest = json.loads(path.read_text(encoding="utf-8-sig"))
                    self._validate_manifest(manifest)
                except (OSError, json.JSONDecodeError, ValueError):
                    continue
                manifests.append((manifest, path))
        with self._lock:
            self._ensure_index()
            with closing(sqlite3.connect(self.index_path)) as conn, conn:
                conn.execute("DELETE FROM sessions")
            for manifest, path in manifests:
                self._upsert_index(manifest, path)
        return len(manifests)

    def _ensure_index(self) -> None:
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
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

    def _upsert_index(self, manifest: dict[str, Any], path: Path) -> None:
        self._ensure_index()
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
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
                    str(path),
                    int(manifest.get("last_event_seq", 0)),
                    manifest["created_at"],
                    manifest["updated_at"],
                ),
            )

    def _session_index_row(self, session_id: str) -> sqlite3.Row | None:
        self._ensure_index()
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            return conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()

    @staticmethod
    def _validate_manifest(manifest: dict[str, Any]) -> None:
        if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
            raise ValueError("session manifest schema is not supported")
        validate_space(str(manifest.get("space") or ""))
        validate_name(str(manifest.get("project") or ""), "project")
        validate_name(str(manifest.get("id") or ""), "session_id")
        validate_name(str(manifest.get("provider") or ""), "provider")
        validate_name(str(manifest.get("owner_type") or ""), "owner_type")

    def session_directory(self, session_id: str) -> Path:
        manifest = self.load_manifest(session_id)
        return session_directory(
            self.memory_root,
            manifest["space"],
            manifest["project"],
            session_id,
        )
