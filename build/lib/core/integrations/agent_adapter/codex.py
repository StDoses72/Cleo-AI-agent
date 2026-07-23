from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from openai_codex import ApprovalMode, AsyncCodex, AsyncThread, AsyncTurnHandle, Sandbox
from openai_codex.api import ReasoningEffort

from core.integrations.agent_adapter.control import (
    HarnessAccount,
    HarnessModel,
    NativeSession,
    NativeSessionDetail,
    NativeSessionPage,
    SessionOptions,
)
from core.integrations.agent_adapter.models import AgentEvent, EventCallback, emit_event
from core.integrations.agent_adapter.provider import ProviderSession, ProviderTurn


@dataclass(slots=True)
class _CodexRuntime:
    client: AsyncCodex
    thread: AsyncThread
    options: SessionOptions = field(default_factory=SessionOptions)
    cwd: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active_turn: AsyncTurnHandle | None = None


class CodexProvider:
    name = "codex"

    def __init__(
        self,
        default_model: str | None,
        *,
        name: str = "codex",
        approval_mode: ApprovalMode = ApprovalMode.deny_all,
        sandbox: Sandbox = Sandbox.workspace_write,
    ) -> None:
        self.name = name
        self._default_model = default_model
        self._approval_mode = approval_mode
        self._sandbox = sandbox
        self._sessions: dict[str, _CodexRuntime] = {}

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        client = AsyncCodex()
        await client.__aenter__()
        try:
            options = SessionOptions(
                model=model or self._default_model,
                approval_mode=self._approval_mode.value,
                sandbox=self._sandbox.value,
            )
            thread = await client.thread_start(
                approval_mode=self._approval_mode,
                cwd=project_path,
                model=options.model,
                sandbox=self._sandbox,
            )
        except Exception:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(client, thread, options, project_path)
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
            options = SessionOptions(
                model=model or self._default_model,
                approval_mode=self._approval_mode.value,
                sandbox=self._sandbox.value,
            )
            thread = await client.thread_resume(
                native_session_id,
                approval_mode=self._approval_mode,
                cwd=project_path,
                model=options.model,
                sandbox=self._sandbox,
            )
        except Exception:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(client, thread, options, project_path)
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
            options = runtime.options
            turn = await runtime.thread.turn(
                prompt,
                approval_mode=(
                    ApprovalMode(options.approval_mode)
                    if options.approval_mode
                    else None
                ),
                effort=ReasoningEffort(options.effort) if options.effort else None,
                model=options.model,
                sandbox=Sandbox(options.sandbox) if options.sandbox else None,
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

    def session_options(self, session_id: str) -> SessionOptions:
        return self._sessions[session_id].options

    async def update_session_options(
        self,
        session_id: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        approval_mode: str | None = None,
        sandbox: str | None = None,
    ) -> SessionOptions:
        runtime = self._sessions[session_id]
        current = runtime.options
        if effort is not None:
            ReasoningEffort(effort)
        if approval_mode is not None:
            ApprovalMode(approval_mode)
        if sandbox is not None:
            Sandbox(sandbox)
        runtime.options = SessionOptions(
            model=current.model if model is None else model,
            effort=current.effort if effort is None else effort,
            approval_mode=(
                current.approval_mode if approval_mode is None else approval_mode
            ),
            sandbox=current.sandbox if sandbox is None else sandbox,
        )
        return runtime.options

    async def list_models(self) -> tuple[HarnessModel, ...]:
        async with AsyncCodex() as client:
            response = await client.models()
        return tuple(
            HarnessModel(
                id=str(model.model),
                display_name=str(model.display_name),
                description=str(model.description),
                is_default=bool(model.is_default),
                default_effort=self._scalar(model.default_reasoning_effort),
                supported_efforts=tuple(
                    self._scalar(option.reasoning_effort)
                    for option in model.supported_reasoning_efforts
                ),
            )
            for model in response.data
        )

    async def list_native_sessions(
        self,
        *,
        limit: int = 50,
        cursor: str | None = None,
        archived: bool | None = None,
        cwd: str | None = None,
        search_term: str | None = None,
    ) -> NativeSessionPage:
        async with AsyncCodex() as client:
            response = await client.thread_list(
                archived=archived,
                cursor=cursor,
                cwd=cwd,
                limit=limit,
                search_term=search_term,
            )
        return NativeSessionPage(
            sessions=tuple(self._native_session(thread) for thread in response.data),
            next_cursor=response.next_cursor,
        )

    async def read_native_session(
        self,
        native_session_id: str,
    ) -> NativeSessionDetail:
        async with AsyncCodex() as client:
            thread = await client.thread_resume(native_session_id)
            response = await thread.read(include_turns=True)
        native = self._native_session(response.thread)
        turns = tuple(
            turn.model_dump(mode="json", by_alias=True, exclude_none=True)
            for turn in response.thread.turns
        )
        return NativeSessionDetail(session=native, turns=turns)

    async def account_status(self) -> HarnessAccount:
        async with AsyncCodex() as client:
            response = await client.account()
        if response.account is None:
            return HarnessAccount(authenticated=False)
        data = response.account.model_dump(
            mode="json",
            by_alias=True,
            exclude_none=True,
        )
        if not isinstance(data, dict):
            return HarnessAccount(authenticated=True)
        return HarnessAccount(
            authenticated=True,
            account_type=self._scalar(data.get("type")),
            email=self._optional_text(data.get("email")),
            plan=self._optional_text(data.get("planType")),
        )

    async def fork_session(self, session_id: str) -> ProviderSession:
        source = self._sessions[session_id]
        options = source.options
        client = AsyncCodex()
        await client.__aenter__()
        try:
            thread = await client.thread_fork(
                source.thread.id,
                approval_mode=(
                    ApprovalMode(options.approval_mode)
                    if options.approval_mode
                    else None
                ),
                cwd=source.cwd or None,
                model=options.model,
                sandbox=Sandbox(options.sandbox) if options.sandbox else None,
            )
        except Exception:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(client, thread, options, source.cwd)
        return ProviderSession(id=thread.id, native_id=thread.id)

    async def rename_session(self, session_id: str, name: str) -> None:
        runtime = self._sessions[session_id]
        async with runtime.lock:
            await runtime.thread.set_name(name)

    async def compact_session(self, session_id: str) -> None:
        runtime = self._sessions[session_id]
        async with runtime.lock:
            await runtime.thread.compact()

    async def archive_session(self, session_id: str) -> None:
        runtime = self._sessions.pop(session_id)
        try:
            async with runtime.lock:
                if runtime.active_turn is not None:
                    await runtime.active_turn.interrupt()
                await runtime.client.thread_archive(runtime.thread.id)
        finally:
            await runtime.client.close()

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

    @classmethod
    def _native_session(cls, thread: Any) -> NativeSession:
        data = thread.model_dump(mode="json", by_alias=True, exclude_none=True)
        return NativeSession(
            id=str(data["id"]),
            name=cls._optional_text(data.get("name")),
            preview=str(data.get("preview") or ""),
            cwd=cls._scalar(data.get("cwd")),
            status=cls._scalar(data.get("status")),
            source=cls._scalar(data.get("source")),
            model_provider=str(data.get("modelProvider") or "openai"),
            created_at=cls._timestamp(data.get("createdAt")),
            updated_at=cls._timestamp(data.get("updatedAt")),
        )

    @staticmethod
    def _timestamp(value: Any) -> str:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, UTC).isoformat()
        return str(value or "")

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        text = CodexProvider._scalar(value)
        return text or None

    @staticmethod
    def _scalar(value: Any) -> str:
        if isinstance(value, Enum):
            return str(value.value)
        if isinstance(value, dict):
            root = value.get("root")
            if root is not None:
                return CodexProvider._scalar(root)
            return str(value.get("type") or value)
        root = getattr(value, "root", None)
        if root is not None:
            return CodexProvider._scalar(root)
        return str(value or "")

    @staticmethod
    def _notification_data(payload: Any) -> dict[str, Any]:
        if hasattr(payload, "model_dump"):
            data = payload.model_dump(mode="json", by_alias=True, exclude_none=True)
            return data if isinstance(data, dict) else {"value": data}
        params = getattr(payload, "params", None)
        return params if isinstance(params, dict) else {"value": str(payload)}

    def _event_from_notification(
        self,
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
            provider=self.name,
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
