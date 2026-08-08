"""Interactive Cleo chat flow."""

from __future__ import annotations

import argparse
import uuid
from typing import TYPE_CHECKING

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from cleo.cli.context import cli

if TYPE_CHECKING:
    from cleo.agents import Agent
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


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
        model=agent.model_name,
        context_usage=agent.context_usage,
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
        agent.model_name,
        agent.context_usage,
        accent="cyan",
    )


async def _run_chat_loop(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    restored_messages: list[BaseMessage] | None = None,
    store: SessionStore | None = None,
) -> None:
    """Run the full-screen Textual Cleo chat interface."""
    if store is None:
        from cleo.config.settings import settings
        from cleo.sessions.store import SessionStore

        store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)

    from cleo.cli.chat_tui import run_chat_tui

    await run_chat_tui(
        agent,
        runtime,
        thread_id,
        store,
        restored_messages=restored_messages,
    )


def _message_role(message: BaseMessage) -> str:
    """把 LangChain 消息对象映射为展示用的角色标签。

    参数:
        message: 单条 :class:`BaseMessage` 及其子类实例;由 Textual chat
            恢复历史消息时传入。

    返回值:
        str: ``User``/``Assistant``/``System``/``Tool`` 之一,未知子类回退为
        类名。
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
            ``dict`` block 组成的 ``list``(multimodal 消息),或其他对象；由
            Textual chat 从恢复的 LangChain message 传入。

    返回值:
        str: 拼接后的纯文本(block 间以换行连接,只取 block 的 ``text`` /
        ``content`` 字段);由 Textual chat 作为历史消息内容渲染。
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
