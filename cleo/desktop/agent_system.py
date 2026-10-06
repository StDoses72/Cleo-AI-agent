"""The agent system a session runs its turns through (multi-agent milestone M0).

A session is bound to an *agent system* rather than to one agent. Until M1 the only system
is ``SingleAgentSystem``: one member per session, chosen by the session's space, which is
exactly the behaviour before this interface existed. ``RouterAgentSystem`` (a main agent
that delegates to member harnesses) will implement the same ``AgentSystem`` protocol.

Members run through an ``AgentRuntime``: the built-in LangGraph chat agent for chat
sessions, or the selected harness (Codex, Claude, ACP) for development tasks.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

Emit = Callable[[dict[str, Any]], Awaitable[None]]

SINGLE = "single"


@dataclass(frozen=True, slots=True)
class TurnInput:
    """One user turn as handed to the agent system."""

    manifest: dict[str, Any]
    prompt: str
    attachments: list[dict[str, Any]] = field(default_factory=list)
    # Boundary steers folded into this turn, and the text the timeline shows instead of
    # internal instructions.
    steer_ids: list[str] | None = None
    display_prompt: str | None = None


class AgentRuntime(Protocol):
    """How one member executes a turn and reports it through ``emit``."""

    async def stream(self, turn: TurnInput, emit: Emit) -> None: ...


class AgentSystem(Protocol):
    async def run_turn(self, turn: TurnInput, emit: Emit) -> None: ...


def agent_system_spec(manifest: dict[str, Any]) -> dict[str, Any]:
    """Purpose: The agent system a session is bound to.

    Input: A session manifest. Output: Its ``agent_system`` spec; manifests written before
    multi-agent support have none and mean ``{"mode": "single"}``. The top-level
    ``provider`` and ``native_session_id`` always describe the main agent, so a version
    that only knows ``single`` can still run any session through its main agent.
    """
    spec = manifest.get("agent_system")
    return dict(spec) if isinstance(spec, dict) and spec.get("mode") else {"mode": SINGLE}


class SingleAgentSystem:
    """One member per session: the chat agent or the session's harness."""

    def __init__(self, runtimes: Mapping[str, AgentRuntime]) -> None:
        self._runtimes = runtimes

    async def run_turn(self, turn: TurnInput, emit: Emit) -> None:
        await self._runtimes[turn.manifest["space"]].stream(turn, emit)


class CallableRuntime:
    """Adapt a ``stream(manifest, prompt, attachments, emit, **options)`` coroutine."""

    def __init__(self, stream: Callable[..., Awaitable[None]]) -> None:
        self._stream = stream

    async def stream(self, turn: TurnInput, emit: Emit) -> None:
        options: dict[str, Any] = {}
        if turn.display_prompt:
            options["display_prompt"] = turn.display_prompt
        if turn.steer_ids:
            options["steer_ids"] = turn.steer_ids
        await self._stream(turn.manifest, turn.prompt, turn.attachments, emit, **options)
