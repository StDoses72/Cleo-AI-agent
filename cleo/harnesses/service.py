"""Application service for provider-neutral session orchestration."""

from __future__ import annotations

import asyncio
import os
import secrets
from collections.abc import Awaitable, Callable
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cleo.harnesses.context import ContextBinding, ConversationContext
from cleo.harnesses.control import (
    HarnessAccount,
    HarnessModel,
    NativeSessionDetail,
    NativeSessionPage,
    SessionOptions,
)
from cleo.harnesses.events import event_payload
from cleo.harnesses.handoff import (
    DELIVERED_EVENT,
    SWITCH_EVENT,
    checked_history,
    pending_handoff,
)
from cleo.harnesses.models import (
    AgentEvent,
    AgentResult,
    AgentSession,
    EventCallback,
    emit_event,
)
from cleo.harnesses.provider import AgentProvider, NativeSessionNotFoundError
from cleo.runtime.usage import RateLimitWindowUsage
from cleo.sessions.ports import SessionRepository


@dataclass(slots=True)
class _SessionRoute:
    """内部路由项: 把对外 session handle 映射到 provider 侧会话。"""

    provider: AgentProvider
    provider_session_id: str
    project_path: str
    native_session_id: str | None
    project: str
    handoff: str = ""
    handoff_id: str | None = None
    context_binding: ContextBinding | None = None


