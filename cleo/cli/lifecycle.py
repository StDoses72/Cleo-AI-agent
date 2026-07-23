"""Session persistence and memory-consolidation lifecycle helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING

from langchain_core.messages import BaseMessage

from cleo.cli.context import cli

if TYPE_CHECKING:
    from cleo.agents import Agent
    from cleo.runtime.state import Runtime


async def _sync_session_events(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    fallback_messages: list[BaseMessage] | None = None,
    *,
    status: str = "active",
) -> None:
    from cleo.config.settings import settings
    from cleo.sessions.store import SessionStore

    config = {"configurable": {"thread_id": thread_id}}
    state = await agent.deepagent.aget_state(config)
    thread_messages = state.values.get("messages", [])
    if not thread_messages and fallback_messages is not None:
        thread_messages = fallback_messages
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
    from cleo.agents import DreamAgent

    project_name = project or "general"
    try:
        with cli.status(
            f"Consolidating {space}/{project_name}/{thread_id} with DreamAgent..."
        ):
            await DreamAgent().invoke(
                session_id=thread_id,
                project=project_name,
                space=space,
            )
        cli.success("DreamAgent memory consolidation finished.")
    except Exception as exc:
        cli.error(f"DreamAgent memory consolidation failed: {exc}")
