from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from core.integrations.agent_adapter.acp import AcpAgentSpec, AcpProvider
from core.integrations.agent_adapter.models import (
    AgentResult,
    AgentSession,
    EventCallback,
)
from core.integrations.agent_adapter.provider import AgentProvider
from core.memory.session_store import SessionStore


@dataclass(slots=True)
class _SessionRoute:
    provider: AgentProvider
    provider_session_id: str
    project_path: str
    native_session_id: str | None
    project: str


class AgentAdapter:
    """Single entry point for native ACP agents and SDK-backed harnesses."""

    def __init__(
        self,
        project_root: str | Path,
        *,
        session_store: SessionStore | None = None,
        space: str = "productivity",
        owner_type: str = "agent",
    ) -> None:
        self._project_root = Path(project_root).expanduser().resolve()
        if not self._project_root.is_dir():
            raise ValueError(f"Project root does not exist: {self._project_root}")
        self._providers: dict[str, AgentProvider] = {}
        self._sessions: dict[str, _SessionRoute] = {}
        self._store = session_store or SessionStore(self._project_root / "memory")
        self._space = space
        self._owner_type = owner_type

    @property
    def providers(self) -> tuple[str, ...]:
        return tuple(self._providers)

    def register(self, provider: AgentProvider) -> None:
        if provider.name in self._providers:
            raise ValueError(f"Provider already registered: {provider.name}")
        self._providers[provider.name] = provider

    def register_acp(self, name: str, spec: AcpAgentSpec) -> None:
        self.register(AcpProvider(name=name, spec=spec))

    async def create_session(
        self,
        provider: str,
        project_path: str = ".",
        model: str | None = None,
        project: str | None = None,
    ) -> AgentSession:
        implementation = self._provider(provider)
        resolved_path = self._project_directory(project_path)
        session = await implementation.create_session(resolved_path, model)
        return self._add_route(
            implementation,
            session.id,
            resolved_path,
            session.native_id,
            project=project,
        )

    async def resume_session(
        self,
        provider: str,
        native_session_id: str,
        project_path: str = ".",
        model: str | None = None,
        project: str | None = None,
    ) -> AgentSession:
        implementation = self._provider(provider)
        resolved_path = self._project_directory(project_path)
        session = await implementation.resume_session(
            self._required_text(native_session_id, "native_session_id"),
            resolved_path,
            model,
        )
        stored = self._store.find_by_native_session(
            provider=provider,
            native_session_id=native_session_id,
            space=self._space,
        )
        return self._add_route(
            implementation,
            session.id,
            resolved_path,
            session.native_id,
            project=project or (stored or {}).get("project"),
            handle=(stored or {}).get("id"),
        )

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is None:
            raise KeyError(f"Unknown agent session: {session_id}")

        prompt = self._required_text(prompt, "prompt")
        self._store.append_events(
            space=self._space,
            project=route.project,
            session_id=session_id,
            events=[
                {"type": "user_message", "actor": "agent", "content": prompt},
                {"type": "session_running", "actor": "system"},
            ],
            manifest_updates={"status": "running"},
        )
        try:
            turn = await route.provider.prompt(
                route.provider_session_id,
                prompt,
                on_event,
            )
        except Exception as exc:
            self._store.set_status(session_id, "failed", error=str(exc))
            raise
        route.native_session_id = turn.native_session_id
        stored_events = [
            translated
            for event in turn.events
            if (translated := self._stored_provider_event(event)) is not None
        ]
        if turn.response:
            stored_events.append(
                {
                    "type": "assistant_message",
                    "actor": route.provider.name,
                    "content": turn.response,
                }
            )
        stored_events.append(
            {
                "type": f"session_{turn.status}",
                "actor": "system",
                "content": turn.error,
            }
        )
        self._store.append_events(
            space=self._space,
            project=route.project,
            session_id=session_id,
            events=stored_events,
            manifest_updates={
                "status": turn.status,
                "native_session_id": turn.native_session_id,
                "error": turn.error,
            },
        )
        self._store.refresh_compact(session_id)
        return AgentResult(
            session_id=session_id,
            provider=route.provider.name,
            native_session_id=turn.native_session_id,
            turn_id=turn.turn_id,
            status=turn.status,
            response=turn.response,
            error=turn.error,
            events=list(turn.events),
            space=self._space,
            project=route.project,
        )

    async def run(
        self,
        provider: str,
        prompt: str,
        project_path: str = ".",
        model: str | None = None,
        on_event: EventCallback | None = None,
        project: str | None = None,
    ) -> AgentResult:
        session = await self.create_session(provider, project_path, model, project)
        return await self.prompt(session.id, prompt, on_event)

    async def cancel(self, session_id: str) -> None:
        route = self._route(session_id)
        await route.provider.cancel(route.provider_session_id)
        self._store.set_status(session_id, "cancelled")

    async def close(self, session_id: str) -> None:
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is not None:
            await route.provider.close(route.provider_session_id)
            manifest = self._store.load_manifest(session_id)
            if manifest["status"] not in {"completed", "failed", "cancelled"}:
                self._store.set_status(session_id, "closed")
            self._sessions.pop(session_id, None)

    async def aclose(self) -> None:
        for session_id in tuple(self._sessions):
            await self.close(session_id)

    async def __aenter__(self) -> AgentAdapter:
        return self

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        await self.aclose()

    def _add_route(
        self,
        provider: AgentProvider,
        provider_session_id: str,
        project_path: str,
        native_session_id: str | None,
        *,
        project: str | None = None,
        handle: str | None = None,
    ) -> AgentSession:
        handle = handle or f"agent_{secrets.token_hex(6)}"
        project = project or Path(project_path).name
        self._sessions[handle] = _SessionRoute(
            provider=provider,
            provider_session_id=provider_session_id,
            project_path=project_path,
            native_session_id=native_session_id,
            project=project,
        )
        try:
            self._store.load_manifest(handle)
        except FileNotFoundError:
            self._store.create_session(
                session_id=handle,
                space=self._space,
                project=project,
                provider=provider.name,
                owner_type=self._owner_type,
                native_session_id=native_session_id,
                cwd=project_path,
            )
        else:
            self._store.update_manifest(
                handle,
                native_session_id=native_session_id,
                status="active",
                cwd=project_path,
            )
        return AgentSession(
            id=handle,
            provider=provider.name,
            project_path=project_path,
            native_session_id=native_session_id,
            space=self._space,
            project=project,
        )

    @staticmethod
    def _stored_provider_event(event) -> dict[str, Any] | None:
        event_type = event.type
        if event_type in {
            "agent_message",
            "agent_message_chunk",
            "assistant_message_chunk",
            "thought",
        }:
            return None
        canonical_type = {
            "tool_call_update": "tool_result",
            "plan": "plan_update",
        }.get(event_type, event_type)
        known_types = {
            "tool_call",
            "tool_result",
            "permission_request",
            "permission_response",
            "file_change",
            "terminal_output",
            "plan_update",
            "status",
            "error",
        }
        if canonical_type not in known_types:
            canonical_type = "provider_event"
        return {
            "type": canonical_type,
            "actor": event.provider,
            "content": event.text,
            "data": {
                "provider": event.provider,
                "schema_version": event.data.get("schema_version", 1),
                "provider_event_type": event.data.get(
                    "provider_event_type", event.type
                ),
                "payload": event.data.get("payload", event.data),
            },
        }

    def _provider(self, name: str) -> AgentProvider:
        name = self._required_text(name, "provider")
        provider = self._providers.get(name)
        if provider is None:
            raise KeyError(f"Unknown agent provider: {name}")
        return provider

    def _route(self, session_id: str) -> _SessionRoute:
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is None:
            raise KeyError(f"Unknown agent session: {session_id}")
        return route

    @staticmethod
    def _required_text(value: str, field_name: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError(f"{field_name} cannot be empty")
        return value

    def _project_directory(self, project_path: str) -> str:
        expanded = os.path.expanduser(self._required_text(project_path, "project_path"))
        drive, _ = os.path.splitdrive(expanded)
        if os.name == "nt" and expanded.startswith(("/", "\\")) and not drive:
            path = self._project_root / expanded.lstrip("/\\")
        else:
            path = Path(expanded)
            if not path.is_absolute():
                path = self._project_root / path

        path = path.resolve()
        if not path.is_dir():
            raise ValueError(f"Project directory does not exist: {path}")
        return os.path.normcase(str(path))
