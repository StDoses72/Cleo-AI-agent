from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
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
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from cleo.harnesses.approvals import PermissionBroker
from cleo.harnesses.capabilities import Capability
from cleo.harnesses.control import HarnessModel, SessionOptions
from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.harnesses.questions import QuestionBroker, normalize_questions
from cleo.harnesses.rewind import CLAUDE_TRANSCRIPT_SCRIPT, locate_turn
from cleo.i18n import tr
from cleo.integrations.harness_home import (
    CLAUDE_LOGIN_HINT,
    claude_environment,
    claude_session_is_external,
)
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.integrations.runtime_diagnostics import CLAUDE_MESSAGE_BUFFER_BYTES, diagnostic_text

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

BACKGROUND_WAIT_ENV = "CLEO_CLAUDE_BACKGROUND_WAIT_SECONDS"
DEFAULT_BACKGROUND_WAIT_SECONDS = 600.0
"""How long a turn keeps waiting, after a stage result, for background tasks to wake Claude.

A Claude Code turn ends with a ``ResultMessage`` even while ``Bash(run_in_background=True)``
or background agents keep running. When one of them finishes, the CLI wakes the model for a
follow-up turn on the same stream (no new user input). The wait is counted between frames;
any frame restarts it. ``0`` disables waiting: such a turn ends at its first result and the
background tasks end with the stream so their later output can never be attributed to a
later user turn.
"""

_TERMINAL_TASK_STATUSES = {"completed", "failed", "stopped", "killed", "cancelled"}


def background_wait_seconds() -> float:
    """Purpose: Read the background wait ceiling from the environment, with a safe default."""
    raw = os.environ.get(BACKGROUND_WAIT_ENV, "").strip()
    if not raw:
        return DEFAULT_BACKGROUND_WAIT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_BACKGROUND_WAIT_SECONDS
    return value if value >= 0 else DEFAULT_BACKGROUND_WAIT_SECONDS


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
    needs_reconnect: bool = False
    context_binding: Any = None
    questions: QuestionBroker = field(default_factory=lambda: QuestionBroker("claude"))
    approvals: PermissionBroker = field(default_factory=lambda: PermissionBroker("claude"))
    permission_verified: bool = False
    # Sessions created before isolation keep resuming from the user's own Claude directory.
    external_home: bool = False
    # Identifies this session's computer MCP server to the desktop broker.
    computer_client: str = ""
    # Native background tasks (task_id -> description/type) still running for this turn.
    background: dict[str, dict[str, Any]] = field(default_factory=dict)
    # True between a stage ResultMessage and the follow-up turn its background tasks owe.
    waiting: bool = False
    # Set by cancel/close while waiting: the stream was dropped on purpose, not by a crash.
    wait_abandoned: bool = False


