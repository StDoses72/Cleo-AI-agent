"""Productivity harness interaction flow."""

from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Awaitable, Callable, Mapping
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING

from cleo.cli.context import clear_screen, cli
from cleo.cli.lifecycle import _run_dream_agent
from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.config.settings import SettingsModel
    from cleo.harnesses import AgentAdapter, AgentResult, AgentSession, SessionOptions
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


class ProductivityStartupError(RuntimeError):
    """productivity 会话在进入交互循环前无法启动。

    由 :func:`_run_productivity_mode` 在 provider、已保存会话或初始 harness
    session 无法解析时抛出。嵌入 Cleo chat 的调用方把它显示为普通错误并
    恢复聊天上下文;顶层 CLI 入口将其转换为 ``SystemExit``。
    """


async def _prompt_productivity_session(
    adapter: AgentAdapter,
    session_id: str,
    prompt: str,
    *,
    model: str,
    context_usage: ContextWindowUsage,
) -> AgentResult:
    """向 harness 会话发送一轮 prompt, 用 ProductivityEventRenderer 流式渲染事件。

    参数:
        adapter: AgentAdapter, 由 _run_productivity_loop / _run_productivity_mode
            持有并传入(经 build_agent_adapter 构建)。
        session_id: 目标会话 id(session.id), 由调用方传入。
        prompt: 用户输入; 来自 productivity loop 的 cli.prompt 返回值,
            或一次性模式的 args.message。
        model: 展示用模型名(active_model/display_model), 由调用方传入。
        context_usage: 与 loop 共享的 ContextWindowUsage, renderer 会回写 token 统计。

    返回:
        AgentResult: adapter.prompt 的结果, 先交给 renderer.finish 渲染状态;
        当前调用方(_run_productivity_loop 与 _run_productivity_mode)
        均不消费返回值, 仅依赖其副作用与异常。
    """
    renderer = cli.productivity_renderer(
        model=model,
        context_usage=context_usage,
    )
    result = await adapter.prompt(session_id, prompt, on_event=renderer)
    renderer.finish(result)
    return result


async def _finish_productivity_session(
    adapter: AgentAdapter,
    session: AgentSession,
    runtime: Runtime,
) -> None:
    """关闭当前 productivity 会话并做收尾: 记录 recent thread、触发 DreamAgent。

    参数:
        adapter: AgentAdapter, 由 _run_productivity_loop / _run_productivity_mode 传入。
        session: 待关闭的 AgentSession, 由调用方在退出/切换会话前传入。
        runtime: Runtime 状态对象, 用于 append_recent_threads 持久化最近线程。

    返回:
        None; 副作用包括 adapter.close、runtime 记录以及
        cleo/cli/lifecycle.py 的 _run_dream_agent 后台记忆整理。
    """
    await adapter.close(session.id)
    runtime.append_recent_threads(session.id, "productivity")
    await _run_dream_agent(session.id, session.project, "productivity")


def _slash_command_argument(prompt: str, command: str) -> str:
    """从用户输入中取出 slash command 的参数部分, 并剥掉成对的引号。

    参数:
        prompt: 用户原始输入; 来自 productivity loop 的 cli.prompt 返回值,
            或 cleo/cli/chat.py 中 chat 模式的 message(/rename、/project、/resume)。
        command: 要剥离的命令前缀(如 "/model"、"/cd"), 由各调用点传入。

    返回:
        str: 命令后的参数字符串(已 strip 并去除成对的 ' 或 ");
        由各调用点继续作为 id、路径、模型名等使用。
    """
    argument = prompt.removeprefix(command).strip()
    if (
        len(argument) >= 2
        and argument[0] in {'"', "'"}
        and argument[-1] == argument[0]
    ):
        return argument[1:-1]
    return argument


def _resolve_productivity_cwd(argument: str, current_cwd: str) -> str:
    """把 /cd 参数解析为已存在的绝对目录路径(支持 ~、环境变量与相对路径)。

    参数:
        argument: /cd 的参数, 由 _run_productivity_loop 经
            _slash_command_argument(prompt, "/cd") 传入(productivity.py)。
        current_cwd: 当前会话目录(session.project_path), 作为相对路径的基准。

    返回:
        str: normcase 后的绝对路径; 由 _run_productivity_loop 作为
        create_session(project_path=...) 的新工作目录。
        参数为空或目录不存在时抛出 ValueError, 由调用点捕获并显示错误。
    """
    if not argument:
        raise ValueError("Usage: /cd <directory>")
    expanded = Path(os.path.expandvars(argument)).expanduser()
    path = expanded if expanded.is_absolute() else Path(current_cwd) / expanded
    path = path.resolve()
    if not path.is_dir():
        raise ValueError(f"Directory does not exist: {path}")
    return os.path.normcase(str(path))


