"""Application service for provider-neutral session orchestration."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cleo.harnesses.control import (
    HarnessAccount,
    HarnessModel,
    NativeSessionDetail,
    NativeSessionPage,
    SessionOptions,
)
from cleo.harnesses.models import (
    AgentResult,
    AgentSession,
    EventCallback,
)
from cleo.harnesses.provider import AgentProvider
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


class AgentService:
    """Coordinate harness sessions through provider and persistence ports."""

    def __init__(
        self,
        project_root: str | Path,
        *,
        session_store: SessionRepository,
        space: str = "productivity",
        owner_type: str = "agent",
    ) -> None:
        """Use caller-supplied persistence; never construct infrastructure here."""
        self._project_root = Path(project_root).expanduser().resolve()
        if not self._project_root.is_dir():
            raise ValueError(f"Project root does not exist: {self._project_root}")
        self._providers: dict[str, AgentProvider] = {}
        self._sessions: dict[str, _SessionRoute] = {}
        self._store = session_store
        self._space = space
        self._owner_type = owner_type

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
        """按 harness 原生会话 id 恢复会话,复用 SessionStore 中已有 handle。"""
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
        session = await implementation.resume_session(
            self._required_text(native_session_id, "native_session_id"),
            resolved_path,
            selected_model,
        )
        restored = self._add_route(
            implementation,
            session.id,
            resolved_path,
            session.native_id,
            project=project or (stored or {}).get("project"),
            handle=(stored or {}).get("id"),
            persist_runtime_options=saved_options is None,
        )
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
            self._store.update_manifest(restored.id, runtime_options=options.as_dict())
        return restored

    async def prompt(
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
        self._store.update_manifest(session_id, runtime_options=options.as_dict())
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
                self._store.update_manifest(handle, runtime_options=options.as_dict())
        return AgentSession(
            id=handle,
            provider=provider.name,
            project_path=project_path,
            native_session_id=native_session_id,
            space=self._space,
            project=project,
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
        if event.type == "thought" or event_type in {
            "agent_message",
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
