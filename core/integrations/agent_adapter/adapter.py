from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from core.integrations.agent_adapter.acp import AcpAgentSpec, AcpProvider
from core.integrations.agent_adapter.models import (
    AgentResult,
    AgentSession,
    EventCallback,
)
from core.integrations.agent_adapter.provider import AgentProvider


@dataclass(slots=True)
class _SessionRoute:
    provider: AgentProvider
    provider_session_id: str
    project_path: str
    native_session_id: str | None


class AgentAdapter:
    """Single entry point for native ACP agents and SDK-backed harnesses."""

    def __init__(self, project_root: str | Path) -> None:
        self._project_root = Path(project_root).expanduser().resolve()
        if not self._project_root.is_dir():
            raise ValueError(f"Project root does not exist: {self._project_root}")
        self._providers: dict[str, AgentProvider] = {}
        self._sessions: dict[str, _SessionRoute] = {}

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
    ) -> AgentSession:
        implementation = self._provider(provider)
        resolved_path = self._project_directory(project_path)
        session = await implementation.create_session(resolved_path, model)
        return self._add_route(implementation, session.id, resolved_path, session.native_id)

    async def resume_session(
        self,
        provider: str,
        native_session_id: str,
        project_path: str = ".",
        model: str | None = None,
    ) -> AgentSession:
        implementation = self._provider(provider)
        resolved_path = self._project_directory(project_path)
        session = await implementation.resume_session(
            self._required_text(native_session_id, "native_session_id"),
            resolved_path,
            model,
        )
        return self._add_route(implementation, session.id, resolved_path, session.native_id)

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

        turn = await route.provider.prompt(
            route.provider_session_id,
            self._required_text(prompt, "prompt"),
            on_event,
        )
        route.native_session_id = turn.native_session_id
        return AgentResult(
            session_id=session_id,
            provider=route.provider.name,
            native_session_id=turn.native_session_id,
            turn_id=turn.turn_id,
            status=turn.status,
            response=turn.response,
            error=turn.error,
            events=list(turn.events),
        )

    async def run(
        self,
        provider: str,
        prompt: str,
        project_path: str = ".",
        model: str | None = None,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        session = await self.create_session(provider, project_path, model)
        return await self.prompt(session.id, prompt, on_event)

    async def cancel(self, session_id: str) -> None:
        route = self._route(session_id)
        await route.provider.cancel(route.provider_session_id)

    async def close(self, session_id: str) -> None:
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is not None:
            await route.provider.close(route.provider_session_id)
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
    ) -> AgentSession:
        handle = f"agent_{secrets.token_hex(6)}"
        self._sessions[handle] = _SessionRoute(
            provider=provider,
            provider_session_id=provider_session_id,
            project_path=project_path,
            native_session_id=native_session_id,
        )
        return AgentSession(
            id=handle,
            provider=provider.name,
            project_path=project_path,
            native_session_id=native_session_id,
        )

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
