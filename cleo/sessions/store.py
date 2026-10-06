"""Persistent session manifests, append-only events, and the global session index.

``SessionStore`` is the facade the rest of Cleo uses (it implements
``cleo.sessions.ports.SessionRepository``). The storage itself lives in:

- ``manifests.JsonManifestRepository``: one ``manifest.json`` per session;
- ``event_log.JsonlEventStore``: the append-only ``events.jsonl``;
- ``index.SqliteSessionIndex``: ``sessions.sqlite3``, rebuildable from the manifests;
- ``compact.CompactProjection``: ``compact.json``, memory source state and chunks;
- ``messages``: LangChain history <-> events, and automatic titles.

The facade owns the rules that span them: event/manifest ordering and fsync, identity
checks, and when projections are refreshed.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from threading import RLock
from typing import Any

from langchain_core.messages import BaseMessage

from cleo.memory.paths import session_directory, validate_name, validate_space
from cleo.sessions.compact import CompactProjection
from cleo.sessions.event_log import (
    EVENT_SCHEMA_VERSION,
    JsonlEventStore,
    is_durable_handoff,
    new_event_id,
    now_iso,
)
from cleo.sessions.files import fsync_directory, fsync_file
from cleo.sessions.index import SqliteSessionIndex
from cleo.sessions.manifests import MANIFEST_SCHEMA_VERSION, JsonManifestRepository
from cleo.sessions.messages import history_from_events, message_events, title_from_events

__all__ = ["EVENT_SCHEMA_VERSION", "MANIFEST_SCHEMA_VERSION", "SessionStore"]


class SessionStore:
    """File-first session storage with a rebuildable global SQLite registry."""

    def __init__(self, memory_root: Path | str, index_path: Path | str | None = None) -> None:
        """Purpose: Open the storage under ``memory_root`` and make sure the index exists.

        Input: The memory root (``settings.MEMORY_DIR``) and an optional index path, by
        default ``memory_root/sessions.sqlite3``.
        """
        self.memory_root = Path(memory_root).expanduser().resolve()
        self.index_path = (
            Path(index_path).expanduser().resolve()
            if index_path is not None
            else self.memory_root / "sessions.sqlite3"
        )
        self._lock = RLock()
        self._manifests = JsonManifestRepository(self.memory_root)
        self._events = JsonlEventStore(self.memory_root)
        self._index = SqliteSessionIndex(self.index_path, self._lock)
        self._compact = CompactProjection(self.memory_root)
        self._index.ensure()

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
        """Purpose: Create a session: manifest, index row and a ``session_created`` event.

        Output: The new manifest. Raises ValueError when the session already exists.
        """
        space = validate_space(space)
        project = validate_name(project, "project")
        session_id = validate_name(session_id, "session_id")
        provider = validate_name(provider, "provider")
        owner_type = validate_name(owner_type, "owner_type")
        path = self._manifests.path(space, project, session_id)
        with self._lock:
            if path.exists() or self._index.row(session_id) is not None:
                raise ValueError(f"session already exists: {session_id}")
            now = now_iso()
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
            self._manifests.write(path, manifest)
            self._index.upsert(manifest, path)
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
        """Purpose: Return the manifest, creating the session with ``kwargs`` if missing."""
        session_id = validate_name(str(kwargs["session_id"]), "session_id")
        try:
            return self.load_manifest(session_id)
        except FileNotFoundError:
            return self.create_session(**kwargs)

    def load_manifest(self, session_id: str) -> dict[str, Any]:
        """Purpose: Load and validate a manifest, rebuilding the index once if it is missing.

        Output: The manifest. Raises FileNotFoundError for unknown or unreadable sessions.
        """
        session_id = validate_name(session_id, "session_id")
        with self._lock:
            row = self._index.row(session_id)
            if row is None:
                self.rebuild_index()
                row = self._index.row(session_id)
            if row is None:
                raise FileNotFoundError(session_id)
            return self._manifests.read(Path(row["manifest_path"]), session_id)

    def update_manifest(self, session_id: str, **changes: Any) -> dict[str, Any]:
        """Purpose: Merge ``changes`` into the manifest; identity fields are protected."""
        with self._lock:
            manifest = self.load_manifest(session_id)
            protected = {"schema_version", "id", "space", "project", "created_at"}
            if protected & changes.keys():
                raise ValueError("session identity fields cannot be updated")
            manifest.update(changes)
            manifest["updated_at"] = now_iso()
            path = self._manifests.path(manifest["space"], manifest["project"], manifest["id"])
            self._manifests.write(path, manifest)
            self._index.upsert(manifest, path)
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
        """Purpose: Append one event (see ``append_events``). Output: The written event."""
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
        """Purpose: Append events idempotently by id, then update the manifest and index.

        Input: The session scope (must match the manifest), event requests (``type`` and
        ``actor`` required) and optional manifest fields to merge. Output: The events
        actually written; the first user message also titles an untitled session. Handoff
        and steer events are fsynced; handoffs also fsync the manifest.
        """
        space = validate_space(space)
        project = validate_name(project, "project")
        session_id = validate_name(session_id, "session_id")
        if not events:
            return []
        with self._lock:
            manifest = self.load_manifest(session_id)
            if (manifest["space"], manifest["project"]) != (space, project):
                raise ValueError("session event binding does not match its manifest")
            output_path = self._events.path(space, project, session_id)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            known_ids, last_written_seq = self._events.committed(session_id, output_path)
            # The event log may be ahead of a manifest whose atomic write failed.
            appended, next_seq = self._events.prepare(
                events, session_id=session_id, space=space, project=project,
                known_ids=known_ids,
                last_seq=max(int(manifest.get("last_event_seq", 0)), last_written_seq),
            )
            durable_handoff = bool(appended) and is_durable_handoff(appended)
            if appended:
                self._events.append(
                    session_id, output_path, appended, known_ids=known_ids, last_seq=next_seq,
                    fsync=durable_handoff or any(e["type"] == "steer" for e in appended),
                )
                if not manifest.get("title"):
                    title = title_from_events(appended)
                    if title:
                        manifest["title"] = title
            manifest["last_event_seq"] = next_seq
            if manifest_updates:
                manifest.update(manifest_updates)
            manifest["updated_at"] = now_iso()
            manifest_file = self._manifests.path(space, project, session_id)
            self._manifests.write(manifest_file, manifest)
            if durable_handoff:
                fsync_file(manifest_file)
                fsync_directory(manifest_file.parent)
            self._index.upsert(manifest, manifest_file)
            return appended

    def read_events(self, session_id: str) -> list[dict[str, Any]]:
        """Purpose: All events of a session (empty when the log does not exist yet)."""
        manifest = self.load_manifest(session_id)
        return self._events.read(
            self._events.path(manifest["space"], manifest["project"], session_id)
        )

    def read_event_prefix(self, session_id: str, through_seq: int) -> list[dict[str, Any]]:
        """Read a frozen prefix without parsing a concurrently appended, possibly partial tail."""
        manifest = self.load_manifest(session_id)
        return self._events.read_prefix(
            self._events.path(manifest["space"], manifest["project"], session_id), through_seq,
        )

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
        """Purpose: Record a LangChain history as events, idempotent by message id.

        Input: Session scope, the full history, creation metadata and the target status
        (a change appends a ``session_<status>`` event). Output: The compact payload.
        """
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
        new_events = message_events(messages, existing_source_ids)
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
        """Purpose: Rebuild the LangChain history from the events, skipping rewound turns."""
        return history_from_events(self.read_events(session_id))

    def set_status(
        self,
        session_id: str,
        status: str,
        *,
        error: str | None = None,
        refresh_compact: bool = True,
    ) -> dict[str, Any]:
        """Purpose: Change the status with a ``session_<status>`` event.

        Input: Status (an optional ``session_`` prefix is dropped), an optional error and
        whether to refresh the compact projection. Output: The updated manifest.
        """
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
        """Purpose: Rename a session (whitespace collapsed, at most 120 characters)."""
        normalized = " ".join(str(title).split())
        if not normalized:
            raise ValueError("title cannot be empty")
        return self.update_manifest(session_id, title=normalized[:120])

    def delete_session(self, session_id: str) -> dict[str, Any]:
        """Permanently delete one local session and its derived conversation state."""
        session_id = validate_name(session_id, "session_id")
        with self._lock:
            manifest = self.load_manifest(session_id)
            space = str(manifest["space"])
            project = str(manifest["project"])
            directory = session_directory(self.memory_root, space, project, session_id)
            self._compact.discard(space, project, session_id)
            shutil.rmtree(directory)
            self._index.delete(session_id)
            self._events.forget(session_id)
            return manifest

    def move_session(self, session_id: str, target_project: str) -> dict[str, Any]:
        """Purpose: Move a session to another project of the same space.

        Rewrites every event's ``project``, appends ``session_project_moved``, drops the
        source project's memory state and chunks, and refreshes the compact projection. A
        session already consolidated into its project cannot move (ValueError).
        """
        target_project = validate_name(target_project, "project")
        with self._lock:
            manifest = self.load_manifest(session_id)
            space = manifest["space"]
            source_project = str(manifest["project"])
            if source_project == target_project:
                return manifest
            if self._compact.is_consolidated(space, source_project, session_id):
                raise ValueError(
                    "thread has already been consolidated into its current project"
                )

            source_directory = session_directory(
                self.memory_root, space, source_project, session_id,
            )
            target_directory = session_directory(
                self.memory_root, space, target_project, session_id,
            )
            if target_directory.exists():
                raise ValueError(f"target session already exists: {target_directory}")

            events = self.read_events(session_id)
            moved_at = now_iso()
            for event in events:
                event["project"] = target_project
            last_written_seq = int(events[-1]["seq"]) if events else 0
            next_seq = max(int(manifest.get("last_event_seq", 0)), last_written_seq) + 1
            events.append(
                {
                    "schema_version": EVENT_SCHEMA_VERSION,
                    "id": new_event_id(),
                    "seq": next_seq,
                    "session_id": session_id,
                    "space": space,
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
            self._events.forget(session_id)
            manifest["project"] = target_project
            manifest["last_event_seq"] = next_seq
            manifest["updated_at"] = moved_at
            target_manifest = self._manifests.path(space, target_project, session_id)
            self._events.rewrite(self._events.path(space, target_project, session_id), events)
            self._manifests.write(target_manifest, manifest)
            self._index.upsert(manifest, target_manifest)
            self._compact.discard(space, source_project, session_id)
            self.refresh_compact(session_id)
            return self.load_manifest(session_id)

    def refresh_compact(self, session_id: str) -> dict[str, Any]:
        """Purpose: Rebuild the compact projection and record its hash in the manifest.

        Output: The compact payload (also written as conversation chunks).
        """
        with self._lock:
            manifest = self.load_manifest(session_id)
            refreshed = self._compact.refresh(manifest, self.read_events(session_id))
            self.update_manifest(session_id, **refreshed["manifest"])
            return refreshed["payload"]

    def find_by_native_session(
        self,
        *,
        provider: str,
        native_session_id: str,
        space: str = "productivity",
    ) -> dict[str, Any] | None:
        path = self._index.native_manifest_path(
            provider=provider, native_session_id=native_session_id, space=validate_space(space),
        )
        return None if path is None else self._manifests.read_raw(Path(path))

    def list_sessions(
        self,
        *,
        space: str | None = None,
        project: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        return self._index.rows(
            space=validate_space(space) if space is not None else None,
            project=validate_name(project, "project") if project is not None else None,
            status=status,
        )

    def rebuild_index(self) -> int:
        manifests = self._manifests.scan()
        with self._lock:
            self._index.ensure()
            self._index.clear()
            for manifest, path in manifests:
                self._index.upsert(manifest, path)
        return len(manifests)