async def _resume_productivity_session(
    adapter: AgentAdapter,
    store: SessionStore,
    session_id: str,
    *,
    model: str | None,
    provider_override: str | None = None,
    cwd_override: str | None = None,
    project_override: str | None = None,
) -> AgentSession:
    """从 SessionStore 的 manifest 恢复一个已保存的 productivity 会话。

    参数:
        adapter: AgentAdapter, 由 _run_productivity_loop(/resume 分支)或
            _run_productivity_mode(args.resume_id 分支)传入。
        store: SessionStore, 用于 load_manifest 读取会话元数据。
        session_id: 待恢复的会话 id; 来自用户 /resume 参数或 CLI args.resume_id。
        model: 目标模型; 来自 provider 配置(model_for)或 args/model 设置。
        provider_override: CLI 指定的 provider, 用于校验与 manifest 一致。
        cwd_override / project_override: CLI args.cwd / args.project, 优先于
            manifest 中的记录。

    返回:
        AgentSession: adapter.resume_session 的结果; 由调用方接管为新的当前
        会话并更新 runtime 状态。校验失败抛出 ValueError, 由调用点捕获。
    """
    manifest = store.load_manifest(session_id)
    if manifest["space"] != "productivity":
        raise ValueError(f"Session {session_id} is not a productivity session.")
    provider = str(manifest["provider"])
    if provider_override is not None and provider_override != provider:
        raise ValueError(
            f"Session {session_id} belongs to provider {provider!r}, "
            f"not {provider_override!r}."
        )
    native_session_id = manifest.get("native_session_id")
    if not native_session_id:
        raise ValueError(f"Session {session_id} has no native harness session id.")
    return await adapter.resume_session(
        provider,
        str(native_session_id),
        project_path=cwd_override or manifest.get("cwd") or ".",
        model=model,
        project=project_override or str(manifest["project"]),
    )


async def _load_productivity_catalog(
    adapter: AgentAdapter,
    provider: str,
):
    """尽力加载 provider 的模型列表与最近 native sessions(失败则静默回退为空)。

    参数:
        adapter: AgentAdapter; 通过 getattr 探测 list_models / list_native_sessions
            能力, 不存在或调用失败时保持空结果。
        provider: provider 名(如 "codex"), 由 _run_productivity_loop 传入
            session.provider。

    返回:
        tuple: (models, native_page) — HarnessModel 元组与 NativeSessionPage;
        由 _run_productivity_loop 用于 /model 校验、prompt 补全与
        /resume-native、/sessions 的展示数据。
    """
    from cleo.harnesses import NativeSessionPage

    models = ()
    native_page = NativeSessionPage(())
    list_models = getattr(adapter, "list_models", None)
    if callable(list_models):
        try:
            models = await list_models(provider)
        except (NotImplementedError, OSError, RuntimeError):
            pass
    list_native = getattr(adapter, "list_native_sessions", None)
    if callable(list_native):
        try:
            native_page = await list_native(provider, limit=50)
        except (NotImplementedError, OSError, RuntimeError):
            pass
    return models, native_page


def _productivity_options(adapter: AgentAdapter, session_id: str):
    """读取会话当前的 SessionOptions(adapter 不支持或会话未知时返回 None)。

    参数:
        adapter: AgentAdapter; 通过 getattr 探测 session_options 能力。
        session_id: 当前会话 id(session.id), 由 _run_productivity_loop /
            _run_productivity_mode 传入。

    返回:
        SessionOptions | None; 由调用方用于渲染 controls 面板、以及
        /effort、/access、/approval 显示当前值。
    """
    session_options = getattr(adapter, "session_options", None)
    if not callable(session_options):
        return None
    try:
        return session_options(session_id)
    except (KeyError, NotImplementedError):
        return None


