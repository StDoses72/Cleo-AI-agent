from __future__ import annotations

import asyncio
import os
import secrets
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from acp import (
    PROTOCOL_VERSION,
    ReadTextFileResponse,
    RequestPermissionResponse,
    WriteTextFileResponse,
    spawn_agent_process,
    text_block,
)
from acp.schema import (
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    FileSystemCapabilities,
    Implementation,
)

from cleo.harnesses.control import HarnessModel
from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn


@dataclass(frozen=True, slots=True)
class AcpAgentSpec:
    """一个 ACP(agent-client-protocol) agent 的启动规格描述。

    由 ``create_provider``(cleo/integrations/harnesses/factory.py) 根据
    settings 中的 ``acp`` 类型配置构造, 传入 ``AcpProvider.__init__``。
    """

    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    auth_method: str | None = None
    auto_approve: bool = False
    model_config_id: str | None = None


class _AcpClientHost:
    """ACP client 侧宿主: 实现 agent 进程反向调用的 client 接口。

    实例被传给 ``acp.spawn_agent_process``(见 ``AcpProvider._connect``),
    agent-client-protocol 框架在处理 JSON-RPC 请求/通知时调用其
    ``session_update`` / ``request_permission`` / ``read_text_file`` /
    ``write_text_file`` 方法。
    """

    def __init__(self, provider: str, project_path: str, auto_approve: bool) -> None:
        """初始化 client host。

        参数:
            provider: provider 名称, 来自 ``AcpProvider.name``(``_connect`` 传入),
                用于标记生成事件的来源。
            project_path: 项目根目录, 来自 ``create_session`` / ``resume_session``
                的调用方(``AgentAdapter``), 用于限制文件访问范围。
            auto_approve: 是否自动批准权限请求, 来自 ``AcpAgentSpec.auto_approve``。
        """
        self._provider = provider
        self._root = Path(project_path).resolve()
        self._auto_approve = auto_approve
        self._callback: EventCallback | None = None
        self.events: list[AgentEvent] = []
        self.response_parts: list[str] = []

    def begin_turn(self, callback: EventCallback | None) -> None:
        """开始一次新 turn, 重置事件与响应缓冲。

        参数:
            callback: 事件回调, 由 ``AcpProvider.prompt`` 传入(源自
                ``AgentAdapter.prompt`` 的 ``on_event``), 用于实时推送事件;
                同时清空 ``events`` / ``response_parts`` 供本次 turn 收集。
        """
        self._callback = callback
        self.events.clear()
        self.response_parts.clear()

    async def session_update(self, session_id: str, update: Any, **_kwargs: Any) -> None:
        """接收 agent 的 ``session/update`` 通知并归一化为 ``AgentEvent``。

        由 agent-client-protocol 框架在 agent 进程推送 session 更新时调用。
        参数:
            session_id: ACP session id, 由框架传入。
            update: ACP schema 定义的 update 模型(pydantic model), 由框架传入。
            **_kwargs: 框架附加的扩展字段, 忽略。
        返回:
            None; 归一化后的 ``AgentEvent`` 追加到 ``self.events``(由
            ``AcpProvider.prompt`` 消费打包进 ``ProviderTurn``), 文本 chunk
            追加到 ``response_parts``, 并经 ``emit_event`` 推给上层回调。
        """
        data = update.model_dump(by_alias=True, exclude_none=True)
        native_event_type = data.get("sessionUpdate", type(update).__name__)
        event_type = {
            "agent_message_chunk": "assistant_message_chunk",
            "agent_thought_chunk": "thought",
            "tool_call": "tool_call",
            "tool_call_update": "tool_result",
            "plan": "plan_update",
        }.get(native_event_type, "provider_event")
        content = data.get("content") or {}
        text = content.get("text") if isinstance(content, dict) else None
        data = {
            "provider_event_type": native_event_type,
            "schema_version": 1,
            "payload": data,
        }
        event = AgentEvent(provider=self._provider, type=event_type, text=text, data=data)
        self.events.append(event)
        if native_event_type == "agent_message_chunk" and text:
            self.response_parts.append(text)
        await emit_event(self._callback, event)

    async def request_permission(
        self,
        session_id: str,
        tool_call: Any,
        options: list[Any],
        **_kwargs: Any,
    ) -> RequestPermissionResponse:
        """响应 agent 发起的 ``session/request_permission`` 请求。

        由 agent-client-protocol 框架在 agent 请求工具执行权限时同步调用。
        参数:
            session_id: ACP session id, 由框架传入。
            tool_call: 请求权限的 tool call 描述, 由框架传入(未直接使用)。
            options: agent 提供的可选权限项列表, 每项含 ``kind`` / ``option_id``。
            **_kwargs: 框架附加的扩展字段, 忽略。
        返回:
            ``RequestPermissionResponse``, 由框架回传给 agent 进程;
            ``auto_approve`` 时优先选 allow 类选项, 否则优先 reject,
            无匹配项时返回 cancelled。
        """
        kinds = ("allow_once", "allow_always") if self._auto_approve else (
            "reject_once",
            "reject_always",
        )
        selected = next(
            (option for kind in kinds for option in options if option.kind == kind),
            None,
        )
        if selected is None:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(
            outcome=AllowedOutcome(outcome="selected", option_id=selected.option_id)
        )

    async def read_text_file(
        self,
        session_id: str,
        path: str,
        line: int | None = None,
        limit: int | None = None,
        **_kwargs: Any,
    ) -> ReadTextFileResponse:
        """响应 agent 的 ``fs/read_text_file`` 请求, 读取工作区内文本文件。

        由 agent-client-protocol 框架在 agent 请求读文件时调用(需 client
        capabilities 声明 ``read_text_file=True``, 见 ``_connect``)。
        参数:
            session_id: ACP session id, 由框架传入。
            path: 目标文件路径, 由 agent 提供; 经 ``_workspace_path`` 校验
                必须位于项目根目录内。
            line: 起始行号(1-based), 可选, 由 agent 提供。
            limit: 最多读取行数, 可选, 由 agent 提供。
        返回:
            ``ReadTextFileResponse``, 内容为(可选按行切片后的)文件文本,
            由框架回传给 agent 进程。
        """
        file_path = self._workspace_path(path)
        content = await asyncio.to_thread(file_path.read_text, encoding="utf-8")
        if line is not None or limit is not None:
            lines = content.splitlines(keepends=True)
            start = (line or 1) - 1
            content = "".join(lines[start:] if limit is None else lines[start : start + limit])
        return ReadTextFileResponse(content=content)

    async def write_text_file(
        self,
        session_id: str,
        path: str,
        content: str,
        **_kwargs: Any,
    ) -> WriteTextFileResponse:
        """响应 agent 的 ``fs/write_text_file`` 请求, 写入工作区内文本文件。

        由 agent-client-protocol 框架在 agent 请求写文件时调用。
        参数:
            session_id: ACP session id, 由框架传入。
            path: 目标文件路径, 由 agent 提供; 经 ``_workspace_path`` 校验
                必须位于项目根目录内, 缺失的父目录会自动创建。
            content: 要写入的完整文本, 由 agent 提供。
            **_kwargs: 框架附加的扩展字段, 忽略。
        返回:
            空的 ``WriteTextFileResponse``, 由框架回传给 agent 进程表示成功。
        """
        file_path = self._workspace_path(path)
        await asyncio.to_thread(file_path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(file_path.write_text, content, encoding="utf-8")
        return WriteTextFileResponse()

    def _workspace_path(self, value: str) -> Path:
        """将 agent 给出的路径解析为绝对路径并限制在项目根目录内。

        参数:
            value: 来自 ``read_text_file`` / ``write_text_file`` 的 agent 侧路径。
        返回:
            已 resolve 的 ``Path``; 路径越出项目根目录时抛出 ``PermissionError``。
        """
        path = Path(value)
        if not path.is_absolute():
            path = self._root / path
        path = path.resolve()
        if not path.is_relative_to(self._root):
            raise PermissionError(f"ACP file access is outside the project: {path}")
        return path


@dataclass(slots=True)
class _AcpRuntime:
    """单个 ACP session 的运行时状态(connection / 进程 manager / host / 锁)。

    由 ``AcpProvider.create_session`` / ``resume_session`` 创建并存入
    ``AcpProvider._sessions``, 在 ``prompt`` / ``cancel`` / ``close`` 中消费。
    """

    connection: Any
    manager: AbstractAsyncContextManager[Any]
    host: _AcpClientHost
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: bool = False


class AcpProvider:
    """基于 agent-client-protocol 的通用 provider, 实现 ``AgentProvider`` 协议。

    由 ``create_provider``(factory.py) 按 ``acp`` 类型配置实例化并注册进
    ``AgentAdapter``; 上层通过 ``AgentAdapter`` 调用其 create/prompt/close 等方法。
    """

    def __init__(self, name: str, spec: AcpAgentSpec) -> None:
        """初始化 provider。

        参数:
            name: provider 名称, 来自 settings 中 providers 字典的 key
                (由 ``create_provider`` 传入)。
            spec: ACP agent 启动规格, 由 ``create_provider`` 根据配置构造。
        """
        self.name = name
        self._spec = spec
        self._sessions: dict[str, _AcpRuntime] = {}

    async def list_models(self, project_path: str) -> tuple[HarnessModel, ...]:
        """Read the model select option exposed by a short-lived ACP session."""
        if not self._spec.model_config_id:
            return ()
        resolved_path = str(Path(project_path).expanduser().resolve())
        connection, manager, _host, _initialize = await self._connect(resolved_path)
        try:
            created = await connection.new_session(cwd=resolved_path, mcp_servers=[])
            target = next(
                (
                    option
                    for option in (created.config_options or [])
                    if str(getattr(option, "id", "")) == self._spec.model_config_id
                ),
                None,
            )
            if target is None:
                raise ValueError(
                    f"ACP provider {self.name!r} did not expose config option "
                    f"{self._spec.model_config_id!r}."
                )
            payload = target.model_dump(mode="json", by_alias=True, exclude_none=True)
            current = str(payload.get("currentValue") or payload.get("current_value") or "")
            return tuple(
                HarnessModel(
                    id=value,
                    display_name=label,
                    description=description,
                    is_default=value == current,
                    default_effort=None,
                    supported_efforts=(),
                )
                for value, label, description in self._select_options(payload.get("options", []))
            )
        finally:
            await manager.__aexit__(None, None, None)

    @classmethod
    def _select_options(cls, options: list[Any]) -> list[tuple[str, str, str]]:
        result: list[tuple[str, str, str]] = []
        for option in options:
            if not isinstance(option, dict):
                continue
            nested = option.get("options")
            if isinstance(nested, list):
                result.extend(cls._select_options(nested))
                continue
            value = str(option.get("value") or "").strip()
            if not value:
                continue
            result.append(
                (
                    value,
                    str(option.get("name") or value),
                    str(option.get("description") or ""),
                )
            )
        return result

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        """启动 agent 进程并创建新的 ACP session。

        由 ``AgentAdapter.create_session``(cleo/harnesses/adapter.py) 调用。
        参数:
            project_path: 项目工作目录, 由 AgentAdapter 传入, 作为 agent 进程
                的 cwd 及 session 的 cwd。
            model: 可选模型 id, 由 AgentAdapter 传入; 仅当 spec 配置了
                ``model_config_id`` 时通过 ``set_config_option`` 下发给 agent。
        返回:
            ``ProviderSession``, id 与 native_id 均为 ACP session id;
            由 AgentAdapter 记录并用于后续 ``prompt`` / ``close`` 路由。
        """
        connection, manager, host, _initialize = await self._connect(project_path)
        try:
            created = await connection.new_session(cwd=project_path, mcp_servers=[])
            if model and self._spec.model_config_id:
                await connection.set_config_option(
                    self._spec.model_config_id,
                    created.session_id,
                    model,
                )
        except Exception:
            await manager.__aexit__(None, None, None)
            raise

        self._sessions[created.session_id] = _AcpRuntime(connection, manager, host)
        return ProviderSession(id=created.session_id, native_id=created.session_id)

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        """启动 agent 进程并通过 ``session/load`` 恢复既有 session。

        由 ``AgentAdapter.resume_session`` 调用。
        参数:
            native_session_id: 原生 session id, 由 AgentAdapter 从 session
                store 中取出传入。
            project_path: 项目工作目录, 由 AgentAdapter 传入。
            model: 可选模型 id(当前实现未使用, 仅为满足协议签名)。
        返回:
            ``ProviderSession``(id == native_session_id), 由 AgentAdapter 消费;
            agent 不支持 ``load_session`` capability 时抛 ``ValueError``。
        """
        connection, manager, host, initialize = await self._connect(project_path)
        capabilities = initialize.agent_capabilities
        if capabilities is None or not capabilities.load_session:
            await manager.__aexit__(None, None, None)
            raise ValueError(f"ACP provider {self.name} does not support session/load")
        try:
            await connection.load_session(
                cwd=project_path,
                session_id=native_session_id,
                mcp_servers=[],
            )
        except Exception:
            await manager.__aexit__(None, None, None)
            raise

        self._sessions[native_session_id] = _AcpRuntime(connection, manager, host)
        return ProviderSession(id=native_session_id, native_id=native_session_id)

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        """向指定 session 发送一次 prompt 并等待 turn 完成。

        由 ``AgentAdapter.prompt`` 调用; 同一 session 通过锁串行执行。
        参数:
            session_id: ``create_session`` / ``resume_session`` 返回的 session id。
            prompt: 用户输入文本, 由 AgentAdapter 传入, 包装为 ACP text block。
            on_event: 实时事件回调, 由 AgentAdapter 传入, 转发给
                ``_AcpClientHost`` 在 ``session_update`` 中触发。
        返回:
            ``ProviderTurn``, 含聚合响应文本、本 turn 全部 ``AgentEvent`` 及
            由 stop_reason 映射的 status; 由 AgentAdapter 持久化并返回给 CLI。
        """
        runtime = self._sessions[session_id]
        async with runtime.lock:
            runtime.host.begin_turn(on_event)
            runtime.active = True
            try:
                result = await runtime.connection.prompt(session_id, [text_block(prompt)])
            finally:
                runtime.active = False

        return ProviderTurn(
            native_session_id=session_id,
            turn_id=f"acp_{secrets.token_hex(6)}",
            status="completed" if result.stop_reason == "end_turn" else result.stop_reason,
            response="".join(runtime.host.response_parts) or None,
            events=tuple(runtime.host.events),
        )

    async def cancel(self, session_id: str) -> None:
        """取消 session 中正在运行的 turn。

        由 ``AgentAdapter.cancel`` 调用。
        参数:
            session_id: 目标 session id, 由 AgentAdapter 传入; 仅当该 session
                当前处于 active(prompt 进行中)时向 agent 发送 cancel 通知。
        """
        runtime = self._sessions[session_id]
        if runtime.active:
            await runtime.connection.cancel(session_id)

    async def close(self, session_id: str) -> None:
        """关闭 session 并终止 agent 子进程。

        由 ``AgentAdapter.close`` / ``AgentAdapter.aclose`` 调用。
        参数:
            session_id: 目标 session id; 若 session 不存在则静默返回,
                若 turn 仍在运行则先 cancel, 再退出进程 context manager。
        """
        runtime = self._sessions.pop(session_id, None)
        if runtime is None:
            return
        if runtime.active:
            await runtime.connection.cancel(session_id)
        await runtime.manager.__aexit__(None, None, None)

    async def _connect(self, project_path: str) -> tuple[Any, Any, _AcpClientHost, Any]:
        """spawn agent 子进程并完成 ACP initialize/authenticate 握手。

        参数:
            project_path: 项目工作目录, 来自 ``create_session`` /
                ``resume_session``, 作为子进程 cwd 及 host 的文件访问根。
        返回:
            ``(connection, manager, host, initialized)`` 四元组: connection 为
            ACP ClientSideConnection(供 new/load/prompt 调用), manager 为子进程
            async context manager(供 close 时退出), host 为 client 宿主,
            initialized 为 initialize 响应(``resume_session`` 用其检查
            capabilities); 任一阶段失败时清理子进程并向上抛出异常。
        """
        host = _AcpClientHost(self.name, project_path, self._spec.auto_approve)
        environment = {**os.environ, **self._spec.env}
        manager = spawn_agent_process(
            host,
            self._spec.command,
            *self._spec.args,
            env=environment,
            cwd=project_path,
        )
        connection, _process = await manager.__aenter__()
        try:
            initialized = await connection.initialize(
                PROTOCOL_VERSION,
                client_capabilities=ClientCapabilities(
                    fs=FileSystemCapabilities(read_text_file=True, write_text_file=True),
                    terminal=False,
                ),
                client_info=Implementation(name="cleo", title="Cleo", version="0.1.0"),
            )
            if self._spec.auth_method:
                await connection.authenticate(self._spec.auth_method)
        except Exception:
            await manager.__aexit__(None, None, None)
            raise
        return connection, manager, host, initialized
