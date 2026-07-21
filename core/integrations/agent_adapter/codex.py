from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from openai_codex import ApprovalMode, AsyncCodex, AsyncThread, AsyncTurnHandle, Sandbox

from core.integrations.agent_adapter.models import AgentEvent, EventCallback, emit_event
from core.integrations.agent_adapter.provider import ProviderSession, ProviderTurn


@dataclass(slots=True)
class _CodexRuntime:
    client: AsyncCodex
    thread: AsyncThread
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active_turn: AsyncTurnHandle | None = None


class CodexProvider:
    name = "codex"

    def __init__(self, default_model: str) -> None:
        self._default_model = default_model
        self._sessions: dict[str, _CodexRuntime] = {}

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        client = AsyncCodex()
        await client.__aenter__()
        try:
            thread = await client.thread_start(
                approval_mode=ApprovalMode.deny_all,
                cwd=project_path,
                model=model or self._default_model,
                sandbox=Sandbox.workspace_write,
            )
        except Exception:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(client, thread)
        return ProviderSession(id=thread.id, native_id=thread.id)

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        client = AsyncCodex()
        await client.__aenter__()
        try:
            thread = await client.thread_resume(
                native_session_id,
                approval_mode=ApprovalMode.deny_all,
                cwd=project_path,
                model=model or self._default_model,
                sandbox=Sandbox.workspace_write,
            )
        except Exception:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(client, thread)
        return ProviderSession(id=thread.id, native_id=thread.id)

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        runtime = self._sessions[session_id]
        async with runtime.lock:
            turn = await runtime.thread.turn(
                prompt,
                approval_mode=ApprovalMode.deny_all,
                sandbox=Sandbox.workspace_write,
            )
            runtime.active_turn = turn
            try:
                result = await turn.run()
            finally:
                runtime.active_turn = None

        events: tuple[AgentEvent, ...] = ()
        if result.final_response:
            event = AgentEvent(
                provider=self.name,
                type="agent_message",
                text=result.final_response,
            )
            events = (event,)
            await emit_event(on_event, event)
        return ProviderTurn(
            native_session_id=runtime.thread.id,
            turn_id=result.id,
            status=result.status.value,
            response=result.final_response,
            error=result.error.message if result.error is not None else None,
            events=events,
        )

    async def cancel(self, session_id: str) -> None:
        runtime = self._sessions[session_id]
        if runtime.active_turn is not None:
            await runtime.active_turn.interrupt()

    async def close(self, session_id: str) -> None:
        runtime = self._sessions.pop(session_id, None)
        if runtime is None:
            return
        if runtime.active_turn is not None:
            await runtime.active_turn.interrupt()
        await runtime.client.close()
