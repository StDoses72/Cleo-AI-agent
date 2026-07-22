from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

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
        events: list[AgentEvent] = []
        response_parts: list[str] = []
        final_response: str | None = None
        status = "failed"
        error: str | None = None
        async with runtime.lock:
            turn = await runtime.thread.turn(
                prompt,
                approval_mode=ApprovalMode.deny_all,
                sandbox=Sandbox.workspace_write,
            )
            runtime.active_turn = turn
            try:
                async for notification in turn.stream():
                    data = self._notification_data(notification.payload)
                    if notification.method == "item/completed":
                        item = data.get("item")
                        if isinstance(item, dict) and item.get("type") == "agentMessage":
                            text = item.get("text")
                            phase = item.get("phase")
                            if isinstance(text, str) and phase in {None, "final_answer"}:
                                final_response = text
                    elif notification.method == "turn/completed":
                        completed_turn = data.get("turn")
                        if isinstance(completed_turn, dict):
                            status = self._turn_status(completed_turn.get("status"))
                            turn_error = completed_turn.get("error")
                            if isinstance(turn_error, dict):
                                error = str(turn_error.get("message") or "") or None

                    event = self._event_from_notification(notification.method, data)
                    if event is None:
                        continue
                    events.append(event)
                    if event.type == "assistant_message_chunk" and event.text:
                        response_parts.append(event.text)
                    await emit_event(on_event, event)
            finally:
                runtime.active_turn = None

        response = final_response or "".join(response_parts) or None
        return ProviderTurn(
            native_session_id=runtime.thread.id,
            turn_id=turn.id,
            status=status,
            response=response,
            error=error,
            events=tuple(events),
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

    @staticmethod
    def _notification_data(payload: Any) -> dict[str, Any]:
        if hasattr(payload, "model_dump"):
            data = payload.model_dump(mode="json", by_alias=True, exclude_none=True)
            return data if isinstance(data, dict) else {"value": data}
        params = getattr(payload, "params", None)
        return params if isinstance(params, dict) else {"value": str(payload)}

    @classmethod
    def _event_from_notification(
        cls,
        method: str,
        data: dict[str, Any],
    ) -> AgentEvent | None:
        if method in {"turn/started", "turn/completed"}:
            return None

        item = data.get("item")
        item_type = item.get("type") if isinstance(item, dict) else None
        if method == "item/completed" and item_type == "agentMessage":
            return None

        event_type: str
        text: str | None = None
        if method == "item/agentMessage/delta":
            event_type = "assistant_message_chunk"
            text = str(data.get("delta") or "") or None
        elif method in {
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
        }:
            event_type = "thought"
            text = str(data.get("delta") or "") or None
        elif method == "item/commandExecution/outputDelta":
            event_type = "terminal_output"
            text = str(data.get("delta") or "") or None
        elif method in {
            "item/fileChange/outputDelta",
            "item/fileChange/patchUpdated",
        }:
            event_type = "file_change"
            text = str(data.get("delta") or "") or None
        elif method in {"turn/plan/updated", "item/plan/delta"}:
            event_type = "plan_update"
        elif method == "turn/diff/updated":
            event_type = "file_change"
            text = str(data.get("diff") or "") or None
        elif method == "error":
            event_type = "error"
            error = data.get("error")
            message = error.get("message") if isinstance(error, dict) else None
            text = str(message or data.get("message") or "") or None
        elif method == "item/commandExecution/terminalInteraction":
            event_type = "terminal_output"
        elif method in {"item/started", "item/completed"}:
            tool_types = {
                "commandExecution",
                "mcpToolCall",
                "dynamicToolCall",
                "collabAgentToolCall",
                "serverRequest",
            }
            if item_type in tool_types:
                event_type = "tool_call" if method == "item/started" else "tool_result"
            elif item_type == "fileChange":
                event_type = "file_change"
            elif item_type == "plan":
                event_type = "plan_update"
            elif item_type == "reasoning":
                event_type = "thought"
            else:
                event_type = "provider_event"
        elif method == "thread/tokenUsage/updated":
            event_type = "status"
        else:
            event_type = "provider_event"

        return AgentEvent(
            provider=cls.name,
            type=event_type,
            text=text,
            data={
                "provider_event_type": method,
                "schema_version": 2,
                "payload": data,
            },
        )

    @staticmethod
    def _turn_status(value: Any) -> str:
        status = str(value or "failed")
        return {"inProgress": "running", "interrupted": "cancelled"}.get(status, status)