def _render_productivity_header(
    adapter: AgentAdapter,
    session: AgentSession,
    *,
    active_model: str,
    context_usage: ContextWindowUsage,
) -> None:
    """渲染 productivity 会话的完整 header(品牌行 + runtime status + controls + 明细)。

    参数:
        adapter: AgentAdapter, 用于 _productivity_options 读取当前 options。
        session: 当前 AgentSession; header 展示其 project/cwd/id 等信息。
        active_model: 展示用模型名, 由 _run_productivity_loop 闭包、
            _switch_productivity_session 或 _run_productivity_mode 传入。
        context_usage: 当前会话的 ContextWindowUsage, 随会话切换重置后传入。

    返回:
        None; 副作用为 cli.render_productivity_header 输出以及
        cleo.integrations.git.inspect_git_status 的 git 状态采集。
    """
    from cleo.integrations.git import inspect_git_status

    cli.render_productivity_header(
        session,
        model=active_model,
        context_usage=context_usage,
        options=_productivity_options(adapter, session.id),
        git_status=inspect_git_status(session.project_path),
    )


def _restart_productivity_session(
    adapter: AgentAdapter,
    session: AgentSession,
    model: str | None,
) -> Awaitable[AgentSession]:
    """按旧会话的 provider/cwd/project 与当前模型重建会话(/new、/archive 共用)。

    参数:
        adapter: AgentAdapter, 由 _run_productivity_loop 传入。
        session: 旧会话, 取其 provider/project_path/project 作为新会话配置。
        model: 当前 session_model, 原样传给 create_session。

    返回:
        Awaitable[AgentSession]: 未 await 的 create_session 协程; 供
        _switch_productivity_session 在收尾旧会话之后再建, 保持原有调用次序。
    """
    return adapter.create_session(
        session.provider,
        project_path=session.project_path,
        model=model,
        project=session.project,
    )


async def _switch_productivity_session(
    adapter: AgentAdapter,
    runtime: Runtime,
    previous_session: AgentSession,
    next_session: AgentSession | Callable[[], Awaitable[AgentSession]],
    *,
    active_model: str,
    update_project: bool = False,
    before_header: Callable[[AgentSession], Awaitable[None]] | None = None,
    success: Callable[[AgentSession], str],
) -> tuple[AgentSession, ContextWindowUsage]:
    """结束旧会话并接管新会话: 收尾→换会话→更新 runtime→清屏→渲染 header→success。

    参数:
        adapter / runtime: 由 _run_productivity_loop 传入的共享实例。
        previous_session: 待结束的旧会话, 先经 _finish_productivity_session 收尾。
        next_session: 已建好的新会话(/cd、/resume、/resume-native、/fork 先在
            try 中建好, 失败时旧会话不受影响); 或返回新会话的异步工厂
            (/new、/archive 需要先收尾再建会话, 保持原有调用次序)。
        active_model: 渲染 header 用的模型名; /resume 时为新会话的模型。
        update_project: 是否 runtime.update_current_project(/cd、/resume、
            /resume-native 为 True; /new、/fork、/archive 沿用旧 project)。
        before_header: 清屏后、渲染 header 前的异步钩子(如 /resume 重载
            模型/会话目录), 入参为新会话。
        success: 由新会话生成成功提示文案的回调。

    返回:
        tuple: (新会话, 重置后的 ContextWindowUsage); 由调用方接管为
        当前会话与 token 统计。
    """
    await _finish_productivity_session(adapter, previous_session, runtime)
    if callable(next_session):
        next_session = await next_session()
    session = next_session
    if update_project:
        runtime.update_current_project(session.project)
    runtime.update_current_thread_id(session.id)
    runtime.append_recent_threads(session.id, "productivity")
    context_usage = ContextWindowUsage()
    clear_screen()
    if before_header is not None:
        await before_header(session)
    _render_productivity_header(
        adapter,
        session,
        active_model=active_model,
        context_usage=context_usage,
    )
    cli.success(success(session))
    return session, context_usage


