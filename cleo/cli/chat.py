"""Interactive Cleo chat flow."""

from __future__ import annotations

import argparse
import asyncio
import base64
import mimetypes
import os
import uuid
from typing import TYPE_CHECKING

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from cleo.cli.context import clear_screen, cli
from cleo.cli.lifecycle import _run_dream_agent, _sync_session_events
from cleo.cli.productivity import _run_productivity_mode, _slash_command_argument

if TYPE_CHECKING:
    from cleo.agents import Agent
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore

SUPPORTED_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def _render_chat_header(agent: Agent, runtime: Runtime, thread_id: str) -> None:
    """在终端渲染当前会话的 chat header(品牌、project 面包屑、模型与上下文用量)。

    参数:
        agent: 当前 :class:`~cleo.agents.Agent` 实例,来自 ``amain()`` 构造或
            ``_run_chat_loop`` 内 ``/project``、``/resume`` 命令重建的 agent;
            用于读取 ``model_name`` 与 ``context_usage`` 属性。
        runtime: 全局 :class:`~cleo.runtime.state.Runtime`,提供
            ``current_project``;由 ``amain()`` 创建并传入。
        thread_id: 当前会话线程 id,由 ``_new_thread_id()`` 生成或来自
            ``--thread-id`` / ``--resume`` / ``/resume`` 参数。

    返回值:
        None。渲染结果直接输出到终端(经 ``cli.render_chat_header``),
        无下游消费者。调用方:``application.amain`` (application.py) 与
        ``_run_chat_loop`` 的启动及各斜杠命令分支。
    """
    cli.render_chat_header(
        thread_id,
        runtime.current_project or "general",
        model=str(getattr(agent, "model_name", "unknown")),
        context_usage=getattr(agent, "context_usage", None),
    )


def _new_thread_id() -> str:
    """生成一个新的本地会话 thread id(``local-<12位hex>``)。

    无参数。被 ``application.amain`` (application.py) 与 ``_run_chat_loop``
    的 ``/new``、``/project`` 切换分支调用,用于开启新线程。

    返回值:
        str: 形如 ``local-xxxxxxxxxxxx`` 的线程 id;由调用方赋给
        ``thread_id`` 局部变量,随后传给 ``runtime.update_current_thread_id``、
        ``_render_chat_header``、``_sync_session_events`` 等消费。
    """
    return f"local-{uuid.uuid4().hex[:12]}"


def _project_name(value: str) -> str:
    """校验 project 名称必须是纯名称而非路径(argparse 的 ``type=`` 回调)。

    参数:
        value: 待校验的原始字符串。来源有两处:一是 argparse 框架解析
            ``--project`` 选项时由 ``parser.add_argument(..., type=_project_name)``
            (application.py) 自动调用;二是 ``_run_chat_loop`` 内处理
            ``/project`` 与 ``/project move`` 斜杠命令时直接调用。

    返回值:
        str: 去除首尾空白后的合法 project 名;argparse 场景下存入
        ``args.project``,斜杠命令场景下作为切换/移动目标名。非法输入(空串
        或含 ``/``、``\\``、``..``)抛出 ``argparse.ArgumentTypeError``,
        由 argparse 框架转为用法错误,或被 ``_run_chat_loop`` 捕获后提示用法。
    """
    project = value.strip()
    if not project or any(part in project for part in ("/", "\\", "..")):
        raise argparse.ArgumentTypeError("project must be a name, not a path")
    return project


