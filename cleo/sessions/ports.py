"""Persistence contracts owned by the session use cases, independent of storage."""

from __future__ import annotations

from typing import Any, Protocol


class SessionRepository(Protocol):
    """The persistence operations required by harness orchestration.

    Manifests and events retain Cleo's existing dictionaries and schema. Missing
    manifests raise FileNotFoundError; writes must preserve event order, identity,
    and scope. Implementations own indexing and compact projections.
    """

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
    ) -> dict[str, Any]: ...

    def load_manifest(self, session_id: str) -> dict[str, Any]: ...

    def update_manifest(self, session_id: str, **changes: Any) -> dict[str, Any]: ...

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
    ) -> dict[str, Any]: ...

    def append_events(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
        events: list[dict[str, Any]],
        manifest_updates: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]: ...

    def set_status(
        self,
        session_id: str,
        status: str,
        *,
        error: str | None = None,
        refresh_compact: bool = True,
    ) -> dict[str, Any]: ...

    def refresh_compact(self, session_id: str) -> dict[str, Any]: ...

    def find_by_native_session(
        self, *, provider: str, native_session_id: str, space: str = "productivity"
    ) -> dict[str, Any] | None: ...