async def _update_productivity_option(
    adapter: AgentAdapter,
    session_id: str,
    *,
    option_key: str,
    requested: str,
    label: str,
    render_controls: Callable[[], None],
    format_success: Callable[[SessionOptions], str] | None = None,
    before_controls: Callable[[SessionOptions], None] | None = None,
) -> SessionOptions | None:
    """更新单个 SessionOptions 字段并反馈(/model、/effort、/access、/approval 共用)。

    参数:
        adapter: AgentAdapter, 由 _run_productivity_loop 传入。
        session_id: 当前会话 id(session.id)。
        option_key: update_session_options 的关键字名("model"、"effort"、
            "sandbox"、"approval_mode"), 同时用于从更新结果中读回新值。
        requested: 用户输入的目标值; 为空时仅显示当前值并返回 None。
        label: 提示文案中的选项名(如 "Reasoning effort"、"Filesystem access")。
        render_controls: 更新成功后重渲染 controls 面板的回调。
        format_success: 自定义成功文案(默认 f"{label} set to {新值}."); /model
            用它附带 "applies to the next turn" 说明。
        before_controls: 渲染 controls 前的额外回调; /model 用它先按
            success→runtime status→controls 的次序重渲染 runtime status 行。

    返回:
        SessionOptions | None: 更新成功返回 adapter 结果(调用方可继续同步
        本地状态, 如 /model 的 session_model/active_model); 无参展示或
        adapter 报错时返回 None(提示已输出)。
    """
    if not requested:
        current = _productivity_options(adapter, session_id)
        cli.info(f"{label}: {(current and getattr(current, option_key)) or 'default'}")
        return None
    try:
        options = await adapter.update_session_options(session_id, **{option_key: requested})
    except (KeyError, NotImplementedError, ValueError) as exc:
        cli.error(str(exc))
        return None
    if format_success is not None:
        message = format_success(options)
    else:
        message = f"{label} set to {getattr(options, option_key)}."
    cli.success(message)
    if before_controls is not None:
        before_controls(options)
    render_controls()
    return options


