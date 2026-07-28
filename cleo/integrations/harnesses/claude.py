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

from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn

ClaudePermissionMode = Literal[
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
    "auto",
]
"""Claude Agent SDK 支持的 permission mode 取值集合。"""


@dataclass(slots=True)
class _ClaudeRuntime:
    """单个 Claude session 的运行时状态(SDK client / 原生 session id / 锁)。

    由 ``ClaudeProvider._connect`` 创建并存入 ``ClaudeProvider._sessions``,
    在 ``prompt`` / ``cancel`` / ``close`` 中消费。
    """

    client: ClaudeSDKClient
    native_session_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: bool = False


class ClaudeProvider:
    """基于 claude-agent-sdk 的 provider, 实现 ``AgentProvider`` 协议。

    由 ``create_provider``(factory.py) 按 ``claude_sdk`` 类型配置实例化并
    注册进 ``AgentAdapter``; 上层通过 ``AgentAdapter`` 调用其会话方法。
    """

    name = "claude"

    def __init__(
        self,
        default_model: str | None = None,
        permission_mode: ClaudePermissionMode = "acceptEdits",
        *,
        name: str = "claude",
    ) -> None:
        """初始化 provider。

        参数:
            default_model: 默认模型 id, 来自 settings 中该 provider 的
                ``model`` 字段(由 ``create_provider`` 传入)。
            permission_mode: 权限模式, 来自配置 ``options.permission_mode``。
            name: provider 名称, 来自 settings providers 字典的 key。
        """
        self.name = name
        self._default_model = default_model
        self._permission_mode = permission_mode
        self._sessions: dict[str, _ClaudeRuntime] = {}

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        """连接一个新的 Claude SDK client, 建立逻辑 session。

        由 ``AgentAdapter.create_session`` 调用。
        参数:
            project_path: 项目工作目录, 由 AgentAdapter 传入, 作为 SDK cwd。
            model: 可选模型 id, 由 AgentAdapter 传入, 覆盖 ``default_model``。
        返回:
            ``ProviderSession``, id 为本地生成的 ``claude_<hex>``(原生
            session id 需等首个 turn 的 ResultMessage 才知道); 由
            AgentAdapter 记录并用于后续 ``prompt`` 路由。
        """
        session_id = f"claude_{secrets.token_hex(6)}"
        self._sessions[session_id] = await self._connect(project_path, model)
        return ProviderSession(id=session_id)

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        """以 resume 模式连接 SDK client, 恢复既有原生 session。

        由 ``AgentAdapter.resume_session`` 调用。
        参数:
            native_session_id: Claude 原生 session id, 由 AgentAdapter 从
                session store 取出传入, 透传给 SDK 的 ``resume`` 选项。
            project_path: 项目工作目录, 由 AgentAdapter 传入。
            model: 可选模型 id, 由 AgentAdapter 传入。
        返回:
            ``ProviderSession``, id 为本地生成的新逻辑 id, native_id 为传入的
            原生 session id; 由 AgentAdapter 记录并用于后续路由。
        """
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
        """发送一次 query 并流式消费 SDK 消息直至 turn 结束。

        由 ``AgentAdapter.prompt`` 调用; 同一 session 通过锁串行执行。
        参数:
            session_id: ``create_session`` / ``resume_session`` 返回的逻辑 id。
            prompt: 用户输入文本, 由 AgentAdapter 传入, 交给 SDK ``query``。
            on_event: 实时事件回调, 由 AgentAdapter 传入, 每个消息 block
                转换出的 ``AgentEvent`` 都会推送给它。
        返回:
            ``ProviderTurn``, status/response/error 取自 SDK ResultMessage,
            events 为本 turn 全部事件; 由 AgentAdapter 持久化并返回给 CLI。
            SDK 未返回 ResultMessage 时抛 ``RuntimeError``。
        """
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
        """中断 session 中正在运行的 turn。

        由 ``AgentAdapter.cancel`` 调用。
        参数:
            session_id: 目标逻辑 session id; 仅当 turn 处于 active 时调用
                SDK 的 ``interrupt``。
        """
        runtime = self._sessions[session_id]
        if runtime.active:
            await runtime.client.interrupt()

    async def close(self, session_id: str) -> None:
        """断开 SDK client 连接并移除 session。

        由 ``AgentAdapter.close`` / ``AgentAdapter.aclose`` 调用。
        参数:
            session_id: 目标逻辑 session id; 不存在则静默返回, turn 运行中
                则先 interrupt 再 disconnect。
        """
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
        """创建并连接一个 ``ClaudeSDKClient``。

        参数:
            project_path: 项目工作目录, 来自 ``create_session`` /
                ``resume_session``。
            model: 模型 id; 为 None 时回落到 ``default_model``。
            resume: 原生 session id, 由 ``resume_session`` 传入, 用于恢复会话。
        返回:
            ``_ClaudeRuntime``, 由调用方登记进 ``_sessions``。
        """
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
        """把 SDK 消息 block 映射为统一的 ``AgentEvent``。

        参数:
            block: SDK AssistantMessage content 中的单个 block(TextBlock /
                ThinkingBlock / ToolUseBlock / ToolResultBlock 等), 来自
                ``prompt`` 的流式消息循环。
        返回:
            对应的 ``AgentEvent``; 未识别的 block 类型返回 None(调用方跳过)。
        """
        if isinstance(block, TextBlock):
            return AgentEvent(provider=self.name, type="agent_message", text=block.text)
        if isinstance(block, ThinkingBlock):
            return AgentEvent(provider=self.name, type="thought", text=block.thinking)
        if isinstance(block, ToolUseBlock):
            return AgentEvent(provider=self.name, type="tool_call", data=asdict(block))
        if isinstance(block, ToolResultBlock):
            return AgentEvent(provider=self.name, type="tool_result", data=asdict(block))
        return None
