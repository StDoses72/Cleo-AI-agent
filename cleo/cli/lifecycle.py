"""Session persistence and memory-consolidation lifecycle helpers."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import TYPE_CHECKING

from langchain_core.messages import BaseMessage

from cleo.cli.context import cli

if TYPE_CHECKING:
    from cleo.agents import Agent
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


def _has_meaningful_content(content: object) -> bool:
    """Return whether a persisted user message contains actual input."""
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, dict):
        return any(_has_meaningful_content(value) for value in content.values())
    if isinstance(content, (list, tuple, set)):
        return any(_has_meaningful_content(value) for value in content)
    return content is not None and bool(content)


def _has_user_interaction(events: list[dict[str, object]]) -> bool:
    """Return whether the session includes at least one non-empty user turn."""
    return any(
        event.get("type") == "user_message" and _has_meaningful_content(event.get("content"))
        for event in events
    )


async def _sync_session_events(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    fallback_messages: list[BaseMessage] | None = None,
    *,
    status: str = "active",
    store: SessionStore | None = None,
) -> None:
    """把当前线程的 LangGraph 状态快照同步到 SessionStore 做会话持久化。

    参数:
        agent: 当前 :class:`~cleo.agents.Agent`;通过
            ``agent.deepagent.aget_state`` 读取 checkpointer 中的消息状态。
            由 ``amain()`` (application.py) 或 ``_run_chat_loop`` (chat.py)
            的调用点传入。
        runtime: 全局 :class:`~cleo.runtime.state.Runtime`;提供
            ``current_space`` / ``current_project``,并在同步后调用
            ``append_recent_threads`` 更新最近线程列表。
        thread_id: 要持久化的线程 id;来自 ``amain()`` 的参数解析结果或
            ``_run_chat_loop`` 的循环局部变量。
        fallback_messages: 当 checkpointer 中尚无消息(如新建线程被立即
            关闭)时使用的回退消息列表;调用方传入恢复会话时的
            ``restored_messages``。缺省 None 表示无回退。
        status: 写入 manifest 的会话状态(``active`` / ``completed`` /
            ``interrupted``);由各调用点按退出或切换场景指定,缺省
            ``"active"``。
        store: 复用的 :class:`~cleo.sessions.store.SessionStore` 实例;由
            ``amain()`` 与 ``_run_chat_loop`` 传入共享实例,避免每轮对话
            重复构造(构造会执行 ``_ensure_index`` DDL)。缺省 None 时惰性
            构造一个(供 tests 等无既有 store 的调用方使用)。

    返回值:
        None。持久化结果写入 ``SessionStore`` (``sync_langchain_messages``,
        cleo/sessions/store.py),供 ``/resume``、``/sessions`` 列表及
        DreamAgent 后续读取;调用方不消费返回值。
    """
    from cleo.config.settings import settings
    from cleo.sessions.store import SessionStore

    config = {"configurable": {"thread_id": thread_id}}
    state = await agent.deepagent.aget_state(config)
    thread_messages = state.values.get("messages", [])
    if not thread_messages and fallback_messages is not None:
        thread_messages = fallback_messages
    if store is None:
        store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    store.sync_langchain_messages(
        session_id=thread_id,
        space=runtime.current_space,
        project=runtime.current_project or "general",
        messages=thread_messages,
        provider="cleo",
        owner_type="user",
        cwd=str(settings.active_directory_profile.root_path),
        status=status,
    )
    runtime.append_recent_threads(thread_id, runtime.current_space)


async def _run_dream_agent(
    thread_id: str,
    project: str | None,
    space: str,
) -> None:
    """对已结束的会话触发 DreamAgent 做 memory consolidation(记忆固化)。

    参数:
        thread_id: 待固化的线程 id;由 ``amain()`` one-shot 分支
            (application.py)、``_run_chat_loop`` 的 ``/quit`` 与 ``/project``
            切换分支 (chat.py)、以及 productivity 会话结束时
            (productivity.py) 传入。
        project: 会话所属 project 名;None 时回退为 ``"general"``。来自调用
            点的 ``runtime.current_project`` 或会话 manifest 中的 project。
        space: 会话所属空间(``"non_productivity"`` / ``"productivity"``);
            来自 ``runtime.current_space`` 或调用点字面量。

    返回值:
        None。固化产物由 :meth:`DreamAgent.invoke` (cleo/agents/dream.py)
        写入 project memory;本函数只负责显示 status spinner 与成功/失败
        提示,异常被捕获后仅输出 ``cli.error``,不向调用方传播。
    """
    from cleo.config.settings import settings
    from cleo.sessions.store import SessionStore

    project_name = project or "general"
    try:
        store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
        if not _has_user_interaction(store.read_events(thread_id)):
            return

        from cleo.agents import DreamAgent

        with cli.status(f"Consolidating {space}/{project_name}/{thread_id} with DreamAgent..."):
            result = await DreamAgent().invoke(
                session_id=thread_id,
                project=project_name,
                space=space,
            )
        if isinstance(result, dict) and result.get("status") == "skipped":
            cli.info(f"Memory consolidation skipped: {result.get('reason', 'not needed')}")
        else:
            cli.success("DreamAgent memory consolidation finished.")
    except Exception as exc:
        cli.error(f"DreamAgent memory consolidation failed: {exc}")


def _launch_dream_agent_worker(
    jobs: list[tuple[str, str | None, str]],
    *,
    store: SessionStore | None = None,
) -> bool:
    """Launch one detached worker to consolidate interactive sessions in order."""
    unique_jobs: list[tuple[str, str | None, str]] = []
    seen: set[tuple[str, str | None, str]] = set()
    for thread_id, project, space in jobs:
        job = (str(thread_id), project, str(space))
        if not job[0] or job in seen:
            continue
        seen.add(job)
        unique_jobs.append(job)
    if store is not None:
        meaningful_jobs: list[tuple[str, str | None, str]] = []
        for job in unique_jobs:
            try:
                events = store.read_events(job[0])
            except (FileNotFoundError, OSError, ValueError):
                continue
            if _has_user_interaction(events):
                meaningful_jobs.append(job)
        unique_jobs = meaningful_jobs
    if not unique_jobs:
        return False

    command = [
        sys.executable,
        "-m",
        "cleo.cli.dream_worker",
        json.dumps(unique_jobs, ensure_ascii=False),
    ]
    kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(command, **kwargs)  # noqa: S603
    except OSError:
        return False
    return True