class AgentService:
    """Coordinate harness sessions through provider and persistence ports."""

    def __init__(
        self,
        project_root: str | Path,
        *,
        session_store: SessionRepository,
        space: str = "productivity",
        owner_type: str = "agent",
        memory_context: Callable[[str, str], str] | None = None,
    ) -> None:
        """Use caller-supplied persistence; never construct infrastructure here."""
        self._project_root = Path(project_root).expanduser().resolve()
        if not self._project_root.is_dir():
            raise ValueError(f"Project root does not exist: {self._project_root}")
        self._providers: dict[str, AgentProvider] = {}
        self._sessions: dict[str, _SessionRoute] = {}
        self._store = session_store
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._space = space
        self._owner_type = owner_type
        self._memory_context = memory_context
        self._context = ConversationContext(session_store)

    def _context_lease(self, session_id):
        return (
            self._context.lease(session_id)
            if hasattr(self._store, "memory_root")
            else nullcontext()
        )

    @property
    def providers(self) -> tuple[str, ...]:
        """Return registered provider names in registration order."""
        return tuple(self._providers)

    def register(self, provider: AgentProvider) -> None:
        """注册一个 provider,重名抛 ValueError。"""
        if provider.name in self._providers:
            raise ValueError(f"Provider already registered: {provider.name}")
        self._providers[provider.name] = provider

    def provider_control(self, name: str) -> AgentProvider:
        """Return a provider so richer clients can inspect optional capabilities."""
        return self._provider(name)

    async def create_session(
        self,
        provider: str,
        project_path: str = ".",
        model: str | None = None,
        project: str | None = None,
    ) -> AgentSession:
        """在指定 provider 上创建新会话并登记路由与持久化 manifest。"""
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
        """Purpose: Resume a task, reconnecting a confirmed missing empty native draft.

        Input: Provider identity, saved native ID and optional runtime overrides.
        Output: The original Cleo handle and options; nonempty history is never discarded.
        """
        implementation = self._provider(provider)
        resolved_path = self._project_directory(project_path)
        stored = self._store.find_by_native_session(
            provider=provider,
            native_session_id=native_session_id,
            space=self._space,
        )
        stored_handle = (stored or {}).get("id")
        if stored_handle in self._sessions:
            raise ValueError(f"Session {stored_handle} is already active.")
        saved_options = self._saved_session_options(stored_handle)
        selected_model = model
        if selected_model is None and saved_options is not None:
            selected_model = saved_options.model
        try:
            binding = None
            if stored_handle:
                for event in reversed(self._store.read_events(stored_handle)):
                    payload = (event.get("data") or {}).get("payload") or {}
                    if (
                        event.get("actor") == "system"
                        and isinstance(payload, dict)
                        and payload.get("context_version") == 1
                        and payload.get("snapshot_id")
                    ):
                        binding = ContextBinding(stored_handle, payload["snapshot_id"])
                        break
            resume_context = getattr(implementation, "resume_context_session", None)
            if binding:
                self._context.load(binding)
            session = await (
                resume_context(
                    native_session_id,
                    resolved_path,
                    selected_model,
                    binding,
                )
                if binding and callable(resume_context)
                else implementation.resume_session(
                    self._required_text(native_session_id, "native_session_id"),
                    resolved_path,
                    selected_model,
                )
            )
        except NativeSessionNotFoundError:
            # A thread created but never used may not have a rollout on disk. Only
            # reconnect an empty local task; failures to read history stay failures.
            if not stored_handle:
                raise
            events = self._store.read_events(stored_handle)
            manifest = self._store.load_manifest(stored_handle)
            if (
                not events
                or len(events) != manifest.get("last_event_seq")
                or any(
                    event.get("type") not in {"session_created", "session_closed"}
                    for event in events
                )
            ):
                raise
            session = await implementation.create_session(resolved_path, selected_model)
        restored = self._add_route(
            implementation,
            session.id,
            resolved_path,
            session.native_id,
            project=project or (stored or {}).get("project"),
            handle=(stored or {}).get("id"),
            persist_runtime_options=saved_options is None,
        )
        self._sessions[restored.id].context_binding = binding
        if saved_options is None:
            return restored

        update_options = getattr(implementation, "update_session_options", None)
        if not callable(update_options):
            return restored
        desired = SessionOptions(
            model=selected_model,
            effort=saved_options.effort,
            approval_mode=saved_options.approval_mode,
            sandbox=saved_options.sandbox,
        )
        try:
            options = await update_options(
                session.id,
                model=desired.model,
                effort=desired.effort,
                approval_mode=desired.approval_mode,
                sandbox=desired.sandbox,
            )
        except Exception:
            self._sessions.pop(restored.id, None)
            await implementation.close(session.id)
            raise
        if isinstance(options, SessionOptions):
            self._persist_options(restored.id, options)
        return restored

    async def switch_session(
        self,
        session_id: str,
        provider: str,
        model: str | None = None,
        *,
        prepare: Callable[[AgentProvider, str], Awaitable[None]] | None = None,
    ) -> AgentSession:
        """Prepare a fresh native session, then commit the same Cleo identity.

        A fresh target also prevents returning to stale context when switching back.
        The existing provider_event envelope stores the pending handoff checkpoint;
        older writers preserve it without knowing any new manifest fields.
        """
        session_id = self._required_text(session_id, "session_id")
        provider = self._required_text(provider, "provider")
        async with self._session_locks.setdefault(session_id, asyncio.Lock()):
            with self._context_lease(session_id):
                return await self._switch_session(session_id, provider, model, prepare=prepare)

    async def _switch_session(self, session_id, provider, model=None, *, prepare=None):
        implementation = self._provider(provider)
        self._context.reconcile(session_id)
        manifest = self._store.load_manifest(session_id)
        events = checked_history(self._store, session_id)
        project = manifest["project"]
        cwd = self._project_directory(str(manifest.get("cwd") or "."))
        prepared = self._context.prepare(session_id, events)
        context = prepared.text
        create_context = getattr(implementation, "create_context_session", None)
        if prepared.requires_reader and not callable(create_context):
            raise ValueError(
                "目标 Harness 不支持长历史的受控读取；未截断历史，原 harness 可继续使用。"
            )
        old = self._sessions.get(session_id)
        handoff_id = f"handoff-{secrets.token_hex(12)}"
        candidate = await (
            create_context(cwd, model, prepared.binding)
            if callable(create_context)
            else implementation.create_session(cwd, model)
        )
        try:
            validate = getattr(implementation, "validate_handoff", None)
            if callable(validate):
                await validate(candidate.id)
            if prepare is not None:
                await prepare(implementation, candidate.id)
            options_method = getattr(implementation, "session_options", None)
            options = options_method(candidate.id) if callable(options_method) else None
            raw_options = manifest.get("runtime_options")
            if raw_options is not None and not isinstance(raw_options, dict):
                raise ValueError("运行选项格式不受支持，未覆盖现有配置。")
            runtime = dict(raw_options or {})
            runtime.update(
                options.as_dict()
                if isinstance(options, SessionOptions)
                else {
                    "model": model,
                    "effort": None,
                    "approval_mode": None,
                    "sandbox": None,
                }
            )
            if self._store.read_events(session_id) != events:
                raise ValueError("准备交接时历史发生变化，请重试；原 harness 保持不变。")
            updates = {
                "provider": provider,
                "native_session_id": candidate.native_id,
                "runtime_options": runtime,
            }
            self._store.append_events(
                space=self._space,
                project=project,
                session_id=session_id,
                events=[
                    {
                        "id": handoff_id,
                        "type": "provider_event",
                        "actor": "system",
                        "data": {
                            "provider_event_type": SWITCH_EVENT,
                            "payload": {
                                "version": 1,
                                "provider": provider,
                                "from_provider": manifest["provider"],
                                "native_session_id": candidate.native_id,
                                "history_seq": manifest["last_event_seq"],
                                "context_version": 1,
                                "snapshot_id": prepared.binding.snapshot_id,
                                "phase": "prepared",
                                "inline_bytes": prepared.inline_bytes,
                                "manifest_updates": updates,
                            },
                        },
                    }
                ],
                manifest_updates=updates,
            )
        except BaseException:
            await implementation.close(candidate.id)
            # A complete log commit may precede a failed manifest/index update.
            # Recover it before any later user request; never keep a stale live route.
            committed = any(e.get("id") == handoff_id for e in self._store.read_events(session_id))
            if committed:
                self._sessions.pop(session_id, None)
                self._context.reconcile(session_id)
            raise
        self._sessions[session_id] = _SessionRoute(
            implementation,
            candidate.id,
            cwd,
            candidate.native_id,
            project,
            context,
            handoff_id,
            prepared.binding,
        )
        if old is not None:
            # Cleanup failure cannot undo an already committed selection.
            try:
                await old.provider.close(old.provider_session_id)
            except Exception:
                pass
        return AgentSession(
            id=session_id,
            provider=provider,
            project_path=cwd,
            native_session_id=candidate.native_id,
            space=self._space,
            project=project,
        )

    async def restore_session(
        self,
        session_id: str,
        *,
        prepare: Callable[[AgentProvider, str], Awaitable[None]] | None = None,
    ) -> AgentSession:
        """Restore an acknowledged native thread or rebuild a not-yet-delivered handoff."""
        with self._context_lease(session_id):
            self._context.reconcile(session_id)
        manifest = self._store.load_manifest(session_id)
        events = checked_history(self._store, session_id)
        options = self._saved_session_options(session_id)
        if pending_handoff(events, manifest["provider"]):
            return await self.switch_session(
                session_id,
                manifest["provider"],
                options.model if options else None,
                prepare=prepare,
            )
        return await self.resume_session(
            manifest["provider"],
            manifest["native_session_id"],
            str(manifest.get("cwd") or "."),
            project=manifest["project"],
        )

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        session_id = self._required_text(session_id, "session_id")
        async with self._session_locks.setdefault(session_id, asyncio.Lock()):
            with self._context_lease(session_id):
                return await self._prompt(session_id, prompt, on_event)

    async def _prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        """向已存在的会话发送一轮 prompt,并把事件/状态写入 SessionStore。"""
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is None:
            raise KeyError(f"Unknown agent session: {session_id}")

        prompt = self._required_text(prompt, "prompt")
        if route.handoff_id:
            # Validate source integrity and reserve room for new input before recording a turn.
            self._context.load(route.context_binding)
            if len(prompt.encode()) + len(route.handoff.encode()) > 64_000:
                raise ValueError(
                    "本次输入超过保守交接预算，请缩短新消息；历史未截断，尚未提交模型。"
                )
        turn_key = f"turn-{secrets.token_hex(12)}"
        self._store.append_events(
            space=self._space,
            project=route.project,
            session_id=session_id,
            events=[
                {"id": turn_key, "type": "user_message", "actor": "agent", "content": prompt},
                {"type": "session_running", "actor": "system"},
            ],
            manifest_updates={"status": "running"},
        )
        await emit_event(
            on_event,
            AgentEvent(
                provider=route.provider.name,
                type="turn_started",
                text=prompt,
                data={"turnId": turn_key},
            ),
        )
        thought_number = 0
        previous_type = ""
        live_events: set[int] = set()

        async def relay(event: AgentEvent) -> None:
            nonlocal thought_number, previous_type
            payload = event_payload(event)
            source = payload.get("item") if isinstance(payload.get("item"), dict) else payload
            key = (
                source.get("id")
                or payload.get("itemId")
                or source.get("toolCallId")
                or source.get("tool_use_id")
            )
            data = {**event.data, "turn_id": turn_key}
            phase = source.get("phase") or payload.get("phase")
            if event.type in {"thought", "agent_message"} or phase == "commentary":
                if previous_type != "thought":
                    thought_number += 1
                data["timeline_id"] = f"{turn_key}:thought:{key or thought_number}"
                previous_type = "thought"
            else:
                previous_type = event.type
                if event.type in {"tool_call", "tool_result", "tool_call_update"}:
                    data["timeline_id"] = f"{turn_key}:tool:{key or secrets.token_hex(6)}"
                elif event.type == "plan_update":
                    data["timeline_id"] = f"{turn_key}:plan"
                elif event.type == "assistant_message_chunk" and phase in {"final_answer", "final"}:
                    data["timeline_id"] = f"{turn_key}:answer"
            projected = event.model_copy(update={"data": data})
            stored = self._stored_provider_event(projected)
            if stored is not None:
                await asyncio.to_thread(
                    self._store.append_events,
                    space=self._space,
                    project=route.project,
                    session_id=session_id,
                    events=[stored],
                )
                live_events.add(id(event))
            try:
                await emit_event(on_event, projected)
            except Exception:
                # A durable answer is final even if its UI notification connection closes.
                if event.type != "question_response" or stored is None:
                    raise

        try:
            context = (
                self._memory_context(self._space, route.project) if self._memory_context else ""
            )
            context = "\n\n".join(part for part in (context, route.handoff) if part)
            if route.handoff_id:
                self._store.append_event(
                    space=self._space,
                    project=route.project,
                    session_id=session_id,
                    event_type="provider_event",
                    actor="system",
                    data={
                        "provider_event_type": "cleo/handoff_submitted",
                        "payload": {
                            "version": 1,
                            "switch_id": route.handoff_id,
                            "turn_id": turn_key,
                        },
                    },
                )
            turn = await route.provider.prompt(
                route.provider_session_id,
                context + "\n\nCurrent user request:\n" + prompt if context else prompt,
                relay if on_event is not None else None,
            )
        except asyncio.CancelledError:
            self._store.set_status(session_id, "cancelled")
            raise
        except Exception as exc:
            self._store.set_status(session_id, "failed", error=str(exc))
            raise
        route.native_session_id = turn.native_session_id
        stored_events = [
            translated
            for event in turn.events
            if id(event) not in live_events
            if (translated := self._stored_provider_event(event)) is not None
        ]
        if turn.response:
            stored_events.append(
                {
                    "id": f"{turn_key}:answer",
                    "type": "assistant_message",
                    "actor": route.provider.name,
                    "content": turn.response,
                }
            )
        if route.handoff_id and turn.status == "completed":
            stored_events.append(
                {
                    "type": "provider_event",
                    "actor": "system",
                    "data": {
                        "provider_event_type": DELIVERED_EVENT,
                        "payload": {
                            "version": 1,
                            "switch_id": route.handoff_id,
                            "context_version": 1,
                            "manifest_updates": {
                                "status": turn.status,
                                "error": turn.error,
                                "native_session_id": turn.native_session_id,
                            },
                        },
                    },
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
        # Deterministic working-state checkpoint; failure must not undo a completed model turn.
        try:
            await asyncio.to_thread(
                self._context.prepare, session_id, self._store.read_events(session_id)
            )
        except (OSError, ValueError):
            pass  # Source remains authoritative; next switch rebuilds or returns the actual error.
        if turn.status == "completed":
            route.handoff = ""
            route.handoff_id = None
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
        """一步到位: 创建会话并立即执行一轮 prompt。"""
        session = await self.create_session(provider, project_path, model, project)
        return await self.prompt(session.id, prompt, on_event)

    async def list_models(self, provider: str) -> tuple[HarnessModel, ...]:
        """列出 provider 支持的模型(可选能力,缺失时抛 NotImplementedError)。"""
        implementation = self._provider(provider)
        method = self._capability(implementation, "list_models")
        return await method()

    async def list_native_sessions(
        self,
        provider: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
        archived: bool | None = None,
        cwd: str | None = None,
        search_term: str | None = None,
    ) -> NativeSessionPage:
        """分页列出 provider 侧的原生会话(可选能力)。"""
        implementation = self._provider(provider)
        method = self._capability(implementation, "list_native_sessions")
        return await method(
            limit=limit,
            cursor=cursor,
            archived=archived,
            cwd=cwd,
            search_term=search_term,
        )

    async def read_native_session(
        self,
        provider: str,
        native_session_id: str,
    ) -> NativeSessionDetail:
        """读取某个原生会话的完整详情(可选能力)。"""
        implementation = self._provider(provider)
        method = self._capability(implementation, "read_native_session")
        return await method(self._required_text(native_session_id, "native_session_id"))

    async def account_status(self, provider: str) -> HarnessAccount:
        """查询 provider 账号登录状态(可选能力)。"""
        implementation = self._provider(provider)
        method = self._capability(implementation, "account_status")
        return await method()

    async def account_rate_limits(
        self,
        session_id: str,
    ) -> tuple[RateLimitWindowUsage, ...]:
        """Read account usage windows through the active session's provider."""
        route = self._route(session_id)
        method = self._capability(route.provider, "account_rate_limits")
        return await method(route.provider_session_id)

    def session_options(self, session_id: str) -> SessionOptions:
        """读取会话当前的运行时选项(model/effort/approval/sandbox)。"""
        route = self._route(session_id)
        method = self._capability(route.provider, "session_options")
        return method(route.provider_session_id)

    async def update_session_options(
        self,
        session_id: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        approval_mode: str | None = None,
        sandbox: str | None = None,
    ) -> SessionOptions:
        """更新会话运行时选项并同步到 SessionStore manifest。"""
        route = self._route(session_id)
        method = self._capability(route.provider, "update_session_options")
        options = await method(
            route.provider_session_id,
            model=model,
            effort=effort,
            approval_mode=approval_mode,
            sandbox=sandbox,
        )
        self._persist_options(session_id, options)
        return options

    async def resolve_approval(
        self,
        session_id: str,
        approval_id: str,
        decision: str,
    ) -> dict[str, Any]:
        route = self._route(session_id)
        method = self._capability(route.provider, "resolve_approval")
        return await method(route.provider_session_id, approval_id, decision)

    async def enable_user_approvals(self, session_id: str) -> None:
        route = self._route(session_id)
        method = self._capability(route.provider, "enable_user_approvals")
        await method(route.provider_session_id)

    async def resolve_question(self, session_id: str, question_id: str, answers: dict) -> dict:
        route = self._route(session_id)
        method = self._capability(route.provider, "resolve_question")
        return await method(route.provider_session_id, question_id, answers)

    def pending_questions(self, session_id: str) -> list[dict]:
        route = self._route(session_id)
        method = getattr(route.provider, "pending_questions", None)
        return method(route.provider_session_id) if method else []

    async def enable_questions(self, session_id: str) -> None:
        route = self._route(session_id)
        method = getattr(route.provider, "enable_questions", None)
        if method is not None:
            await method(route.provider_session_id)

    async def fork_session(self, session_id: str) -> AgentSession:
        """分叉现有会话,新会话记录 parent_session_id。"""
        route = self._route(session_id)
        method = self._capability(route.provider, "fork_session")
        forked = await method(route.provider_session_id)
        return self._add_route(
            route.provider,
            forked.id,
            route.project_path,
            forked.native_id,
            project=route.project,
            parent_session_id=session_id,
        )

    async def rename_session(self, session_id: str, name: str) -> None:
        """重命名会话(provider 侧与本地 manifest 同步)。"""
        route = self._route(session_id)
        name = self._required_text(name, "name")
        method = self._capability(route.provider, "rename_session")
        await method(route.provider_session_id, name)
        self._store.update_manifest(session_id, title=name)

    async def compact_session(self, session_id: str) -> None:
        """触发 provider 侧上下文压缩,并记录事件、刷新本地 compact 摘要。"""
        route = self._route(session_id)
        method = self._capability(route.provider, "compact_session")
        await method(route.provider_session_id)
        self._store.append_event(
            space=self._space,
            project=route.project,
            session_id=session_id,
            event_type="provider_event",
            actor=route.provider.name,
            data={"provider_event_type": "thread/compact", "native": True},
        )
        self._store.refresh_compact(session_id)

    async def archive_session(self, session_id: str) -> None:
        """归档会话: provider 侧归档、移除本地路由、状态置 archived。"""
        route = self._route(session_id)
        method = self._capability(route.provider, "archive_session")
        await method(route.provider_session_id)
        self._sessions.pop(session_id, None)
        self._store.set_status(session_id, "archived")

    async def cancel(self, session_id: str) -> None:
        """取消进行中的 turn,状态置 cancelled。"""
        route = self._route(session_id)
        await route.provider.cancel(route.provider_session_id)
        self._store.set_status(session_id, "cancelled")

    async def close(self, session_id: str) -> None:
        """关闭会话并释放 provider 资源;未达终态的会话状态置 closed。"""
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is not None:
            await route.provider.close(route.provider_session_id)
            manifest = self._store.load_manifest(session_id)
            if manifest["status"] not in {"completed", "failed", "cancelled"}:
                self._store.set_status(session_id, "closed")
            self._sessions.pop(session_id, None)

    async def aclose(self) -> None:
        """关闭所有活跃会话。"""
        for session_id in tuple(self._sessions):
            await self.close(session_id)

    async def __aenter__(self) -> AgentService:
        """async with 入口;返回自身供调用方在块内使用。"""
        return self

    async def __aexit__(self, _exc_type, _exc, _tb) -> None:
        """async with 出口;统一调用 aclose 释放全部会话。"""
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
        parent_session_id: str | None = None,
        persist_runtime_options: bool = True,
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
                parent_session_id=parent_session_id,
            )
        else:
            self._store.update_manifest(
                handle,
                native_session_id=native_session_id,
                status="active",
                cwd=project_path,
            )
        options_method = getattr(provider, "session_options", None)
        if persist_runtime_options and callable(options_method):
            options = options_method(provider_session_id)
            if isinstance(options, SessionOptions):
                self._persist_options(handle, options)
        return AgentSession(
            id=handle,
            provider=provider.name,
            project_path=project_path,
            native_session_id=native_session_id,
            space=self._space,
            project=project,
        )

    def _persist_options(self, session_id: str, options: SessionOptions) -> None:
        manifest = self._store.load_manifest(session_id)
        current = manifest.get("runtime_options")
        if current is not None and not isinstance(current, dict):
            raise ValueError("运行选项格式不受支持，未覆盖现有配置。")
        self._store.update_manifest(
            session_id,
            runtime_options={**(current or {}), **options.as_dict()},
        )

    def _saved_session_options(self, handle: Any) -> SessionOptions | None:
        if not isinstance(handle, str) or not handle:
            return None
        try:
            manifest = self._store.load_manifest(handle)
        except FileNotFoundError:
            return None
        raw = manifest.get("runtime_options")
        if not isinstance(raw, dict):
            return None

        def optional_text(key: str) -> str | None:
            value = raw.get(key)
            return str(value) if value is not None else None

        return SessionOptions(
            model=optional_text("model"),
            effort=optional_text("effort"),
            approval_mode=optional_text("approval_mode"),
            sandbox=optional_text("sandbox"),
        )

    @staticmethod
    def _stored_provider_event(event) -> dict[str, Any] | None:
        event_type = event.type
        if event_type == "assistant_message_completed":
            payload = event.data.get("payload")
            payload = payload if isinstance(payload, dict) else event.data
            item = payload.get("item")
            item = item if isinstance(item, dict) else payload
            if item.get("phase") != "commentary" or not event.text:
                return None
            event_type = "thought"
        if event_type == "agent_message":
            event_type = "thought"
        if (
            event_type == "assistant_message_chunk"
            and event_payload(event).get("phase") == "commentary"
        ):
            event_type = "thought"
        elif event_type == "assistant_message_chunk" and event_payload(event).get("phase") in {
            "final_answer",
            "final",
        }:
            event_type = "assistant_fragment"
        if event_type in {
            "agent_message_chunk",
            "assistant_message_chunk",
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
            "thought",
            "status",
            "error",
            "question_request",
            "question_response",
            "assistant_fragment",
        }
        if canonical_type not in known_types:
            canonical_type = "provider_event"
        result = {
            "type": canonical_type,
            "actor": event.provider,
            "content": event.text,
            "data": {
                "provider": event.provider,
                "schema_version": event.data.get("schema_version", 1),
                "provider_event_type": event.data.get("provider_event_type", event.type),
                "payload": event.data.get("payload", event.data),
                "turn_id": event.data.get("turn_id"),
                "timeline_id": event.data.get("timeline_id"),
            },
        }
        if event_type in {"question_request", "question_response"}:
            result["id"] = f"{event_payload(event)['id']}:{event_type}"
        return result

    def _provider(self, name: str) -> AgentProvider:
        name = self._required_text(name, "provider")
        provider = self._providers.get(name)
        if provider is None:
            raise KeyError(f"Unknown agent provider: {name}")
        return provider

    @staticmethod
    def _capability(provider: AgentProvider, name: str):
        method = getattr(provider, name, None)
        if not callable(method):
            raise NotImplementedError(
                f"Provider {provider.name!r} does not support {name.replace('_', ' ')}."
            )
        return method

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
