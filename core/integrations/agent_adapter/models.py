from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AgentEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: str
    type: str
    text: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class AgentSession(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    provider: str
    project_path: str
    native_session_id: str | None = None


class AgentResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    session_id: str
    provider: str
    native_session_id: str | None = None
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None
    events: list[AgentEvent] = Field(default_factory=list)


EventCallback = Callable[[AgentEvent], Awaitable[None] | None]


async def emit_event(callback: EventCallback | None, event: AgentEvent) -> None:
    if callback is None:
        return
    result = callback(event)
    if inspect.isawaitable(result):
        await result
