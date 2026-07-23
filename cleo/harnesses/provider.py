from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from cleo.harnesses.models import AgentEvent, EventCallback


@dataclass(frozen=True, slots=True)
class ProviderSession:
    id: str
    native_id: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderTurn:
    native_session_id: str | None
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None
    events: tuple[AgentEvent, ...] = ()


class AgentProvider(Protocol):
    name: str

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession: ...

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession: ...

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn: ...

    async def cancel(self, session_id: str) -> None: ...

    async def close(self, session_id: str) -> None: ...
