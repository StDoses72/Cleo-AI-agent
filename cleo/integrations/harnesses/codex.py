from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from openai_codex import (
    ApprovalMode,
    AsyncCodex,
    AsyncThread,
    AsyncTurnHandle,
    CodexConfig,
    Input,
    Sandbox,
)
from openai_codex.api import (
    ReasoningEffort,
    _approval_mode_override_settings,
    _normalize_run_input,
    _to_wire_input,
)
from openai_codex.errors import JsonRpcError
from openai_codex.generated.v2_all import (
    ConfigRequirementsReadResponse,
    GetAccountRateLimitsResponse,
)

from cleo.harnesses.control import (
    HarnessAccount,
    HarnessModel,
    NativeSession,
    NativeSessionDetail,
    NativeSessionPage,
    SessionOptions,
    SteerRejected,
)
from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.provider import NativeSessionNotFoundError, ProviderSession, ProviderTurn
from cleo.integrations.codex_home import isolated_codex_config
from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.runtime.usage import RateLimitWindowUsage

CODEX_APPROVAL_MODES = {"deny_all", "auto_review", "user"}


@dataclass(slots=True)
class _CodexRuntime:
    """单个 Codex session 的运行时状态(client / thread / 选项 / 锁)。

    由 ``CodexProvider.create_session`` / ``resume_session`` / ``fork_session``
    创建并存入 ``CodexProvider._sessions``, 在 ``prompt`` 及各会话管理方法中消费。
    """

    client: AsyncCodex
    thread: AsyncThread
    options: SessionOptions = field(default_factory=SessionOptions)
    cwd: str = ""
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active_turn: AsyncTurnHandle | None = None
    approvals: CodexApprovalBroker = field(default_factory=CodexApprovalBroker)
    user_approvals_enabled: bool = False
    context_binding: Any = None
    legacy_home: bool = False