async def _print_streaming_reply(
    agent: Agent,
    message: str,
    thread_id: str,
    loaded_info: list[BaseMessage] | None = None,
    images: list[dict[str, str]] | None = None,
) -> None:
    """将一条用户消息发给 agent 并把流式回复逐段渲染到终端。

    参数:
        agent: 当前 :class:`~cleo.agents.Agent`;调用方 ``amain()`` 构造或
            ``_run_chat_loop`` 的循环局部变量。其 ``stream_text`` 异步生成器
            (cleo/agents/cleo.py) 产出文本片段。
        message: 用户输入文本;one-shot 场景来自 ``args.message``
            (application.py),交互场景来自 ``cli.prompt`` 的返回值
            (``_run_chat_loop`` 内)。
        thread_id: 当前线程 id,由 ``_new_thread_id()`` 或 ``--thread-id`` /
            ``--resume`` 提供;作为 LangGraph checkpointer 的 thread 键。
        loaded_info: 恢复会话时从 ``SessionStore.load_langchain_messages``
            读出的历史消息;仅首轮传入,之后调用方置 None。缺省 None。
        images: ``/attach`` 命令收集的图片附件(base64/mime_type/name 字典
            列表);缺省 None 表示无附件。

    返回值:
        None。文本片段经 ``cli.stream_assistant`` 直接输出到终端;结束后通过
        ``cli.render_runtime_status`` 渲染模型与 context 用量状态栏。调用方
        (``amain`` 的 one-shot 分支与 ``_run_chat_loop``)不消费返回值。
    """
    received_text = False
    cli.begin_assistant()
    async for text in agent.stream_text(
        message,
        thread_id=thread_id,
        loaded_info=loaded_info,
        images=images,
    ):
        received_text = True
        cli.stream_assistant(text)
    cli.end_assistant(received=received_text)
    cli.render_runtime_status(
        str(getattr(agent, "model_name", "unknown")),
        getattr(agent, "context_usage", None),
        accent="cyan",
    )


