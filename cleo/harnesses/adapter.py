from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

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
from cleo.sessions.store import SessionStore

if TYPE_CHECKING:
    from cleo.integrations.harnesses.acp import AcpAgentSpec


@dataclass(slots=True)
class _SessionRoute:
    """内部路由项: 把对外 session handle 映射到 provider 侧会话。

    字段(均由 AgentAdapter._add_route 写入,来源: 各 provider 的
    create/resume/fork 返回值及调用方传入的 project 信息):
        provider: 处理该会话的 AgentProvider 实例。
        provider_session_id: provider 侧会话 id。
        project_path: 规范化后的项目目录(normcase)。
        native_session_id: harness 原生会话 id(prompt 后可能更新)。
        project: SessionStore 中的 project 分组名。

    消费方: AgentAdapter 各方法经 _route/_sessions 查表后转发调用。
    """

    provider: AgentProvider
    provider_session_id: str
    project_path: str
    native_session_id: str | None
    project: str


class AgentAdapter:
    """Single entry point for native ACP agents and SDK-backed harnesses."""

    def __init__(
        self,
        project_root: str | Path,
        *,
        session_store: SessionStore | None = None,
        space: str = "productivity",
        owner_type: str = "agent",
    ) -> None:
        """初始化 adapter 并校验项目根目录存在。

        参数:
            project_root: 项目根目录;来源: cleo/integrations/codex.py:25 与
                cleo/integrations/harnesses/factory.py:63
                (build_agent_adapter)。
            session_store: 可选的会话持久化存储;None 时在
                <project_root>/memory 下自建 SessionStore;来源: 调用方注入。
            space: SessionStore 的 space 分组;来源: 调用方(factory 默认
                "productivity")。
            owner_type: 会话属主类型标记;来源: 调用方(默认 "agent")。

        返回: None(构造器);实例被 factory.build_agent_adapter 返回给
        cleo/cli/productivity.py 与 cleo/integrations/codex.py 使用。
        """
        self._project_root = Path(project_root).expanduser().resolve()
        if not self._project_root.is_dir():
            raise ValueError(f"Project root does not exist: {self._project_root}")
        self._providers: dict[str, AgentProvider] = {}
        self._sessions: dict[str, _SessionRoute] = {}
        self._store = session_store or SessionStore(self._project_root / "memory")
        self._space = space
        self._owner_type = owner_type

    @property
    def providers(self) -> tuple[str, ...]:
        """已注册 provider 名元组。

        来源: register/register_acp; 消费方: 调用方枚举可用 provider(如 CLI 展示)。
        """
        return tuple(self._providers)

    def register(self, provider: AgentProvider) -> None:
        """注册一个 provider,重名抛 ValueError。

        参数:
            provider: 实现 AgentProvider 协议的实例;来源: factory.py:71
                (create_provider 产物)及 register_acp、测试 fake provider。

        返回: None;注册结果经 self._providers 供 create_session 等方法查找。
        """
        if provider.name in self._providers:
            raise ValueError(f"Provider already registered: {provider.name}")
        self._providers[provider.name] = provider

    def register_acp(self, name: str, spec: AcpAgentSpec) -> None:
        """便捷方法: 用 AcpAgentSpec 构造 AcpProvider 并注册(延迟导入)。

        参数:
            name: provider 名;来源: 调用方(外部装配代码)。
            spec: ACP agent 启动规格;来源: 调用方(通常由
                factory.create_provider 的 AcpHarnessOptions 组装)。

        返回: None;效果同 register。
        """
        from cleo.integrations.harnesses.acp import AcpProvider

        self.register(AcpProvider(name=name, spec=spec))

    def provider_control(self, name: str) -> AgentProvider:
        """Return a provider so richer clients can inspect optional capabilities.

        参数:
            name: provider 名;来源: 需要访问 provider 可选能力(如
                list_native_sessions)的上层客户端。

        返回:
            已注册的 AgentProvider;未注册时由 _provider 抛 KeyError。
        """
        return self._provider(name)

    async def create_session(
        self,
        provider: str,
        project_path: str = ".",
        model: str | None = None,
        project: str | None = None,
    ) -> AgentSession:
        """在指定 provider 上创建新会话并登记路由与持久化 manifest。

        参数:
            provider: provider 名;来源: cleo/cli/productivity.py(--provider
                或 default_provider)。
            project_path: 相对 project_root 的工作目录;来源: CLI --cwd
                或默认值。
            model: 可选模型覆盖;来源: CLI --model 或配置默认。
            project: 会话归属 project 名;来源: 调用方,缺省取目录名。

        返回:
            AgentSession(对外 handle);消费方: productivity.py:205/321/498/583
            及 self.run,随后以其 id 调 prompt/close 等。
        """
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
        """按 harness 原生会话 id 恢复会话,复用 SessionStore 中已有 handle。

        参数:
            provider: provider 名;来源: productivity.py:94/390、
                cleo/integrations/codex.py:51。
            native_session_id: 原生会话 id;来源: 调用方(SessionStore 记录
                或 CLI 选择)。
            project_path / model: 同 create_session。
            project: 可选 project 名,缺省沿用 SessionStore 中存储值。

        返回:
            AgentSession;消费方: 同 create_session。若对应 handle 已处于
            活跃状态则抛 ValueError。
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
        session = await implementation.resume_session(
            self._required_text(native_session_id, "native_session_id"),
            resolved_path,
            model,
        )
        return self._add_route(
            implementation,
            session.id,
            resolved_path,
            session.native_id,
            project=project or (stored or {}).get("project"),
            handle=(stored or {}).get("id"),
        )

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> AgentResult:
        """向已存在的会话发送一轮 prompt,并把事件/状态写入 SessionStore。

        参数:
            session_id: 对外 session handle;来源: create/resume/fork 返回的
                AgentSession.id,由 productivity.py:35 或
                cleo/integrations/codex.py:58 传入。
            prompt: 用户输入文本;来源: CLI 用户输入。
            on_event: 流式事件回调;来源: productivity.py 的 renderer 或
                None。

        返回:
            AgentResult(含 status/response/events);消费方: productivity.py
            渲染输出、cleo/integrations/codex.py:58 经 _result 转为工具
            返回值。失败时先把 SessionStore 状态置 "failed" 再抛原异常。
        """
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
        """一步到位: 创建会话并立即执行一轮 prompt。

        参数: 与 create_session/prompt 相同;来源: cleo/integrations/codex.py:35
        (CodexTool 的一次性执行路径)。

        返回:
            AgentResult;消费方: codex.py 经 _result 转为工具返回值。
        """
        session = await self.create_session(provider, project_path, model, project)
        return await self.prompt(session.id, prompt, on_event)

    async def list_models(self, provider: str) -> tuple[HarnessModel, ...]:
        """列出 provider 支持的模型(可选能力,缺失时抛 NotImplementedError)。

        参数:
            provider: provider 名;来源: cleo/cli/productivity.py:114 通过
                getattr 探测后调用。

        返回:
            HarnessModel 元组;消费方: productivity.py 的模型选择 UI。
        """
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
        """分页列出 provider 侧的原生会话(可选能力)。

        参数:
            provider: provider 名;来源: cleo/cli/productivity.py:117 附近的
                会话浏览命令。
            limit / cursor: 分页参数;来源: CLI 选项,透传给 provider。
            archived / cwd / search_term: 过滤条件;来源: CLI 选项。

        返回:
            NativeSessionPage(sessions + next_cursor);消费方:
            productivity.py 的会话列表/恢复 UI。
        """
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
        """读取某个原生会话的完整详情(可选能力)。

        参数:
            provider: provider 名;来源: cleo/cli/productivity.py:417。
            native_session_id: 原生会话 id;来源: 用户在会话列表中选择的项。

        返回:
            NativeSessionDetail(会话元数据 + turns);消费方:
            productivity.py 的会话详情展示。
        """
        implementation = self._provider(provider)
        method = self._capability(implementation, "read_native_session")
        return await method(self._required_text(native_session_id, "native_session_id"))

    async def account_status(self, provider: str) -> HarnessAccount:
        """查询 provider 账号登录状态(可选能力)。

        参数:
            provider: provider 名;来源: cleo/cli/productivity.py:448。

        返回:
            HarnessAccount;消费方: productivity.py 的账号状态展示。
        """
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
        """读取会话当前的运行时选项(model/effort/approval/sandbox)。

        参数:
            session_id: 对外 session handle;来源: 上层 UI(经 _route 校验)。

        返回:
            SessionOptions;消费方: 上层展示当前选项;_add_route 也在建会话时
            调用以写入 manifest.runtime_options。
        """
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
        """更新会话运行时选项并同步到 SessionStore manifest。

        参数:
            session_id: 对外 session handle;来源: cleo/cli/productivity.py
                的 /model、/effort、/approval、/sandbox 命令(244/268/285/305)。
            model / effort / approval_mode / sandbox: 待更新的选项,None 表示
                不修改;来源: CLI 命令参数。

        返回:
            更新后的 SessionOptions;消费方: productivity.py 回显新选项。
        """
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

    async def fork_session(self, session_id: str) -> AgentSession:
        """分叉现有会话,新会话记录 parent_session_id。

        参数:
            session_id: 源会话 handle;来源: cleo/cli/productivity.py:456。

        返回:
            新会话的 AgentSession;消费方: productivity.py 切换到分叉会话。
        """
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
        """重命名会话(provider 侧与本地 manifest 同步)。

        参数:
            session_id: 会话 handle;来源: cleo/cli/productivity.py:476。
            name: 新名称;来源: CLI 命令参数,空串抛 ValueError。

        返回: None。
        """
        route = self._route(session_id)
        name = self._required_text(name, "name")
        method = self._capability(route.provider, "rename_session")
        await method(route.provider_session_id, name)
        self._store.update_manifest(session_id, title=name)

    async def compact_session(self, session_id: str) -> None:
        """触发 provider 侧上下文压缩,并记录事件、刷新本地 compact 摘要。

        参数:
            session_id: 会话 handle;来源: cleo/cli/productivity.py:484。

        返回: None。
        """
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
        """归档会话: provider 侧归档、移除本地路由、状态置 archived。

        参数:
            session_id: 会话 handle;来源: cleo/cli/productivity.py:493。

        返回: None。
        """
        route = self._route(session_id)
        method = self._capability(route.provider, "archive_session")
        await method(route.provider_session_id)
        self._sessions.pop(session_id, None)
        self._store.set_status(session_id, "archived")

    async def cancel(self, session_id: str) -> None:
        """取消进行中的 turn,状态置 cancelled。

        参数:
            session_id: 会话 handle;来源: cleo/cli/productivity.py:524
                (用户中断)。

        返回: None。
        """
        route = self._route(session_id)
        await route.provider.cancel(route.provider_session_id)
        self._store.set_status(session_id, "cancelled")

    async def close(self, session_id: str) -> None:
        """关闭会话并释放 provider 资源;未达终态的会话状态置 closed。

        参数:
            session_id: 会话 handle;来源: cleo/cli/productivity.py:45 及
                self.aclose 遍历;不存在的 id 静默忽略。

        返回: None。
        """
        session_id = self._required_text(session_id, "session_id")
        route = self._sessions.get(session_id)
        if route is not None:
            await route.provider.close(route.provider_session_id)
            manifest = self._store.load_manifest(session_id)
            if manifest["status"] not in {"completed", "failed", "cancelled"}:
                self._store.set_status(session_id, "closed")
            self._sessions.pop(session_id, None)

    async def aclose(self) -> None:
        """关闭所有活跃会话。

        参数: 无;来源: cleo/cli/productivity.py:633 与
        cleo/integrations/codex.py:61 在退出时调用,也被 __aexit__ 调用。

        返回: None。
        """
        for session_id in tuple(self._sessions):
            await self.close(session_id)

    async def __aenter__(self) -> AgentAdapter:
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
        if callable(options_method):
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

    @staticmethod
    def _stored_provider_event(event) -> dict[str, Any] | None:
        event_type = event.type
        if event_type in {
            "agent_message",
            "agent_message_chunk",
            "assistant_message_chunk",
            "thought",
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