class CodexProvider:
    """基于 openai_codex SDK 的 provider, 实现 ``AgentProvider`` 协议及扩展能力。

    由 ``create_provider``(factory.py) 按 ``codex_sdk`` 类型配置实例化,
    也可由兼容门面 ``CodexAdapter``(cleo/integrations/codex.py) 直接构造;
    上层通过 ``AgentAdapter`` 调用其会话与扩展(list/fork/rename 等)方法。
    """

    name = "codex"

    def __init__(
        self,
        default_model: str | None,
        *,
        name: str = "codex",
        approval_mode: str | ApprovalMode = ApprovalMode.deny_all,
        sandbox: Sandbox = Sandbox.workspace_write,
        memory_mcp: MemoryMcp | None = None,
    ) -> None:
        """初始化 provider。

        参数:
            default_model: 默认模型 id, 来自 settings 中该 provider 的
                ``model`` 字段(由 ``create_provider`` 或 ``CodexAdapter`` 传入)。
            name: provider 名称, 来自 settings providers 字典的 key。
            approval_mode: 审批模式, 来自配置 ``options.approval_mode``。
            sandbox: 沙箱模式, 来自配置 ``options.sandbox``。
        """
        self.name = name
        self._memory_mcp = memory_mcp
        self._default_model = default_model
        self._approval_mode = (
            approval_mode.value if isinstance(approval_mode, ApprovalMode) else approval_mode
        )
        if self._approval_mode not in CODEX_APPROVAL_MODES:
            raise ValueError(f"Unsupported Codex approval mode: {self._approval_mode}")
        self._sandbox = sandbox
        self._sessions: dict[str, _CodexRuntime] = {}

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
        *,
        context=None,
    ) -> ProviderSession:
        """创建 AsyncCodex client 并启动新 thread。

        由 ``AgentAdapter.create_session`` 调用(亦经 ``CodexAdapter.start``
        间接触发)。
        参数:
            project_path: 项目工作目录, 由 AgentAdapter 传入, 作为 thread cwd。
            model: 可选模型 id, 由 AgentAdapter 传入, 覆盖 ``default_model``。
        返回:
            ``ProviderSession``, id 与 native_id 均为 thread id; 由
            AgentAdapter 记录并用于后续 ``prompt`` 路由。启动失败时关闭
            client 并向上抛出异常。
        """
        approvals = CodexApprovalBroker(self.name)
        client = (
            self._client_with_approvals(approvals, context=context)
            if context
            else self._client_with_approvals(approvals)
        )
        await client.__aenter__()
        try:
            options = SessionOptions(
                model=model or self._default_model,
                approval_mode=self._approval_mode,
                sandbox=self._sandbox.value,
            )
            if options.approval_mode == "user":
                thread = await self._manual_thread(client, "thread_start", project_path, options)
            else:
                thread = await client.thread_start(
                    approval_mode=self._sdk_approval_mode(self._approval_mode),
                    cwd=project_path, model=options.model, sandbox=self._sandbox,
                )
        except BaseException:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(
            client, thread, options, project_path, approvals=approvals, context_binding=context
        )
        return ProviderSession(id=thread.id, native_id=thread.id)

    async def create_context_session(self, project_path, model, binding):
        if self._memory_mcp is None:
            raise ValueError("Codex context reader is not configured")
        return await self.create_session(project_path, model, context=binding)

    async def resume_context_session(self, native_id, project_path, model, binding):
        if self._memory_mcp is None:
            raise ValueError("Codex context reader is not configured")
        return await self.resume_session(native_id, project_path, model, context=binding)

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
        *,
        context=None,
        _legacy: bool = False,
    ) -> ProviderSession:
        """创建 client 并通过 ``thread_resume`` 恢复既有 thread。

        由 ``AgentAdapter.resume_session`` 调用(亦经 ``CodexAdapter.reply``
        间接触发)。
        参数:
            native_session_id: 原生 thread id, 由 AgentAdapter 从 session
                store 取出传入。
            project_path: 项目工作目录, 由 AgentAdapter 传入。
            model: 可选模型 id, 由 AgentAdapter 传入。
        返回:
            ``ProviderSession``(id == 恢复后的 thread id), 由 AgentAdapter 消费。
        """
        approvals = CodexApprovalBroker(self.name)
        client = self._client_with_approvals(
            approvals, **({"context": context} if context else {}),
            **({"legacy": True} if _legacy else {}),
        )
        await client.__aenter__()
        try:
            options = SessionOptions(
                model=model or self._default_model,
                approval_mode=self._approval_mode,
                sandbox=self._sandbox.value,
            )
            if options.approval_mode == "user":
                thread = await self._manual_thread(
                    client, "thread_resume", project_path, options, native_session_id,
                )
            else:
                thread = await client.thread_resume(
                    native_session_id, approval_mode=self._sdk_approval_mode(self._approval_mode),
                    cwd=project_path, model=options.model, sandbox=self._sandbox,
                )
        except JsonRpcError as error:
            await client.close()
            if (
                error.code == -32600
                and error.message == f"no rollout found for thread id {native_session_id}"
            ):
                if not _legacy:
                    return await self.resume_session(
                        native_session_id, project_path, model, context=context, _legacy=True,
                    )
                raise NativeSessionNotFoundError(str(error)) from error
            raise
        except BaseException:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(
            client, thread, options, project_path, approvals=approvals, context_binding=context,
            legacy_home=_legacy,
        )
        return ProviderSession(id=thread.id, native_id=thread.id)

    async def prompt(
        self,
        session_id: str,
        prompt: str | Input,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        """在 thread 上执行一次 turn 并流式处理 notification 直至完成。

        由 ``AgentAdapter.prompt`` 调用; 同一 session 通过锁串行执行。
        参数:
            session_id: ``create_session`` / ``resume_session`` 返回的 thread id。
            prompt: 用户输入文本, 由 AgentAdapter 传入; turn 的
                approval/effort/model/sandbox 取自当前 ``SessionOptions``。
            on_event: 实时事件回调, 由 AgentAdapter 传入, 每个 notification
                转换出的 ``AgentEvent`` 都会推送给它。
        返回:
            ``ProviderTurn``, response 取最终 agentMessage(缺失时拼接
            chunk), status 由 ``turn/completed`` 映射; 由 AgentAdapter
            持久化并返回给 CLI。
        """
        runtime = self._sessions[session_id]
        events: list[AgentEvent] = []
        response_parts: list[str] = []
        final_response: str | None = None
        status = "failed"
        error: str | None = None
        async with runtime.lock:

            async def approval_event(event: AgentEvent) -> None:
                events.append(event)
                await emit_event(on_event, event)

            runtime.approvals.bind(
                asyncio.get_running_loop(),
                approval_event if runtime.user_approvals_enabled else None,
            )
            runtime.approvals.questions.bind(
                approval_event if runtime.approvals.questions.enabled and on_event else None,
            )
            turn_started = asyncio.Event()

            async def run_turn() -> AsyncTurnHandle:
                nonlocal final_response, status, error
                try:
                    turn = await self._start_turn(runtime, prompt)
                finally:
                    turn_started.set()
                runtime.active_turn = turn
                await emit_event(on_event, AgentEvent(
                    provider=self.name, type="runtime_turn_started",
                    data={"native_turn_id": turn.id},
                ))
                message_phases: dict[str, str] = {}
                async for notification in turn.stream():
                    data = self._notification_data(notification.payload)
                    started_item = data.get("item")
                    if (
                        isinstance(started_item, dict)
                        and started_item.get("type") == "agentMessage"
                    ):
                        message_phases[str(started_item.get("id"))] = str(
                            started_item.get("phase") or "",
                        )
                    if notification.method == "item/agentMessage/delta":
                        data["phase"] = message_phases.get(str(data.get("itemId")), "")
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
                    if (
                        event.type == "assistant_message_chunk"
                        and event.text
                        and data.get("phase") in {"final_answer", "final"}
                    ):
                        response_parts.append(event.text)
                    await emit_event(on_event, event)
                return turn

            turn_task = asyncio.create_task(run_turn())
            try:
                # SDK reads use blocking worker threads. Keep the reader alive
                # until interruption delivers turn/completed and drains it.
                turn = await asyncio.shield(turn_task)
            except asyncio.CancelledError:
                await runtime.approvals.questions.cancel_all()
                await runtime.approvals.cancel_pending()
                await turn_started.wait()
                if not turn_task.done() and runtime.active_turn is not None:
                    await runtime.active_turn.interrupt()
                await turn_task
                raise
            finally:
                if not turn_task.done():
                    await runtime.approvals.cancel_pending()
                    await runtime.client.close()
                    await asyncio.gather(turn_task, return_exceptions=True)
                runtime.active_turn = None
                await runtime.approvals.questions.cancel_all()
                runtime.approvals.questions.callback = None
                await runtime.approvals.cancel_pending()
                runtime.approvals.unbind()

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
        """读取 session 当前的 ``SessionOptions``。

        由 ``AgentAdapter.session_options``(经 ``_capability`` 反射)调用,
        CLI productivity 界面(cleo/cli/productivity.py)用其展示当前选项。
        参数:
            session_id: 目标 session(thread)id。
        返回:
            该 session 的 ``SessionOptions`` 副本引用。
        """
        return self._sessions[session_id].options

    async def update_session_options(
        self,
        session_id: str,
        *,
        model: str | None = None,
        effort: str | None = None,
        approval_mode: str | None = None,
        sandbox: str | None = None,
        service_tier: str | None = None,
    ) -> SessionOptions:
        """更新 session 的模型/推理力度/审批/沙箱选项(校验后生效于后续 turn)。

        由 ``AgentAdapter.update_session_options`` 调用, CLI productivity
        界面(cleo/cli/productivity.py)在用户修改选项时触发。
        参数:
            session_id: 目标 session id; 其余各参数为 None 表示保持原值,
                非 None 时会先用对应 Enum 构造做合法性校验。
        返回:
            更新后的 ``SessionOptions``, 由 AgentAdapter 持久化并回显给 CLI。
        """
        runtime = self._sessions[session_id]
        if service_tier is not None and service_tier not in {"default", "fast"}:
            raise ValueError("不支持的 Codex 速度档位。")
        if effort is not None:
            ReasoningEffort(effort)
        if approval_mode is not None:
            if approval_mode not in CODEX_APPROVAL_MODES:
                raise ValueError(f"Unsupported Codex approval mode: {approval_mode}")
        if sandbox is not None:
            Sandbox(sandbox)
        if approval_mode is not None or sandbox is not None:
            response = await runtime.client._client.request(
                "configRequirements/read", None, response_model=ConfigRequirementsReadResponse,
            )
            requirements = response.requirements
            if requirements is not None:
                rules = requirements.model_dump(mode="json", by_alias=True)
                allowed_sandbox = rules.get("allowedSandboxModes")
                native_sandbox = "danger-full-access" if sandbox == "full-access" else sandbox
                if (sandbox is not None and allowed_sandbox is not None
                        and native_sandbox not in allowed_sandbox):
                    raise ValueError("此设备的管理策略不允许所选文件访问范围。")
                policy = "never" if approval_mode == "deny_all" else "on-request"
                allowed_approval = rules.get("allowedApprovalPolicies")
                if (approval_mode is not None and allowed_approval is not None
                        and policy not in allowed_approval):
                    raise ValueError("此设备的管理策略不允许所选审批方式。")
                features = rules.get("featureRequirements") or {}
                if approval_mode == "auto_review" and features.get("guardian_approval") is False:
                    raise ValueError("此设备的管理策略未启用自动审查。")
        current = runtime.options
        runtime.options = SessionOptions(
            model=current.model if model is None else model,
            effort=current.effort if effort is None else effort,
            approval_mode=(current.approval_mode if approval_mode is None else approval_mode),
            sandbox=current.sandbox if sandbox is None else sandbox,
            service_tier=current.service_tier if service_tier is None else service_tier,
        )
        return runtime.options

    async def resolve_approval(
        self,
        session_id: str,
        approval_id: str,
        decision: str,
    ) -> dict[str, Any]:
        runtime = self._sessions[session_id]
        return await runtime.approvals.resolve(approval_id, decision)

    async def steer(self, session_id: str, text: str, expected_turn_id: str) -> None:
        turn = self._sessions[session_id].active_turn
        if turn is None or turn.id != expected_turn_id:
            raise SteerRejected("目标运行已结束，指令未投递。")
        try:
            response = await turn.steer(text)
        except JsonRpcError as error:
            if error.code == -32601:
                raise SteerRejected("当前 Codex 客户端不支持运行中引导。") from error
            if error.code == -32602 or (
                error.code == -32600 and any(part in error.message.lower() for part in (
                    "no active turn", "expected turn", "turn id mismatch", "turn_id mismatch",
                ))
            ):
                raise SteerRejected(str(error)) from error
            raise
        if response.turn_id != expected_turn_id:
            raise RuntimeError("Steering acknowledgement referred to a different turn")

    async def enable_user_approvals(self, session_id: str) -> None:
        self._sessions[session_id].user_approvals_enabled = True

    async def resolve_question(self, session_id: str, question_id: str, answers: dict) -> dict:
        return await self._sessions[session_id].approvals.questions.resolve(question_id, answers)

    def pending_questions(self, session_id: str) -> list[dict]:
        return self._sessions[session_id].approvals.questions.list_pending()

    async def enable_questions(self, session_id: str) -> None:
        self._sessions[session_id].approvals.questions.enabled = True

    async def list_models(self) -> tuple[HarnessModel, ...]:
        """查询 Codex 账号可用的模型列表。

        由 ``AgentAdapter.list_models`` 调用, CLI 用其展示可选模型。
        返回:
            ``HarnessModel`` 元组, 含 display name、默认/支持的
            reasoning effort 等; 使用临时 client, 不依赖活动 session。
        """
        async with self._client() as client:
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
        """分页列出 Codex 原生 thread(session)列表。

        由 ``AgentAdapter.list_native_sessions`` 调用, CLI productivity
        界面(cleo/cli/productivity.py)用其展示可恢复的历史会话。
        参数:
            limit / cursor / archived / cwd / search_term: 分页与过滤条件,
                全部由 AgentAdapter 透传自 CLI 用户输入。
        返回:
            ``NativeSessionPage``, 含本页 ``NativeSession`` 元组与
            ``next_cursor`` 翻页游标。
        """
        async with self._client(legacy=True) as client:
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
        *,
        _legacy: bool = False,
    ) -> NativeSessionDetail:
        """读取某个原生 thread 的详情(含全部 turn 记录)。

        由 ``AgentAdapter.read_native_session`` 调用, CLI productivity 界面
        (cleo/cli/productivity.py:417)用其展示历史会话内容。
        参数:
            native_session_id: 原生 thread id, 由 AgentAdapter 透传。
        返回:
            ``NativeSessionDetail``, 含归一化的 session 信息与按 JSON
            序列化的 turns 元组。
        """
        try:
            async with self._client(**({"legacy": True} if _legacy else {})) as client:
                thread = await client.thread_resume(native_session_id)
                response = await thread.read(include_turns=True)
        except JsonRpcError as error:
            if (not _legacy and error.code == -32600
                    and error.message == f"no rollout found for thread id {native_session_id}"):
                return await self.read_native_session(native_session_id, _legacy=True)
            raise
        native = self._native_session(response.thread)
        turns = tuple(
            turn.model_dump(mode="json", by_alias=True, exclude_none=True)
            for turn in response.thread.turns
        )
        return NativeSessionDetail(session=native, turns=turns)

    async def account_status(self) -> HarnessAccount:
        """查询当前 Codex 账号的认证状态与套餐信息。

        由 ``AgentAdapter.account_status`` 调用, CLI productivity 界面
        (cleo/cli/productivity.py:448)用其展示账号信息。
        返回:
            ``HarnessAccount``; 未认证时仅 ``authenticated=False``。
        """
        async with self._client() as client:
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

    async def account_rate_limits(
        self,
        session_id: str,
    ) -> tuple[RateLimitWindowUsage, ...]:
        """Read the active Codex account's short and weekly usage windows."""
        runtime = self._sessions[session_id]
        async with runtime.lock:
            response = await runtime.client._client.request(
                "account/rateLimits/read",
                None,
                response_model=GetAccountRateLimitsResponse,
            )
        snapshot = response.rate_limits
        return tuple(
            RateLimitWindowUsage(
                used_percent=max(0, min(int(window.used_percent), 100)),
                window_minutes=window.window_duration_mins,
                resets_at=window.resets_at,
            )
            for window in (snapshot.primary, snapshot.secondary)
            if window is not None
        )

    async def fork_session(self, session_id: str) -> ProviderSession:
        """从既有 session fork 出一个继承其上下文的新 thread。

        由 ``AgentAdapter.fork_session`` 调用, CLI productivity 界面
        (cleo/cli/productivity.py:456)触发。
        参数:
            session_id: 源 session(thread)id; 新 thread 沿用源 session 的
                options 与 cwd。
        返回:
            ``ProviderSession``(id == 新 thread id), 由 AgentAdapter 登记为
            新会话。
        """
        source = self._sessions[session_id]
        options = source.options
        approvals = CodexApprovalBroker(self.name)
        client = self._client_with_approvals(
            approvals, **({"context": source.context_binding} if source.context_binding else {}),
            **({"legacy": True} if source.legacy_home else {}),
        )
        await client.__aenter__()
        try:
            if options.approval_mode == "user":
                thread = await self._manual_thread(
                    client, "thread_fork", source.cwd, options, source.thread.id,
                )
            else:
                thread = await client.thread_fork(
                    source.thread.id,
                    approval_mode=(self._sdk_approval_mode(options.approval_mode)
                                   if options.approval_mode else None),
                    cwd=source.cwd or None, model=options.model,
                    sandbox=Sandbox(options.sandbox) if options.sandbox else None,
                )
        except BaseException:
            await client.close()
            raise
        self._sessions[thread.id] = _CodexRuntime(
            client,
            thread,
            options,
            source.cwd,
            approvals=approvals,
            context_binding=source.context_binding,
            legacy_home=source.legacy_home,
        )
        return ProviderSession(id=thread.id, native_id=thread.id)

    async def rename_session(self, session_id: str, name: str) -> None:
        """重命名 thread(原生侧名称)。

        由 ``AgentAdapter.rename_session`` 调用, CLI productivity 界面
        (cleo/cli/productivity.py:476)触发。
        参数:
            session_id: 目标 session id。
            name: 新名称, 由 CLI 用户输入透传。
        """
        runtime = self._sessions[session_id]
        async with runtime.lock:
            await runtime.thread.set_name(name)

    async def compact_session(self, session_id: str) -> None:
        """压缩 thread 上下文(compaction), 降低 token 占用。

        由 ``AgentAdapter.compact_session`` 调用, CLI productivity 界面
        (cleo/cli/productivity.py:484)触发。
        参数:
            session_id: 目标 session id。
        """
        runtime = self._sessions[session_id]
        async with runtime.lock:
            await runtime.thread.compact()

    async def archive_session(self, session_id: str) -> None:
        """归档 thread 并释放本地运行时(先中断进行中的 turn)。

        由 ``AgentAdapter.archive_session`` 调用, CLI productivity 界面
        (cleo/cli/productivity.py:493)触发。
        参数:
            session_id: 目标 session id; 归档后该 session 从 ``_sessions``
                移除, 其 client 被关闭。
        """
        runtime = self._sessions.pop(session_id)
        try:
            runtime.approvals.cancel_all()
            async with runtime.lock:
                if runtime.active_turn is not None:
                    await runtime.active_turn.interrupt()
                await runtime.client.thread_archive(runtime.thread.id)
        finally:
            await runtime.client.close()

    async def cancel(self, session_id: str) -> None:
        """中断 session 中正在运行的 turn。

        由 ``AgentAdapter.cancel`` 调用。
        参数:
            session_id: 目标 session id; 存在 active turn 时调用其
                ``interrupt``。
        """
        runtime = self._sessions[session_id]
        await runtime.approvals.questions.cancel_all()
        await runtime.approvals.cancel_pending()
        if runtime.active_turn is not None:
            await runtime.active_turn.interrupt()

    async def close(self, session_id: str) -> None:
        """关闭 session: 中断进行中的 turn 并关闭 client。

        由 ``AgentAdapter.close`` / ``AgentAdapter.aclose`` 调用。
        参数:
            session_id: 目标 session id; 不存在则静默返回。
        """
        runtime = self._sessions.pop(session_id, None)
        if runtime is None:
            return
        await runtime.approvals.questions.cancel_all()
        await runtime.approvals.cancel_pending()
        if runtime.active_turn is not None:
            await runtime.active_turn.interrupt()
        await runtime.client.close()

    async def _start_turn(
        self,
        runtime: _CodexRuntime,
        prompt: str | Input,
    ) -> AsyncTurnHandle:
        options = runtime.options
        if options.approval_mode != "user" and options.service_tier != "default":
            return await runtime.thread.turn(
                prompt,
                approval_mode=(
                    self._sdk_approval_mode(options.approval_mode)
                    if options.approval_mode
                    else None
                ),
                effort=ReasoningEffort(options.effort) if options.effort else None,
                model=options.model,
                sandbox=Sandbox(options.sandbox) if options.sandbox else None,
                **({"service_tier": options.service_tier} if options.service_tier else {}),
            )
        params = {
            "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "effort": options.effort, "model": options.model,
            "sandboxPolicy": self._sandbox_policy(options.sandbox),
        }
        if options.approval_mode != "user":
            policy, reviewer = _approval_mode_override_settings(
                self._sdk_approval_mode(options.approval_mode) if options.approval_mode else None,
            )
            params.pop("approvalPolicy")
            params.pop("approvalsReviewer")
            if policy is not None:
                params["approvalPolicy"] = policy.model_dump(mode="json")
            if reviewer is not None:
                params["approvalsReviewer"] = reviewer.value
        if options.service_tier is not None:
            # Explicit null clears Fast; the high-level SDK omits None values.
            params["serviceTier"] = "fast" if options.service_tier == "fast" else None
        started = await runtime.client._client.turn_start(
            runtime.thread.id,
            prompt if isinstance(prompt, str) else _to_wire_input(_normalize_run_input(prompt)),
            params=params,
        )
        return AsyncTurnHandle(runtime.client, runtime.thread.id, started.turn.id)

    @staticmethod
    def _client(config: CodexConfig | None = None, *, legacy: bool = False) -> AsyncCodex:
        if not legacy:
            config = isolated_codex_config(config)
        # Desktop selects the CLI bundled with its validated Python SDK runtime.
        if (codex_bin := os.environ.get("CLEO_CODEX_BIN")) and not (
            config is not None and config.codex_bin
        ):
            config = config or CodexConfig()
            config.codex_bin = codex_bin
        return AsyncCodex(config=config) if config is not None else AsyncCodex()

    def _client_with_approvals(
        self, approvals: CodexApprovalBroker, *, context=None, legacy: bool = False,
    ) -> AsyncCodex:
        memory = (
            self._memory_mcp.for_context(context)
            if context and self._memory_mcp
            else self._memory_mcp
        )
        client = self._client(memory.codex_config() if memory else None, legacy=legacy)
        async_client = getattr(client, "_client", None)
        sync_client = getattr(async_client, "_sync", None)
        if sync_client is None or not hasattr(sync_client, "_approval_handler"):
            raise RuntimeError("Installed openai-codex SDK does not expose approval callbacks.")
        sync_client._approval_handler = approvals.handle
        approvals.questions.transport_alive = lambda: (
            getattr(sync_client, "_proc", None) is None or sync_client._proc.poll() is None
        )
        return client

    @staticmethod
    def _sdk_approval_mode(value: str) -> ApprovalMode:
        return ApprovalMode(value)

    @staticmethod
    async def _manual_thread(client, operation, cwd, options, thread_id=None) -> AsyncThread:
        # The high-level SDK only exposes automatic review and deny-all presets.
        await client._ensure_initialized()
        params = {
            "approvalPolicy": "on-request", "approvalsReviewer": "user", "cwd": cwd,
            "model": options.model,
            "sandbox": ("danger-full-access"
                        if options.sandbox == "full-access" else options.sandbox),
        }
        method = getattr(client._client, operation)
        result = await method(thread_id, params) if thread_id else await method(params)
        return AsyncThread(client, result.thread.id)

    @staticmethod
    def _sandbox_policy(value: str | None) -> dict[str, Any] | None:
        if value == "read-only":
            return {"type": "readOnly"}
        if value == "workspace-write":
            return {"type": "workspaceWrite"}
        if value == "full-access":
            return {"type": "dangerFullAccess"}
        return None

    @classmethod
    def _native_session(cls, thread: Any) -> NativeSession:
        """把 SDK thread 对象归一化为 ``NativeSession``。

        参数:
            thread: SDK 返回的 thread 模型, 来自 ``list_native_sessions`` /
                ``read_native_session`` 的响应。
        返回:
            ``NativeSession``, 供 CLI 展示会话列表/详情。
        """
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
        """把时间戳归一化为 ISO 字符串。

        参数:
            value: SDK 字段值(秒级时间戳或已是字符串), 来自 ``_native_session``。
        返回:
            ISO 格式字符串; 空值返回空串。
        """
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, UTC).isoformat()
        return str(value or "")

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        """把任意值归一化为可选文本(空串归一为 None)。

        参数:
            value: SDK 字段值, 来自 ``_native_session`` / ``account_status``。
        返回:
            非空字符串或 None。
        """
        text = CodexProvider._scalar(value)
        return text or None

    @staticmethod
    def _scalar(value: Any) -> str:
        """把 SDK 字段(Enum / RootModel / dict 包装)展开为标量字符串。

        参数:
            value: SDK 模型字段值, 可能为 Enum、含 ``root`` 的 RootModel 或
                dict; 被 ``_native_session`` / ``list_models`` 等多处调用。
        返回:
            展开后的字符串; 空值返回空串。
        """
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
        """把 turn notification 的 payload 统一转成 JSON dict。

        参数:
            payload: SDK notification 的 payload, 可能是 pydantic 模型
                (走 ``model_dump``)或带 ``params`` 的对象, 来自 ``prompt``
                的流式循环。
        返回:
            dict; 无法得到 dict 时包装为 ``{"value": ...}``。
        """
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
        """把 Codex notification 映射为统一的 ``AgentEvent``。

        参数:
            method: notification 的 JSON-RPC method(如
                ``item/agentMessage/delta``), 来自 ``prompt`` 的流式循环。
            data: ``_notification_data`` 归一化后的 payload dict。
        返回:
            对应的 ``AgentEvent``(原始 payload 保存在 ``data.payload``,
            schema_version=2); turn 边界等不产生事件时返回 None(调用方跳过)。
        """
        if method in {"turn/started", "turn/completed"}:
            return None

        item = data.get("item")
        item_type = item.get("type") if isinstance(item, dict) else None
        event_type: str
        text: str | None = None
        if method == "item/agentMessage/delta":
            event_type = "assistant_message_chunk"
            text = str(data.get("delta") or "") or None
        elif method == "item/completed" and item_type == "agentMessage":
            event_type = "assistant_message_completed"
            text = str(item.get("text") or "") or None
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
        elif method in {"item/autoApprovalReview/started", "item/autoApprovalReview/completed"}:
            event_type = "approval_review"
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
        elif method in {
            "thread/tokenUsage/updated",
            "account/rateLimits/updated",
        }:
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
        """把 SDK 的 turn status 归一化为内部状态词。

        参数:
            value: ``turn/completed`` payload 中的 status 字段值, 来自
                ``prompt`` 的流式循环。
        返回:
            归一化后的状态: ``inProgress``→``running``、
            ``interrupted``→``cancelled``, 其余原样, 空值为 ``failed``。
        """
        status = str(value or "failed")
        return {"inProgress": "running", "interrupted": "cancelled"}.get(status, status)