async def _run_chat_loop(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    restored_messages: list[BaseMessage] | None = None,
    store: SessionStore | None = None,
) -> None:
    """运行交互式 chat 主循环:读取用户输入、处理斜杠命令并流式回复。

    参数:
        agent: 当前 :class:`~cleo.agents.Agent`,由 ``amain()`` 按
            ``runtime.current_project``/``current_space`` 构造;循环内
            ``/project``、``/resume`` 命令会重建并替换该局部引用。
        runtime: 全局 :class:`~cleo.runtime.state.Runtime`,由 ``amain()``
            创建;用于读写 current project/space/thread 并落盘 runtime.json。
        thread_id: 初始线程 id,由 ``amain()`` 依据 ``--thread-id``、
            ``--resume`` 或 ``_new_thread_id()`` 决定。
        restored_messages: ``--resume`` / ``/resume`` 恢复时经
            ``SessionStore.load_langchain_messages`` 读出的历史消息;
            首轮回复后由本函数置 None。缺省 None 表示全新会话。
        store: 会话存储;``amain()`` 传入共享实例,缺省时本函数惰性构造
            (``SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)``)。

    返回值:
        None。循环直到 ``/quit``、``/exit``、EOF 或 KeyboardInterrupt 才
        break;期间通过 ``_sync_session_events`` 持久化会话、通过
        ``_run_dream_agent`` 做 memory consolidation。调用方为
        ``application.amain`` (application.py) 及 tests/cli/test_application.py。
    """
    if store is None:
        from cleo.config.settings import settings
        from cleo.sessions.store import SessionStore

        store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    runtime.update_current_thread_id(thread_id)
    cli.render_startup_splash(
        thread_id,
        runtime.current_project or "general",
        model=str(getattr(agent, "model_name", "unknown")),
    )
    _render_chat_header(agent, runtime, thread_id)
    if restored_messages:
        _print_restored_messages(thread_id, restored_messages)
    attachment_list: list[dict[str, str]] = []
    while True:
        try:
            if attachment_list:
                cli.render_attachments([item["name"] for item in attachment_list])
            message = await asyncio.to_thread(
                cli.prompt,
                "chat",
                sessions=store.list_sessions(space="non_productivity"),
                projects=tuple(runtime.projects_for("non_productivity")),
            )

        except EOFError:
            cli.console.print()
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="interrupted",
            )
            runtime.update_runtime_json()
            break
        except KeyboardInterrupt:
            cli.console.print()
            cli.warning("Chat interrupted by user. Exiting.")
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="interrupted",
            )
            runtime.update_runtime_json()
            break

        if not message:
            continue
        if message in {"/quit", "/exit"}:
            cli.info(f"Closing session event log: {thread_id}")
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="completed",
            )
            await _run_dream_agent(
                thread_id,
                runtime.current_project,
                runtime.current_space,
            )
            runtime.update_current_project(None)
            runtime.update_current_thread_id(None)
            runtime.update_runtime_json()
            cli.success("Session closed. Goodbye!")
            break
        if message == "/new":
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="completed",
            )
            thread_id = _new_thread_id()
            restored_messages = None
            runtime.update_current_thread_id(thread_id)
            runtime.update_runtime_json()
            clear_screen()
            _render_chat_header(agent, runtime, thread_id)
            cli.success(f"Started new thread: {thread_id}")
            continue

        if message == "/rename" or message.startswith("/rename "):
            title = _slash_command_argument(message, "/rename")
            if not title:
                cli.warning("Usage: /rename <title>")
                continue
            try:
                await _sync_session_events(
                    agent,
                    runtime,
                    thread_id,
                    restored_messages,
                    status="active",
                )
                renamed = store.rename_session(thread_id, title)
            except (FileNotFoundError, OSError, ValueError) as exc:
                cli.error(f"Unable to rename thread {thread_id}: {exc}")
                continue
            cli.success(f"Renamed thread to {renamed['title']!r}.")
            continue

        if message == "/project" or message.startswith("/project "):
            project_argument = _slash_command_argument(message, "/project")
            known_projects = runtime.projects_for("non_productivity")
            if not project_argument:
                current_project = runtime.current_project or "general"
                project_sessions = store.list_sessions(
                    space="non_productivity",
                    project=current_project,
                )
                if not any(row.get("id") == thread_id for row in project_sessions):
                    project_sessions.insert(
                        0,
                        {
                            "id": thread_id,
                            "title": None,
                            "status": "active",
                            "updated_at": "",
                        },
                    )
                cli.render_project_sessions(
                    current_project,
                    project_sessions,
                    current_thread_id=thread_id,
                    known_projects=tuple(known_projects),
                )
                continue

            if project_argument == "move" or project_argument.startswith("move "):
                target_argument = project_argument.removeprefix("move").strip()
                if not target_argument:
                    cli.warning("Usage: /project move <name>")
                    continue
                try:
                    target_project = _project_name(target_argument)
                except argparse.ArgumentTypeError as exc:
                    cli.warning(f"Usage: /project move <name> ({exc})")
                    continue
                if target_project == runtime.current_project:
                    cli.info(f"Thread {thread_id} is already in project {target_project!r}.")
                    continue

                from cleo.agents import Agent

                try:
                    moved_agent = Agent(
                        project=target_project,
                        space="non_productivity",
                    )
                    await _sync_session_events(
                        agent,
                        runtime,
                        thread_id,
                        restored_messages,
                        status="active",
                    )
                    moved_messages = store.load_langchain_messages(thread_id)
                    store.move_session(thread_id, target_project)
                except (FileNotFoundError, OSError, ValueError) as exc:
                    cli.error(f"Unable to move thread {thread_id}: {exc}")
                    continue

                created = target_project not in known_projects
                agent = moved_agent
                restored_messages = moved_messages
                runtime.update_current_space("non_productivity")
                runtime.update_current_project(target_project)
                runtime.update_current_thread_id(thread_id)
                runtime.update_runtime_json()
                clear_screen()
                _render_chat_header(agent, runtime, thread_id)
                action = "Created project and moved" if created else "Moved"
                cli.success(
                    f"{action} thread {thread_id} to project {target_project!r}; "
                    "context preserved."
                )
                continue

            try:
                next_project = _project_name(project_argument)
            except argparse.ArgumentTypeError as exc:
                cli.warning(f"Usage: /project <name> ({exc})")
                continue
            if next_project == runtime.current_project:
                cli.info(f"Project {next_project!r} is already active.")
                continue

            from cleo.agents import Agent

            try:
                next_agent = Agent(
                    project=next_project,
                    space="non_productivity",
                )
            except Exception as exc:
                cli.error(f"Unable to open project {next_project!r}: {exc}")
                continue

            previous_project = runtime.current_project or "general"
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="completed",
            )
            try:
                completed_manifest = store.load_manifest(thread_id)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                completed_manifest = {}
            if int(completed_manifest.get("last_event_seq", 0)) > 0:
                await _run_dream_agent(
                    thread_id,
                    previous_project,
                    "non_productivity",
                )

            created = next_project not in known_projects
            agent = next_agent
            thread_id = _new_thread_id()
            restored_messages = None
            attachment_list = []
            runtime.update_current_space("non_productivity")
            runtime.update_current_project(next_project)
            runtime.update_current_thread_id(thread_id)
            runtime.update_runtime_json()
            clear_screen()
            _render_chat_header(agent, runtime, thread_id)
            action = "Created and switched to" if created else "Switched to"
            cli.success(f"{action} project {next_project!r}; new thread: {thread_id}")
            continue

        if message == "/resume" or message.startswith("/resume "):
            resume_id = _slash_command_argument(message, "/resume")
            if not resume_id:
                cli.warning("Usage: /resume <cleo-session-id>")
                continue
            if resume_id == thread_id:
                cli.info(f"Thread {thread_id} is already active.")
                continue
            try:
                manifest = store.load_manifest(resume_id)
                if (
                    manifest["space"] != "non_productivity"
                    or manifest["provider"] != "cleo"
                ):
                    raise ValueError(f"Session {resume_id} is not a Cleo chat thread.")
                loaded_messages = store.load_langchain_messages(resume_id)
                saved_project = str(manifest["project"])
                from cleo.agents import Agent

                resumed_agent = Agent(
                    project=saved_project,
                    space="non_productivity",
                )
            except (FileNotFoundError, KeyError, OSError, ValueError) as exc:
                cli.error(f"Unable to resume {resume_id}: {exc}")
                continue

            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="completed",
            )
            agent = resumed_agent
            thread_id = resume_id
            restored_messages = loaded_messages
            attachment_list = []
            runtime.update_current_space("non_productivity")
            runtime.update_current_project(saved_project)
            runtime.update_current_thread_id(thread_id)
            runtime.append_recent_threads(thread_id, "non_productivity")
            runtime.update_runtime_json()
            clear_screen()
            _render_chat_header(agent, runtime, thread_id)
            _print_restored_messages(thread_id, restored_messages)
            cli.success(f"Resumed Cleo thread: {thread_id}")
            continue

        if message == "/sessions":
            clear_screen()
            cli.render_session_hub(store.list_sessions())
            await asyncio.to_thread(cli.wait_for_return)
            clear_screen()
            _render_chat_header(agent, runtime, thread_id)
            continue

        if message == "/productivity":
            from cleo.config.settings import settings

            saved_space = runtime.current_space
            saved_project = runtime.current_project or "general"
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="active",
            )
            productivity_args = argparse.Namespace(
                message=None,
                provider=None,
                cwd=str(settings.active_directory_profile.root_path),
                model=None,
                project=saved_project,
                resume_id=None,
            )
            try:
                clear_screen()
                await _run_productivity_mode(
                    productivity_args,
                    runtime,
                    store,
                    settings,
                    return_to_chat=True,
                )
            except (Exception, SystemExit) as exc:
                cli.error(f"Unable to open productivity mode: {exc}")
            finally:
                runtime.update_current_space(saved_space)
                runtime.update_current_project(saved_project)
                runtime.update_current_thread_id(thread_id)
                runtime.append_recent_threads(thread_id, saved_space)
            clear_screen()
            _render_chat_header(agent, runtime, thread_id)
            cli.success("Returned to Cleo chat.")
            continue

        if message == "/attach":
            cli.info(
                "Enter the file path to attach or leave empty to cancel "
                "(currently support image files only):"
            )
            file_path = (await asyncio.to_thread(cli.field_prompt, "file")).strip("\"'")
            if file_path:
                if not os.path.isfile(file_path):
                    cli.error(f"File not found: {file_path}")
                    continue
                mime_type, _ = mimetypes.guess_type(file_path)
                if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
                    cli.error(f"Unsupported image type: {mime_type or 'unknown'}")
                    continue
                with open(file_path, "rb") as f:
                    base64_image = base64.b64encode(f.read()).decode("utf-8")
                attachment_list.append(
                    {
                        "base64": base64_image,
                        "mime_type": mime_type,
                        "name": os.path.basename(file_path),
                    }
                )
            continue

        try:
            cli.console.print()
            await _print_streaming_reply(
                agent,
                message,
                thread_id,
                loaded_info=restored_messages,
                images=attachment_list,
            )
            restored_messages = None
            attachment_list = []
            await _sync_session_events(agent, runtime, thread_id, status="active")
        except KeyboardInterrupt:
            cli.console.print()
            cli.warning("Chat interrupted by user. Exiting.")
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                restored_messages,
                status="interrupted",
            )
            runtime.update_runtime_json()
            break
        except Exception as exc:
            cli.error(str(exc))
            continue

        cli.console.print()