class ClaudeProvider:
    """基于 claude-agent-sdk 的 provider, 实现 ``AgentProvider`` 协议。

    由 ``create_provider``(factory.py) 按 ``claude_sdk`` 类型配置实例化并
    注册进 ``AgentAdapter``; 上层通过 ``AgentAdapter`` 调用其会话方法。
    """

    name = "claude"
    provider_type = "claude_sdk"
    capabilities = frozenset({
        Capability.REWIND, Capability.QUESTIONS, Capability.USER_APPROVALS,
    })

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
        from cleo.integrations.harness_migration import check_resume_migration

        check_resume_migration("claude", native_session_id)
        runtime = await self._connect(
            project_path, model, resume=native_session_id,
            external_home=claude_session_is_external(native_session_id),
        )
        runtime.native_session_id = native_session_id
        session_id = f"claude_{secrets.token_hex(6)}"
        self._sessions[session_id] = runtime
        return ProviderSession(id=session_id, native_id=native_session_id)

    async def validate_handoff(self, session_id: str) -> None:
        """Check the SDK's actual CLI login without submitting a model/tool turn."""
        from cleo.integrations.claude_cli import process_options, stop_process

        runtime = self._sessions[session_id]
        external = getattr(runtime, "external_home", False)
        transport = getattr(runtime.client, "_transport", None)
        cli = getattr(transport, "_cli_path", None)
        if not cli:
            raise RuntimeError(tr("claude.could_not_confirm_claude_sdk_sign_in_status_the_"))
        process = await asyncio.create_subprocess_exec(
            str(cli),
            "auth",
            "status",
            cwd=runtime.cwd,
            env=claude_environment(dict(os.environ), external=external),
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
                raise ValueError(
                    tr("claude.claude_sign_in_checks_failed_the_original_harnes")
                    + ("" if external else CLAUDE_LOGIN_HINT) + detail
                )
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
        runtime = await self._connect(
            project_path, model, resume=native_id, context=binding,
            external_home=claude_session_is_external(native_id),
        )
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
        """Purpose: Apply options with native startup flags when permission policy changes.

        Input: Session ID and requested options. Output: Applied options; resumed history is kept.
        """
        runtime = self._sessions[session_id]
        if effort is not None and effort not in CLAUDE_EFFORTS:
            raise ValueError(f"Unsupported Claude effort: {effort}")
        if sandbox is not None:
            raise ValueError("Claude Agent SDK does not expose a sandbox option.")

        if approval_mode is not None and approval_mode not in ClaudePermissionMode.__args__:
            raise ValueError(f"Unsupported Claude permission mode: {approval_mode}")

        async with runtime.lock:
            current = runtime.options
            next_model = current.model if model is None else model
            next_effort = current.effort if effort is None else effort
            next_permission = current.approval_mode if approval_mode is None else approval_mode
            reconnect = runtime.needs_reconnect or (
                effort is not None and effort != current.effort
            ) or (
                next_permission != current.approval_mode
                and "bypassPermissions" in {next_permission, current.approval_mode}
            )
            # Claude rejects entering bypass mode unless its process launched with that flag.
            # Leaving it also gets a fresh process without the permissive startup option.
            if reconnect:
                await self._reconnect_runtime(runtime, next_model, next_effort, next_permission)
            elif model is not None and model != current.model:
                await runtime.client.set_model(model)
            if not reconnect and approval_mode is not None \
                    and approval_mode != current.approval_mode:
                await runtime.client.set_permission_mode(approval_mode)
            runtime.options = SessionOptions(
                model=next_model,
                effort=next_effort,
                approval_mode=next_permission,
            )
        return runtime.options

    async def _reconnect_runtime(self, runtime, model, effort, permission_mode):
        """Purpose: Replace an SDK stream while retaining history, scope and UI brokers.

        Input: Existing runtime and desired launch options. Output: Fresh connected process.
        """
        replacement = await self._connect(
            runtime.cwd, model, effort=effort, resume=runtime.native_session_id,
            permission_mode=permission_mode,
            **({"context": runtime.context_binding} if runtime.context_binding else {}),
            **({"external_home": True} if runtime.external_home else {}),
        )
        try:
            await runtime.client.disconnect()
        except BaseException:
            await replacement.client.disconnect()
            raise
        runtime.client = replacement.client
        replacement.questions.enabled = runtime.questions.enabled
        runtime.questions = replacement.questions
        replacement.approvals.enabled = runtime.approvals.enabled
        runtime.approvals = replacement.approvals
        runtime.permission_verified = replacement.permission_verified
        runtime.needs_reconnect = False

    async def rewind(self, session_id: str, *, prompt: str, later: list[str],
                     native_turn_id: str | None = None) -> str | None:
        """Purpose: Continue a session from just before one earlier user message.

        Input: Session, the edited turn's prompt and later prompts, oldest first.
        Output: Native ID of a fork truncated before that message, or None when the first
        message was edited; the original transcript is kept.
        """
        runtime = self._sessions[session_id]
        if runtime.active:
            raise RuntimeError(tr("claude.claude_is_still_running_earlier_messages_cannot_"))
        async with runtime.lock:
            source = runtime.native_session_id
            if not source:
                raise ValueError(tr("claude.the_claude_session_has_not_started_earlier_messa"))
            rows = await self._transcript(runtime, {"action": "list", "session": source})
            entries = [(index, row["text"]) for index, row in reversed(list(enumerate(rows)))
                       if row.get("text")]
            index = locate_turn(entries, prompt, later)
            forked = None if index == 0 else (await self._transcript(runtime, {
                "action": "fork", "session": source, "message": rows[index - 1]["uuid"],
            }))["session"]
            runtime.native_session_id = forked
            options = runtime.options
            await self._reconnect_runtime(
                runtime, options.model, options.effort, options.approval_mode,
            )
        return forked

    async def _transcript(self, runtime: _ClaudeRuntime, request: dict[str, Any]) -> Any:
        """Purpose: Read or fork a transcript under this session's Claude directory.

        Input: Runtime and a list/fork request. Output: Parsed script result.
        """
        from cleo.integrations.claude_cli import process_options, stop_process

        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", CLAUDE_TRANSCRIPT_SCRIPT,
            cwd=runtime.cwd,
            env=claude_environment(dict(os.environ), external=runtime.external_home),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            **process_options(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(json.dumps({**request, "cwd": runtime.cwd}).encode()), 60,
            )
        finally:
            await stop_process(process)
        if process.returncode:
            detail = diagnostic_text(stderr.decode("utf-8", errors="replace"))
            raise RuntimeError(tr(
                "claude.could_not_read_the_claude_conversation_record_no",
            ) + detail)
        return json.loads(stdout)

    async def list_models(self, project_path: str = ".") -> tuple[HarnessModel, ...]:
        """Purpose: Combine live Claude choices with explicitly configured model IDs.

        Input: Project directory used by the discovery session.
        Output: Selectable models; connection errors remain visible to the caller.
        """
        from cleo.integrations.harnesses.claude_models import discover_claude_models

        discovered = await discover_claude_models(
            project_path, env=claude_environment(dict(os.environ)),
        )
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
                display_name=tr("claude.claude_default_model"),
                is_default=True,
                description=tr("claude.claude_did_not_provide_a_model_catalog_using_its"),
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
        """Purpose: Consume one user turn plus the follow-up turns its background tasks wake.
        Input: Logical session ID, user prompt and optional event callback.
        Output: ProviderTurn with native ID, events and redacted terminal errors;
            raises RuntimeError if the SDK ends without a ResultMessage.

        A ``ResultMessage`` ends a Claude Code turn, not necessarily the work: background
        shells and agents keep running and, when one finishes, the CLI wakes the model for
        another turn on the same stream. Those stage results, task notifications and the
        final reply all belong to this prompt, so the loop keeps consuming until a result
        arrives with no background task left, the wait ceiling passes, or the run is
        cancelled. Questions and approvals stay answerable across stage boundaries.
        """
        runtime = self._sessions[session_id]
        events: list[AgentEvent] = []
        response_parts: list[str] = []
        result_message: ResultMessage | None = None
        stage = 0
        cancelled_while_waiting = False
        wait_ceiling = background_wait_seconds()

        async with runtime.lock:
            if runtime.needs_reconnect:
                await self._reconnect_runtime(runtime, runtime.options.model,
                                              runtime.options.effort, runtime.options.approval_mode)
            runtime.active = True
            runtime.background.clear()
            runtime.waiting = False
            runtime.wait_abandoned = False

            async def question_event(event):
                events.append(event)
                await emit_event(on_event, event)

            async def publish(event: AgentEvent) -> None:
                events.append(event)
                await emit_event(on_event, event)

            runtime.questions.bind(
                question_event if runtime.questions.enabled and on_event else None,
            )
            runtime.approvals.callback = question_event
            runtime.approvals.reviewed_items.clear()
            try:
                guidance = self._memory_mcp.sync_instructions if self._memory_mcp else ""
                await runtime.client.query(guidance + "\n\n" + prompt if guidance else prompt)
                stream = runtime.client.receive_messages()
                loop = asyncio.get_running_loop()
                deadline = None
                while True:
                    if runtime.waiting:
                        remaining = max(deadline - loop.time(), 0)
                        try:
                            async with asyncio.timeout(remaining):
                                message = await anext(stream)
                        except TimeoutError:
                            await self._abandon_background(
                                runtime, publish, tr(
                                    "claude.background_tasks_exceeded_the_wait_limit",
                                    p0=int(wait_ceiling),
                                ),
                            )
                            break
                        except (StopAsyncIteration, Exception):
                            if not runtime.wait_abandoned:
                                raise
                            cancelled_while_waiting = True
                            await self._abandon_background(
                                runtime, publish,
                                tr("claude.background_task_ended_with_the_run"), disconnect=False,
                            )
                            break
                        # Any frame while waiting (progress, notification, wake-up turn)
                        # restarts the ceiling; the wait counts silence, not total time.
                        deadline = loop.time() + wait_ceiling
                    else:
                        try:
                            message = await anext(stream)
                        except StopAsyncIteration:
                            break
                    if isinstance(message, SystemMessage):
                        if message.subtype == "init":
                            native_id = message.data.get("session_id")
                            if isinstance(native_id, str) and native_id:
                                runtime.native_session_id = native_id
                            # A second init on the same stream opens the follow-up turn.
                            runtime.waiting = False
                        else:
                            await self._track_background(runtime, message, publish)
                    elif isinstance(message, AssistantMessage):
                        runtime.waiting = False
                        for block in message.content:
                            event = self._block_event(block)
                            if event is None:
                                continue
                            events.append(event)
                            if event.type == "agent_message" and event.text:
                                response_parts.append(event.text)
                            await emit_event(on_event, event)
                            if isinstance(block, ToolUseBlock) and block.name == "TodoWrite":
                                todos = block.input.get("todos")
                                if isinstance(todos, list):
                                    plan = AgentEvent(
                                        provider=self.name, type="plan_update", data={"plan": [
                                            {"step": todo.get("content"),
                                             "status": todo.get("status")}
                                            for todo in todos if isinstance(todo, dict)
                                        ]},
                                    )
                                    events.append(plan)
                                    await emit_event(on_event, plan)
                    elif isinstance(message, UserMessage) and isinstance(message.content, list):
                        # SDK tool results arrive as user messages, not assistant blocks.
                        for block in message.content:
                            if isinstance(block, ToolResultBlock):
                                event = self._block_event(block)
                                reviewed = block.tool_use_id in runtime.approvals.reviewed_items
                                if not block.is_error and not reviewed:
                                    event.data["permission"] = {
                                        "source": tr("claude.claude_backend"),
                                        "policy": runtime.options.approval_mode,
                                        "decision": "accept",
                                    }
                                events.append(event)
                                await emit_event(on_event, event)
                    elif isinstance(message, ResultMessage):
                        result_message = message
                        runtime.native_session_id = message.session_id
                        for denial in message.permission_denials or []:
                            if not isinstance(denial, dict):
                                continue
                            item_id = str(denial.get("tool_use_id") or "")
                            if item_id and item_id in runtime.approvals.reviewed_items:
                                continue
                            request = runtime.approvals.request(
                                itemId=item_id, command=str(denial.get("tool_name") or tr(
                                    "claude.tool",
                                )),
                                permissions=denial.get("tool_input"),
                                reason=tr(
                                    "claude.the_backend_permission_policy_denied_this_reques",
                                ),
                            )
                            await runtime.approvals.record(
                                request, "decline", source="native_policy",
                                policy=runtime.options.approval_mode,
                            )
                        if not runtime.background:
                            break
                        if message.is_error or message.stop_reason == "cancelled":
                            # The turn ended abnormally while tasks still run: their later
                            # wake-ups must not be read as the next user turn's reply.
                            await self._abandon_background(
                                runtime, publish, tr("claude.background_task_ended_with_the_run"),
                            )
                            break
                        stage += 1
                        origin = getattr(message, "origin", None)
                        await publish(AgentEvent(
                            provider=self.name, type="status",
                            text=tr(
                                "claude.this_reply_stage_ended_background_tasks_still_r",
                                p0=len(runtime.background),
                            ),
                            data={
                                "provider_event_type": "claude/stage_completed",
                                "payload": {
                                    "stage": stage,
                                    "result": message.result,
                                    "origin": origin if isinstance(origin, dict) else None,
                                    "tasks": [
                                        {"id": task_id, **info}
                                        for task_id, info in runtime.background.items()
                                    ],
                                },
                            },
                        ))
                        if wait_ceiling <= 0:
                            await self._abandon_background(
                                runtime, publish,
                                tr("claude.background_tasks_exceeded_the_wait_limit", p0=0),
                            )
                            break
                        runtime.waiting = True
                        deadline = loop.time() + wait_ceiling
            except BaseException:
                # A stopped or broken stream may retain denials and its final ResultMessage.
                # A later query must resume history on a new stream, never consume that tail.
                runtime.needs_reconnect = True
                await runtime.client.disconnect()
                raise
            finally:
                runtime.waiting = False
                runtime.background.clear()
                await runtime.questions.cancel_all()
                runtime.questions.callback = None
                await runtime.approvals.cancel_all()
                runtime.approvals.callback = None
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
        if result_message.stop_reason == "cancelled" or cancelled_while_waiting:
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

    async def _track_background(
        self, runtime: _ClaudeRuntime, message: SystemMessage, publish,
    ) -> None:
        """Purpose: Mirror the CLI's background-task frames into the turn's tool items.

        Input: A non-init ``SystemMessage`` and the turn's event publisher. Output: None.
        ``task_started`` (backgrounded) and ``background_tasks_changed`` register tasks as
        running tool items; ``task_notification`` and a terminal ``task_updated`` close them
        with the CLI's summary. Other system frames (progress, hooks, token counts) are ignored.
        """
        data = message.data if isinstance(message.data, dict) else {}
        subtype = message.subtype
        if subtype == "task_started":
            task_id = str(data.get("task_id") or "")
            if data.get("is_backgrounded") and task_id and task_id not in runtime.background:
                await self._background_started(runtime, publish, data)
        elif subtype == "background_tasks_changed":
            tasks = data.get("tasks")
            if not isinstance(tasks, list):
                return
            live = {str(task["task_id"]): task for task in tasks
                    if isinstance(task, dict) and task.get("task_id")}
            for task_id, task in live.items():
                if task_id not in runtime.background:
                    await self._background_started(runtime, publish, task)
            for task_id in [task_id for task_id in runtime.background if task_id not in live]:
                await self._background_finished(
                    runtime, publish, task_id,
                    runtime.background[task_id].get("status") or "completed",
                    tr("claude.background_task_finished"),
                )
        elif subtype == "task_notification":
            task_id = str(data.get("task_id") or "")
            if task_id in runtime.background:
                status = str(data.get("status") or "completed")
                await self._background_finished(
                    runtime, publish, task_id, status, str(data.get("summary") or status),
                )
        elif subtype == "task_updated":
            patch = data.get("patch")
            status = patch.get("status") if isinstance(patch, dict) else None
            task_id = str(data.get("task_id") or "")
            if status in _TERMINAL_TASK_STATUSES and task_id in runtime.background:
                # The notification (with the CLI's summary) or the next snapshot closes
                # the item; until then the task still owes the model a wake-up turn.
                runtime.background[task_id]["status"] = str(status)

    async def _background_started(self, runtime, publish, task: dict[str, Any]) -> None:
        task_id = str(task["task_id"])
        info = {
            "description": str(task.get("description") or ""),
            "task_type": str(task.get("task_type") or ""),
            "tool_use_id": str(task.get("tool_use_id") or ""),
        }
        runtime.background[task_id] = info
        await publish(AgentEvent(provider=self.name, type="tool_call", data={
            "id": task_id,
            "name": tr("claude.background_task"),
            "input": info["description"] or info["task_type"] or task_id,
            "task_type": info["task_type"],
            "tool_use_id": info["tool_use_id"],
            "provider_event_type": "task_started",
        }))

    async def _background_finished(
        self, runtime, publish, task_id: str, status: str, summary: str,
    ) -> None:
        info = runtime.background.pop(task_id, {})
        failed = status not in {"completed", "success"}
        await publish(AgentEvent(provider=self.name, type="tool_result", data={
            "tool_use_id": task_id,
            "output": summary,
            "status": "failed" if failed else "completed",
            "task_status": status,
            "task_type": info.get("task_type", ""),
            "provider_event_type": "task_notification",
        }))

    async def _abandon_background(
        self, runtime, publish, reason: str, *, disconnect: bool = True,
    ) -> None:
        """Purpose: End a turn whose background tasks will not be waited for any longer.

        Input: Runtime with tasks still registered and the user-facing reason. Output: None.
        The remaining tasks are closed as failed tool items and the stream is dropped (unless
        cancel/close already did) so the CLI's later wake-ups cannot leak into a later prompt;
        the next prompt resumes the native history on a fresh process.
        """
        for task_id in list(runtime.background):
            await self._background_finished(runtime, publish, task_id, "stopped", reason)
        await publish(AgentEvent(
            provider=self.name, type="status", text=reason,
            data={"provider_event_type": "claude/background_abandoned", "payload": {}},
        ))
        runtime.waiting = False
        runtime.needs_reconnect = True
        if disconnect:
            await runtime.client.disconnect()

    async def cancel(self, session_id: str) -> None:
        """中断 session 中正在运行的 turn。

        由 ``AgentAdapter.cancel`` 调用。
        参数:
            session_id: 目标逻辑 session id; 仅当 turn 处于 active 时调用
                SDK 的 ``interrupt``。
        """
        runtime = self._sessions[session_id]
        await runtime.questions.cancel_all()
        await runtime.approvals.cancel_all()
        if runtime.active and runtime.waiting:
            # No turn is running to interrupt; the stream only owes a background wake-up.
            # Dropping it ends the wait and keeps that wake-up out of the next prompt.
            await self._drop_waiting_stream(runtime)
        elif runtime.active:
            await runtime.client.interrupt()

    async def _drop_waiting_stream(self, runtime: _ClaudeRuntime) -> None:
        runtime.wait_abandoned = True
        runtime.waiting = False
        runtime.needs_reconnect = True
        await runtime.client.disconnect()

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
        await runtime.approvals.cancel_all()
        if runtime.active and runtime.waiting:
            runtime.wait_abandoned = True
        elif runtime.active:
            await runtime.client.interrupt()
        await runtime.client.disconnect()

    async def resolve_question(self, session_id: str, question_id: str, answers: dict) -> dict:
        return await self._sessions[session_id].questions.resolve(question_id, answers)

    def pending_questions(self, session_id: str) -> list[dict]:
        return self._sessions[session_id].questions.list_pending()

    async def enable_questions(self, session_id: str) -> None:
        self._sessions[session_id].questions.enabled = True

    async def enable_user_approvals(self, session_id: str) -> None:
        self._sessions[session_id].approvals.enabled = True

    def permission_capabilities(self, session_id: str) -> dict:
        """Purpose: Describe native verification without inventing a supported-mode list.

        Input: Connected session ID. Output: A note distinguishing current mode from auto support.
        """
        verified = self._sessions[session_id].permission_verified
        return {"reason": (tr(
            "claude.claude_s_current_permissions_were_verified",
        ) if verified else "") +
                tr("claude.claude_checks_permissions_when_switching_automat")}

    async def resolve_approval(self, session_id: str, approval_id: str, decision: str) -> dict:
        return await self._sessions[session_id].approvals.resolve(approval_id, decision)

    async def _connect(
        self,
        project_path: str,
        model: str | None,
        effort: str | None = None,
        resume: str | None = None,
        permission_mode: ClaudePermissionMode | None = None,
        context=None,
        external_home: bool = False,
    ) -> _ClaudeRuntime:
        """创建并连接一个 ``ClaudeSDKClient``。

        参数:
            project_path: 项目工作目录, 来自 ``create_session`` /
                ``resume_session``。
            model: 模型 id; 为 None 时回落到 ``default_model``。
            resume: 原生 session id, 由 ``resume_session`` 传入, 用于恢复会话。
            external_home: 兼容旧运行状态的标记; 所有会话使用同一原生目录。
        返回:
            ``_ClaudeRuntime``, 由调用方登记进 ``_sessions``。
        """
        questions = QuestionBroker(self.name)
        approvals = PermissionBroker(self.name)

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
                request = approvals.request(
                    itemId=str(getattr(context, "tool_use_id", "") or ""), cwd=project_path,
                    title=getattr(context, "title", None) or tr(
                        "claude.allow_use_of_value",
                        p0=tool_name,
                    ),
                    command=str(input_data.get("command") or input_data.get("file_path")
                                or json.dumps(input_data, ensure_ascii=False)),
                    permissions=input_data,
                    reason=getattr(context, "decision_reason", None)
                    or getattr(context, "description", None) or tr(
                        "claude.claude_requests_your_confirmation",
                    ),
                )
                decision = await approvals.ask(request)
                if decision == "accept":
                    return PermissionResultAllow(updated_input=input_data)
                return PermissionResultDeny(
                    message=tr(
                        "claude.the_user_denied_or_cancelled_this_request",
                    ), interrupt=decision == "cancel",
                )
            try:
                normalized = normalize_questions(input_data.get("questions"), claude=True)
            except ValueError as exc:
                return PermissionResultDeny(message=str(exc))
            answers = await questions.ask(
                normalized,
                native_id=str(getattr(context, "tool_use_id", "") or ""),
            )
            if answers is None:
                return PermissionResultDeny(message=tr(
                    "claude.the_user_did_not_submit_an_answer_ask_again_in_t",
                ))
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
        computer_client = secrets.token_hex(16)
        options = ClaudeAgentOptions(
            max_buffer_size=CLAUDE_MESSAGE_BUFFER_BYTES,
            cwd=project_path,
            # Native discovery keeps explicit-only and automatic skills distinct.
            setting_sources=["user", "project"],
            model=model or self._default_model,
            effort=effort,
            permission_mode=permission_mode or self._permission_mode,
            extra_args={"dangerously-skip-permissions": None}
            if (permission_mode or self._permission_mode) == "bypassPermissions" else {},
            resume=resume,
            # The SDK overlays this onto the inherited environment.
            env=claude_environment(external=external_home),
            mcp_servers=memory.claude_servers(computer_client) if memory else {},
            can_use_tool=can_use_tool,
            hooks={"PreToolUse": [HookMatcher(matcher="AskUserQuestion", hooks=[ask_hook])]},
        )
        client = ClaudeSDKClient(options=options)
        await client.connect()
        verified = False
        try:
            describe = getattr(client, "get_server_info", None)
            info = await describe() if callable(describe) else None
            actual = info.get("current_permission_mode") if isinstance(info, dict) else None
            if actual is not None and actual != options.permission_mode:
                raise ValueError(tr(
                    "claude.claude_did_not_apply_the_selected_permissions_re",
                    p0=options.permission_mode,
                    p1=actual,
                ))
            verified = actual is not None
        except BaseException:
            await client.disconnect()
            raise
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
            approvals=approvals,
            permission_verified=verified,
            context_binding=context,
            external_home=external_home,
            computer_client=computer_client,
        )

    def computer_session(self, client_key: str) -> str | None:
        """Purpose: Find the session whose computer MCP server uses a key. Output: session id."""
        for session_id, runtime in self._sessions.items():
            if runtime.computer_client == client_key:
                return session_id
        return None

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
            return AgentEvent(provider=self.name, type="tool_result", data={
                **asdict(block), "output": block.content,
                "status": "failed" if block.is_error else "completed",
            })
        return None