async def _run_productivity_loop(
    adapter: AgentAdapter,
    session: AgentSession,
    runtime: Runtime,
    store: SessionStore,
    *,
    model: str | None,
    provider_models: Mapping[str, str | None] | None = None,
    return_to_chat: bool = False,
) -> None:
    """productivity 模式的交互主循环: 读取输入并分发 slash command 或 prompt。

    参数:
        adapter: AgentAdapter, 由 _run_productivity_mode 构建后传入。
        session: 当前 AgentSession; 由 _run_productivity_mode 的
            create_session / _resume_productivity_session 结果传入。
        runtime: Runtime 状态, 用于更新 current thread/project 与 recent threads。
        store: SessionStore, 用于 /resume 的 manifest 读取与补全列表。
        model: CLI args.model; 为 None 时回退到 provider_models 中的配置。
        provider_models: provider -> model 映射, 由 _run_productivity_mode 从
            settings.productivity.providers 构建。
        return_to_chat: 退出语义提示用; 由 _run_productivity_mode 传入
            (chat 内 /productivity 进入时为 True)。

    返回:
        None; 循环退出时( /back、/quit、EOF )清理 runtime 的 current
        thread/project 并 update_runtime_json。
    """
    exit_action = "return to Cleo chat" if return_to_chat else "exit"
    configured_models = provider_models or {}

    def model_for(provider: str) -> str | None:
        """按优先级取模型: CLI args.model 优先, 否则用 provider 配置。

        参数: provider — 会话的 provider 名, 来自 session.provider 或
        /resume 时读取的 manifest["provider"]。
        返回: str | None; 供 loop 内计算 session_model / resume_model 使用。
        """
        return model or configured_models.get(provider)

    session_model = model_for(session.provider)
    active_model = session_model or "default"
    context_usage = ContextWindowUsage()
    available_models, native_page = await _load_productivity_catalog(
        adapter,
        session.provider,
    )

    def render_active_controls() -> None:
        """重渲染当前会话的 controls 面板(effort/access/approval + git 状态)。

        无参数(闭包捕获 session/adapter), 无返回值; 由 /model、/effort、
        /access、/approval 等分支在更新 options 后调用。
        """
        from cleo.integrations.git import inspect_git_status

        cli.render_productivity_controls(
            _productivity_options(adapter, session.id),
            inspect_git_status(session.project_path),
        )

    def render_active_header() -> None:
        """重渲染当前会话的完整 header(品牌行 + runtime status + controls + 明细)。

        无参数(闭包捕获 session/active_model/context_usage/adapter), 无返回值;
        由 loop 启动时及 /native、/sessions 等需要清屏重绘的分支调用;
        各换会话分支统一走 _switch_productivity_session。
        """
        _render_productivity_header(
            adapter,
            session,
            active_model=active_model,
            context_usage=context_usage,
        )

    render_active_header()
    cli.info(f"Use /back or /quit to {exit_action}; /new starts a new harness session.")
    cli.console.print()

    while True:
        try:
            prompt = await asyncio.to_thread(
                cli.prompt,
                "productivity",
                cwd=session.project_path,
                sessions=store.list_sessions(space="productivity"),
                native_sessions=native_page.sessions,
                models=available_models,
            )
        except (EOFError, KeyboardInterrupt):
            cli.console.print()
            await _finish_productivity_session(adapter, session, runtime)
            break

        if not prompt:
            continue
        if prompt in {"/back", "/quit", "/exit"}:
            await _finish_productivity_session(adapter, session, runtime)
            break
        if prompt == "/new":
            session, context_usage = await _switch_productivity_session(
                adapter,
                runtime,
                session,
                partial(_restart_productivity_session, adapter, session, session_model),
                active_model=active_model,
                success=lambda new: f"Started new {new.provider} session: {new.id}",
            )
            continue
        if prompt == "/cwd":
            cli.info(session.project_path)
            continue
        if prompt == "/project":
            from cleo.integrations.git import inspect_git_status

            cli.info(f"{session.project} · {session.project_path}")
            cli.render_git_status(inspect_git_status(session.project_path))
            continue
        if prompt == "/git":
            from cleo.integrations.git import inspect_git_status

            cli.render_git_status(inspect_git_status(session.project_path))
            continue
        if prompt == "/model" or prompt.startswith("/model "):
            requested = _slash_command_argument(prompt, "/model")
            if not requested:
                cli.info(f"Active model: {active_model}")
                if available_models:
                    cli.render_models(available_models, active=active_model)
                continue
            known_models = {item.id for item in available_models}
            if known_models and requested not in known_models:
                cli.error(f"Unknown model: {requested}")
                continue
            options = await _update_productivity_option(
                adapter,
                session.id,
                option_key="model",
                requested=requested,
                label="Model",
                render_controls=render_active_controls,
                format_success=lambda updated: (
                    f"Model set to {updated.model or 'default'}; "
                    f"it applies to the next turn."
                ),
                before_controls=lambda updated, usage=context_usage: (
                    cli.render_runtime_status(
                        updated.model or "default",
                        usage,
                        accent="magenta",
                    )
                ),
            )
            if options is not None:
                session_model = options.model
                active_model = session_model or "default"
            continue
        if prompt == "/effort" or prompt.startswith("/effort "):
            await _update_productivity_option(
                adapter,
                session.id,
                option_key="effort",
                requested=_slash_command_argument(prompt, "/effort"),
                label="Reasoning effort",
                render_controls=render_active_controls,
            )
            continue
        if prompt == "/access" or prompt.startswith("/access "):
            await _update_productivity_option(
                adapter,
                session.id,
                option_key="sandbox",
                requested=_slash_command_argument(prompt, "/access"),
                label="Filesystem access",
                render_controls=render_active_controls,
            )
            continue
        if prompt == "/approval" or prompt.startswith("/approval "):
            await _update_productivity_option(
                adapter,
                session.id,
                option_key="approval_mode",
                requested=_slash_command_argument(prompt, "/approval"),
                label="Approval behavior",
                render_controls=render_active_controls,
            )
            continue
        if prompt == "/cd" or prompt.startswith("/cd "):
            try:
                target_cwd = _resolve_productivity_cwd(
                    _slash_command_argument(prompt, "/cd"),
                    session.project_path,
                )
                next_session = await adapter.create_session(
                    session.provider,
                    project_path=target_cwd,
                    model=session_model,
                    project=session.project,
                )
            except (KeyError, OSError, ValueError) as exc:
                cli.error(str(exc))
                continue
            session, context_usage = await _switch_productivity_session(
                adapter,
                runtime,
                session,
                next_session,
                active_model=active_model,
                update_project=True,
                success=lambda new: (
                    f"Changed cwd to {new.project_path}; started session {new.id}."
                ),
            )
            continue
        if prompt == "/resume" or prompt.startswith("/resume "):
            resume_id = _slash_command_argument(prompt, "/resume")
            if not resume_id:
                cli.warning("Usage: /resume <productivity-session-id>")
                continue
            if resume_id == session.id:
                cli.info(f"Session {session.id} is already active.")
                continue
            try:
                resume_manifest = store.load_manifest(resume_id)
                resume_model = model_for(str(resume_manifest["provider"]))
                resumed_session = await _resume_productivity_session(
                    adapter,
                    store,
                    resume_id,
                    model=resume_model,
                )
            except (FileNotFoundError, KeyError, OSError, ValueError) as exc:
                cli.error(f"Unable to resume {resume_id}: {exc}")
                continue

            async def reload_catalog(new_session: AgentSession) -> None:
                nonlocal available_models, native_page
                available_models, native_page = await _load_productivity_catalog(
                    adapter,
                    new_session.provider,
                )

            session, context_usage = await _switch_productivity_session(
                adapter,
                runtime,
                session,
                resumed_session,
                active_model=resume_model or "default",
                update_project=True,
                before_header=reload_catalog,
                success=lambda new: f"Resumed {new.provider} session: {new.id}",
            )
            session_model = resume_model
            active_model = session_model or "default"
            continue
        if prompt == "/resume-native" or prompt.startswith("/resume-native "):
            native_id = _slash_command_argument(prompt, "/resume-native")
            if not native_id:
                cli.warning("Usage: /resume-native <native-thread-id>")
                continue
            native = next(
                (item for item in native_page.sessions if item.id == native_id),
                None,
            )
            try:
                resumed_session = await adapter.resume_session(
                    session.provider,
                    native_id,
                    project_path=(native.cwd if native is not None else session.project_path),
                    model=session_model,
                    project=session.project,
                )
            except (KeyError, OSError, ValueError) as exc:
                cli.error(f"Unable to resume native thread {native_id}: {exc}")
                continue
            session, context_usage = await _switch_productivity_session(
                adapter,
                runtime,
                session,
                resumed_session,
                active_model=active_model,
                update_project=True,
                success=lambda new: f"Attached native thread as Cleo session: {new.id}",
            )
            continue
        if prompt == "/native" or prompt.startswith("/native "):
            native_id = _slash_command_argument(prompt, "/native")
            if not native_id:
                cli.warning("Usage: /native <native-thread-id>")
                continue
            try:
                detail = await adapter.read_native_session(session.provider, native_id)
            except (KeyError, NotImplementedError, OSError, RuntimeError, ValueError) as exc:
                cli.error(f"Unable to read native thread {native_id}: {exc}")
                continue
            clear_screen()
            cli.render_native_session(detail)
            await asyncio.to_thread(cli.wait_for_return)
            clear_screen()
            render_active_header()
            continue
        if prompt == "/sessions":
            from cleo.sessions.hub import merge_session_rows

            _, native_page = await _load_productivity_catalog(
                adapter,
                session.provider,
            )
            clear_screen()
            cli.render_session_hub(
                merge_session_rows(
                    store.list_sessions(),
                    native_page.sessions,
                    provider=session.provider,
                )
            )
            await asyncio.to_thread(cli.wait_for_return)
            clear_screen()
            render_active_header()
            continue
        if prompt == "/account":
            try:
                account = await adapter.account_status(session.provider)
            except (NotImplementedError, OSError, RuntimeError) as exc:
                cli.error(str(exc))
                continue
            cli.render_account(account)
            continue
        if prompt == "/fork":
            try:
                forked = await adapter.fork_session(session.id)
            except (KeyError, NotImplementedError, OSError, RuntimeError) as exc:
                cli.error(f"Unable to fork session: {exc}")
                continue
            session, context_usage = await _switch_productivity_session(
                adapter,
                runtime,
                session,
                forked,
                active_model=active_model,
                success=lambda new: f"Forked native thread into session: {new.id}",
            )
            continue
        if prompt == "/rename" or prompt.startswith("/rename "):
            name = _slash_command_argument(prompt, "/rename")
            if not name:
                cli.warning("Usage: /rename <name>")
                continue
            try:
                await adapter.rename_session(session.id, name)
            except (KeyError, NotImplementedError, OSError, RuntimeError, ValueError) as exc:
                cli.error(f"Unable to rename session: {exc}")
                continue
            cli.success(f"Native thread renamed to: {name}")
            continue
        if prompt == "/compact":
            try:
                await adapter.compact_session(session.id)
            except (KeyError, NotImplementedError, OSError, RuntimeError) as exc:
                cli.error(f"Unable to compact native context: {exc}")
                continue
            context_usage = ContextWindowUsage()
            cli.success("Native Codex context compaction started.")
            continue
        if prompt == "/archive":
            try:
                await adapter.archive_session(session.id)
            except (KeyError, NotImplementedError, OSError, RuntimeError) as exc:
                cli.error(f"Unable to archive session: {exc}")
                continue
            session, context_usage = await _switch_productivity_session(
                adapter,
                runtime,
                session,
                partial(_restart_productivity_session, adapter, session, session_model),
                active_model=active_model,
                success=lambda _new: "Archived the native thread and started a new session.",
            )
            continue

        try:
            cli.console.print()
            await _prompt_productivity_session(
                adapter,
                session.id,
                prompt,
                model=active_model,
                context_usage=context_usage,
            )
            runtime.append_recent_threads(session.id, "productivity")
        except KeyboardInterrupt:
            cli.warning("Cancelling the active harness turn...")
            await adapter.cancel(session.id)
        except Exception as exc:
            cli.error(f"Productivity error: {exc}")
        cli.console.print()

    runtime.update_current_thread_id(None)
    runtime.update_current_project(None)
    runtime.update_runtime_json()


