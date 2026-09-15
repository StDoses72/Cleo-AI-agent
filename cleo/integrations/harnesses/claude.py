from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from cleo.harnesses.control import HarnessModel, SessionOptions
from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.harnesses.questions import QuestionBroker, normalize_questions
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.integrations.runtime_diagnostics import diagnostic_text

ClaudePermissionMode = Literal[
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
    "dontAsk",
    "auto",
]
"""Claude Agent SDK 支持的 permission mode 取值集合。"""

CLAUDE_EFFORTS = ("low", "medium", "high", "xhigh", "max")
"""Claude Agent SDK 公开的 effort 档位。"""


@dataclass(slots=True)
class _ClaudeRuntime:
    """单个 Claude session 的运行时状态(SDK client / 原生 session id / 锁)。

    由 ``ClaudeProvider._connect`` 创建并存入 ``ClaudeProvider._sessions``,
    在 ``prompt`` / ``cancel`` / ``close`` 中消费。
    """

    client: ClaudeSDKClient
    options: SessionOptions
    cwd: str
    native_session_id: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: bool = False
    context_binding: Any = None
    questions: QuestionBroker = field(default_factory=lambda: QuestionBroker("claude"))


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
        models: tuple[str, ...] = (),
        memory_mcp: MemoryMcp | None = None,
    ) -> None:
        """初始化 provider。

        参数:
            default_model: 默认模型 id, 来自 settings 中该 provider 的
                ``model`` 字段(由 ``create_provider`` 传入)。
            permission_mode: 权限模式, 来自配置 ``options.permission_mode``。
            name: provider 名称, 来自 settings providers 字典的 key。
        """
        self.name = name
        self._memory_mcp = memory_mcp
        self._default_model = default_model
        self._models = tuple(dict.fromkeys([*([default_model] if default_model else []), *models]))
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

    async def validate_handoff(self, session_id: str) -> None:
        """Check the SDK's actual CLI login without submitting a model/tool turn."""
        from cleo.integrations.claude_cli import process_options, stop_process

        runtime = self._sessions[session_id]
        transport = getattr(runtime.client, "_transport", None)
        cli = getattr(transport, "_cli_path", None)
        if not cli:
            raise RuntimeError("无法确认 Claude SDK 的登录状态，原 harness 保持不变。")
        process = await asyncio.create_subprocess_exec(
            str(cli),
            "auth",
            "status",
            cwd=runtime.cwd,
            env=dict(os.environ),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **process_options(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
            try:
                status = json.loads(stdout)
            except (ValueError, UnicodeDecodeError):
                status = None
            if (
                process.returncode
                or not isinstance(status, dict)
                or status.get("loggedIn") is not True
            ):
                detail = diagnostic_text(stderr.decode("utf-8", errors="replace"))
                raise ValueError("Claude 登录检查未通过，原 harness 保持不变。" + detail)
        finally:
            await stop_process(process)

    async def create_context_session(self, project_path, model, binding):
        if self._memory_mcp is None:
            raise ValueError("Claude context reader is not configured")
        session_id = f"claude_{secrets.token_hex(6)}"
        self._sessions[session_id] = await self._connect(project_path, model, context=binding)
        return ProviderSession(id=session_id)

    async def resume_context_session(self, native_id, project_path, model, binding):
        if self._memory_mcp is None:
            raise ValueError("Claude context reader is not configured")
        runtime = await self._connect(project_path, model, resume=native_id, context=binding)
        runtime.native_session_id = native_id
        session_id = f"claude_{secrets.token_hex(6)}"
        self._sessions[session_id] = runtime
        return ProviderSession(id=session_id, native_id=native_id)

    def session_options(self, session_id: str) -> SessionOptions:
        """Return the model and effort currently applied to a Claude session."""
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
        """Apply Claude model, effort, and permission changes to later turns."""
        runtime = self._sessions[session_id]
        if effort is not None and effort not in CLAUDE_EFFORTS:
            raise ValueError(f"Unsupported Claude effort: {effort}")
        if sandbox is not None:
            raise ValueError("Claude Agent SDK does not expose a sandbox option.")

        current = runtime.options
        next_model = current.model if model is None else model
        next_effort = current.effort if effort is None else effort
        next_permission = current.approval_mode if approval_mode is None else approval_mode
        if next_permission is not None and next_permission not in ClaudePermissionMode.__args__:
            raise ValueError(f"Unsupported Claude permission mode: {next_permission}")

        async with runtime.lock:
            if effort is not None and effort != current.effort:
                replacement = await self._connect(
                    runtime.cwd,
                    next_model,
                    effort=next_effort,
                    resume=runtime.native_session_id,
                    permission_mode=next_permission,
                    **({"context": runtime.context_binding} if runtime.context_binding else {}),
                )
                await runtime.client.disconnect()
                runtime.client = replacement.client
                replacement.questions.enabled = runtime.questions.enabled
                runtime.questions = replacement.questions
            elif model is not None and model != current.model:
                await runtime.client.set_model(model)
            if approval_mode is not None and approval_mode != current.approval_mode:
                await runtime.client.set_permission_mode(approval_mode)
            runtime.options = SessionOptions(
                model=next_model,
                effort=next_effort,
                approval_mode=next_permission,
            )
        return runtime.options

    async def list_models(self, project_path: str = ".") -> tuple[HarnessModel, ...]:
        """Purpose: Combine live Claude choices with explicitly configured model IDs.

        Input: Project directory used by the discovery session.
        Output: Selectable models; connection errors remain visible to the caller.
        """
        from cleo.integrations.harnesses.claude_models import discover_claude_models

        discovered = await discover_claude_models(project_path)
        models = {model.id: model for model in discovered}
        configured = tuple(
            HarnessModel(
                id=model,
                display_name=model,
                description="Configured in harnesses.json",
                is_default=model == self._default_model,
                default_effort="high",
                supported_efforts=CLAUDE_EFFORTS,
            )
            for model in self._models
        )
        for model in configured:
            models.setdefault(model.id, model)
        if not models:
            models["default"] = HarnessModel(
                id="default",
                display_name="Claude 默认模型",
                is_default=True,
                description="当前 Claude 未提供模型目录，使用其默认模型",
                default_effort=None,
                supported_efforts=(),
            )
        return tuple(models.values())

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        """Purpose: Consume a serialized SDK turn, including user-wrapped tool results.
        Input: Logical session ID, user prompt and optional event callback.
        Output: ProviderTurn with native ID, events and redacted terminal errors;
            raises RuntimeError if the SDK ends without a ResultMessage.
        """
        runtime = self._sessions[session_id]
        events: list[AgentEvent] = []
        response_parts: list[str] = []
        result_message: ResultMessage | None = None

        async with runtime.lock:
            runtime.active = True

            async def question_event(event):
                events.append(event)
                await emit_event(on_event, event)

            runtime.questions.bind(
                question_event if runtime.questions.enabled and on_event else None,
            )
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
                    elif isinstance(message, UserMessage) and isinstance(message.content, list):
                        # SDK tool results arrive as user messages, not assistant blocks.
                        for block in message.content:
                            if isinstance(block, ToolResultBlock):
                                event = self._block_event(block)
                                events.append(event)
                                await emit_event(on_event, event)
                    elif isinstance(message, ResultMessage):
                        result_message = message
                        runtime.native_session_id = message.session_id
            finally:
                await runtime.questions.cancel_all()
                runtime.questions.callback = None
                runtime.active = False

        if result_message is None:
            raise RuntimeError("Claude Agent SDK did not return a ResultMessage")
        response = result_message.result or "".join(response_parts) or None
        error = None
        if result_message.is_error:
            error = diagnostic_text(
                "; ".join(result_message.errors or [])
                or result_message.result
                or f"Claude SDK result: {result_message.subtype}",
                prompt=prompt,
            )
        status = "failed" if result_message.is_error else "completed"
        if result_message.stop_reason == "cancelled":
            status = "cancelled"
        if status != "completed":
            response = None
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
        await runtime.questions.cancel_all()
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
        await runtime.questions.cancel_all()
        if runtime.active:
            await runtime.client.interrupt()
        await runtime.client.disconnect()

    async def resolve_question(self, session_id: str, question_id: str, answers: dict) -> dict:
        return await self._sessions[session_id].questions.resolve(question_id, answers)

    def pending_questions(self, session_id: str) -> list[dict]:
        return self._sessions[session_id].questions.list_pending()

    async def enable_questions(self, session_id: str) -> None:
        self._sessions[session_id].questions.enabled = True

    async def _connect(
        self,
        project_path: str,
        model: str | None,
        effort: str | None = None,
        resume: str | None = None,
        permission_mode: ClaudePermissionMode | None = None,
        context=None,
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
        questions = QuestionBroker(self.name)

        async def ask_hook(input_data, _tool_use_id, _context):
            # AskUserQuestion must reach the callback even under permissive tool policies.
            return {
                "hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask"}
            }

        async def can_use_tool(tool_name, input_data, context):
            if (
                memory
                and memory.context
                and tool_name
                in {
                    "mcp__cleo_context__read_context",
                    "mcp__cleo_context__search_context",
                }
            ):
                # The process-bound reader validates scope and arguments. This grant
                # neither changes general memory access nor authorizes file/command tools.
                return PermissionResultAllow(updated_input=input_data)
            if tool_name != "AskUserQuestion":
                return PermissionResultDeny(message="此工具需要权限确认；请使用支持的审批入口。")
            try:
                normalized = normalize_questions(input_data.get("questions"), claude=True)
            except ValueError as exc:
                return PermissionResultDeny(message=str(exc))
            answers = await questions.ask(
                normalized,
                native_id=str(getattr(context, "tool_use_id", "") or ""),
            )
            if answers is None:
                return PermissionResultDeny(message="用户未提交答案。请在对话中重新询问。")
            return PermissionResultAllow(
                updated_input={
                    **input_data,
                    "answers": {q["question"]: ", ".join(answers[q["id"]]) for q in normalized},
                }
            )

        memory = (
            self._memory_mcp.for_context(context)
            if context and self._memory_mcp
            else self._memory_mcp
        )
        options = ClaudeAgentOptions(
            cwd=project_path,
            # Native discovery keeps explicit-only and automatic skills distinct.
            setting_sources=["user", "project"],
            model=model or self._default_model,
            effort=effort,
            permission_mode=permission_mode or self._permission_mode,
            resume=resume,
            mcp_servers=memory.claude_servers() if memory else {},
            can_use_tool=can_use_tool,
            hooks={"PreToolUse": [HookMatcher(matcher="AskUserQuestion", hooks=[ask_hook])]},
        )
        client = ClaudeSDKClient(options=options)
        await client.connect()
        if self._memory_mcp:
            try:
                async with asyncio.timeout(30):
                    while True:
                        status = await client.get_mcp_status()
                        expected = {"cleo_memory", "cleo_context"} if context else {"cleo_memory"}
                        servers = [s for s in status["mcpServers"] if s["name"] in expected]
                        if len(servers) == len(expected) and all(
                            s["status"] == "connected" for s in servers
                        ):
                            break
                        server = next(
                            (s for s in servers if s["status"] not in {"pending", "connected"}),
                            None,
                        )
                        if server:
                            raise RuntimeError(
                                "Cleo memory MCP failed to connect: "
                                + diagnostic_text(
                                    str(server["status"]) + "; " + str(server.get("error") or "")
                                )
                            )
                        await asyncio.sleep(0.1)
            except BaseException:
                await client.disconnect()
                raise
        return _ClaudeRuntime(
            client=client,
            options=SessionOptions(
                model=model or self._default_model,
                effort=effort,
                approval_mode=permission_mode or self._permission_mode,
            ),
            cwd=project_path,
            questions=questions,
            context_binding=context,
        )

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