def _message_role(message: BaseMessage) -> str:
    """把 LangChain 消息对象映射为展示用的角色标签。

    参数:
        message: 单条 :class:`BaseMessage` 及其子类实例;由
            ``_print_restored_messages`` 遍历恢复的历史消息列表时传入。

    返回值:
        str: ``User``/``Assistant``/``System``/``Tool`` 之一,未知子类回退为
        类名;由 ``_print_restored_messages`` 收集进 ``(role, content)`` 元组,
        最终传给 ``cli.render_restored_messages`` 渲染。
    """
    if isinstance(message, HumanMessage):
        return "User"
    if isinstance(message, AIMessage):
        return "Assistant"
    if isinstance(message, SystemMessage):
        return "System"
    if isinstance(message, ToolMessage):
        return "Tool"
    return message.__class__.__name__


def _message_content_to_text(content: object) -> str:
    """把 LangChain 消息的 content(字符串或 content block 列表)展平为纯文本。

    参数:
        content: 消息对象的 ``content`` 属性,可能是 ``str``、由 ``str`` /
            ``dict`` block 组成的 ``list``(multimodal 消息),或其他对象;由
            ``_print_restored_messages`` 以 ``getattr(msg, "content", "")`` 传入。

    返回值:
        str: 拼接后的纯文本(block 间以换行连接,只取 block 的 ``text`` /
        ``content`` 字段);由 ``_print_restored_messages`` strip 后作为展示
        内容传给 ``cli.render_restored_messages``。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if text:
                    parts.append(str(text))
        return "\n".join(part for part in parts if part)
    return str(content)


def _print_restored_messages(thread_id: str, loaded_messages: list[BaseMessage]) -> None:
    """把恢复的历史消息渲染为终端中的只读回放。

    参数:
        thread_id: 当前线程 id;由 ``_run_chat_loop`` 在启动(有
            ``restored_messages``)及 ``/resume`` 分支传入,用于渲染标题。
        loaded_messages: 经 ``SessionStore.load_langchain_messages`` 读出的
            历史 :class:`BaseMessage` 列表。

    返回值:
        None。``(role, content)`` 元组列表交给 ``cli.render_restored_messages``
        输出到终端;空内容消息被跳过。仅被 ``_run_chat_loop`` 调用。
    """
    messages: list[tuple[str, str]] = []
    for msg in loaded_messages:
        content = _message_content_to_text(getattr(msg, "content", "")).strip()
        if not content:
            continue
        messages.append((_message_role(msg), content))
    cli.render_restored_messages(thread_id, messages)