async def _run_productivity_mode(
    args: argparse.Namespace,
    runtime: Runtime,
    store: SessionStore,
    settings: SettingsModel,
    *,
    return_to_chat: bool = False,
) -> None:
    """productivity 模式入口: 建 adapter、创建/恢复会话, 再进交互循环或跑单条消息。

    参数:
        args: argparse.Namespace; 由 cleo/cli/application.py:174 的命令行入口
            或 cleo/cli/chat.py:403 的 /productivity slash command 传入,
            含 resume_id/provider/model/cwd/project/message 等字段。
        runtime / store: Runtime 与 SessionStore, 由上述调用方传入共享实例。
        settings: SettingsModel, 提供 productivity 配置(默认 provider、
            各 provider 模型、目录 profile)。
        return_to_chat: 是否退出后回到 chat; chat.py 的 /productivity 调用为 True。

    返回:
        None;结束时统一 adapter.aclose()。unknown provider、会话不存在或
        初始 harness session 启动失败时抛出
        :class:`ProductivityStartupError`,由顶层 CLI 或 chat 调用方按各自
        交互语义处理。
    """
    from cleo.integrations.harnesses.factory import build_agent_adapter

    adapter = build_agent_adapter(
        settings.active_directory_profile.root_path,
        settings.productivity,
        session_store=store,
    )

    if args.resume_id is not None and args.provider is None:
        try:
            resume_manifest = store.load_manifest(args.resume_id)
        except FileNotFoundError as exc:
            raise ProductivityStartupError(
                f"No saved session found for id: {args.resume_id}"
            ) from exc
        provider = str(resume_manifest["provider"])
    else:
        provider = args.provider or settings.productivity.default_provider
    if provider not in adapter.providers:
        available = ", ".join(adapter.providers)
        raise ProductivityStartupError(
            f"Unknown productivity provider {provider!r}; available: {available}"
        )

    model = args.model or settings.productivity.provider(provider).model
    display_model = model or "default"
    provider_models = {
        name: provider_settings.model
        for name, provider_settings in settings.productivity.providers.items()
        if provider_settings.enabled
    }
    project_path = args.cwd or "."
    project = args.project
    try:
        if args.resume_id is not None:
            session = await _resume_productivity_session(
                adapter,
                store,
                args.resume_id,
                model=model,
                provider_override=args.provider,
                cwd_override=args.cwd,
                project_override=args.project,
            )
        else:
            session = await adapter.create_session(
                provider,
                project_path=project_path,
                model=model,
                project=project,
            )
    except FileNotFoundError as exc:
        raise ProductivityStartupError(
            f"No saved session found for id: {args.resume_id}"
        ) from exc
    except (KeyError, ValueError) as exc:
        raise ProductivityStartupError(f"Unable to start productivity session: {exc}") from exc

    runtime.update_current_space("productivity")
    runtime.update_current_project(session.project)
    runtime.update_current_thread_id(session.id)
    runtime.append_recent_threads(session.id, "productivity")

    try:
        if args.message is None:
            await _run_productivity_loop(
                adapter,
                session,
                runtime,
                store,
                model=args.model,
                provider_models=provider_models,
                return_to_chat=return_to_chat,
            )
        else:
            context_usage = ContextWindowUsage()
            _render_productivity_header(
                adapter,
                session,
                active_model=display_model,
                context_usage=context_usage,
            )
            await _prompt_productivity_session(
                adapter,
                session.id,
                args.message,
                model=display_model,
                context_usage=context_usage,
            )
            await _finish_productivity_session(adapter, session, runtime)
            runtime.update_current_thread_id(None)
            runtime.update_current_project(None)
            runtime.update_runtime_json()
    finally:
        await adapter.aclose()
