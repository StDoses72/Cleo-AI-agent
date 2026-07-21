from __future__ import annotations

import asyncio
import secrets
from dataclasses import asdict, dataclass, field
from typing import Literal

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
)

from core.integrations.agent_adapter.models import AgentEvent, EventCallback, emit_event
from core.integrations.agent_adapter.provider import ProviderSession, ProviderTurn

ClaudePermissionMode = Literal[
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
    "auto",
]


@dataclass(slots=True)
class _ClaudeRuntime:
    client: ClaudeSDKClient
    native_session_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: bool = False


class ClaudeProvider:
    name = "claude"

    def __init__(
        self,
        default_model: str | None = None,
        permission_mode: ClaudePermissionMode = "acceptEdits",
    ) -> None:
        self._default_model = default_model
        self._permission_mode = permission_mode
        self._sessions: dict[str, _ClaudeRuntime] = {}

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        session_id = f"claude_{secrets.token_hex(6)}"
        self._sessions[session_id] = await self._connect(project_path, model)
        return ProviderSession(id=session_id)

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        runtime = await self._connect(project_path, model, resume=native_session_id)
        runtime.native_session_id = native_session_id
        session_id = f"claude_{secrets.token_hex(6)}"
        self._sessions[session_id] = runtime
        return ProviderSession(id=session_id, native_id=native_session_id)

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        runtime = self._sessions[session_id]
        events: list[AgentEvent] = []
        response_parts: list[str] = []
        result_message: ResultMessage | None = None

        async with runtime.lock:
            runtime.active = True
            try:
                await runtime.client.query(prompt)
                async for message in runtime.client.receive_response():
                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            event = self._block_event(block)
                            if event is None:
                                continue
                            events.append(event)
                            if event.type == "agent_message" and event.text:
                                response_parts.append(event.text)
                            await emit_event(on_event, event)
                    elif isinstance(message, ResultMessage):
                        result_message = message
                        runtime.native_session_id = message.session_id
            finally:
                runtime.active = False

        if result_message is None:
            raise RuntimeError("Claude Agent SDK did not return a ResultMessage")
        response = result_message.result or "".join(response_parts) or None
        error = None
        if result_message.is_error:
            error = "; ".join(result_message.errors or []) or result_message.result
        status = "failed" if result_message.is_error else "completed"
        if result_message.stop_reason == "cancelled":
            status = "cancelled"
        return ProviderTurn(
            native_session_id=result_message.session_id,
            turn_id=result_message.uuid or f"claude_turn_{secrets.token_hex(6)}",
            status=status,
            response=response,
            error=error,
            events=tuple(events),
        )

    async def cancel(self, session_id: str) -> None:
        runtime = self._sessions[session_id]
        if runtime.active:
            await runtime.client.interrupt()

    async def close(self, session_id: str) -> None:
        runtime = self._sessions.pop(session_id, None)
        if runtime is None:
            return
        if runtime.active:
            await runtime.client.interrupt()
        await runtime.client.disconnect()

    async def _connect(
        self,
        project_path: str,
        model: str | None,
        resume: str | None = None,
    ) -> _ClaudeRuntime:
        options = ClaudeAgentOptions(
            cwd=project_path,
            model=model or self._default_model,
            permission_mode=self._permission_mode,
            resume=resume,
        )
        client = ClaudeSDKClient(options=options)
        await client.connect()
        return _ClaudeRuntime(client=client)

    def _block_event(self, block: object) -> AgentEvent | None:
        if isinstance(block, TextBlock):
            return AgentEvent(provider=self.name, type="agent_message", text=block.text)
        if isinstance(block, ThinkingBlock):
            return AgentEvent(provider=self.name, type="thought", text=block.thinking)
        if isinstance(block, ToolUseBlock):
            return AgentEvent(provider=self.name, type="tool_call", data=asdict(block))
        if isinstance(block, ToolResultBlock):
            return AgentEvent(provider=self.name, type="tool_call_update", data=asdict(block))
        return None
