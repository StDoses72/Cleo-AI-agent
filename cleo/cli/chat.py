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
    cli.render_chat_header(
        thread_id,
        runtime.current_project or "general",
        model=str(getattr(agent, "model_name", "unknown")),
        context_usage=getattr(agent, "context_usage", None),
    )


def _new_thread_id() -> str:
    return f"local-{uuid.uuid4().hex[:12]}"


def _project_name(value: str) -> str:
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
    messages: list[tuple[str, str]] = []
    for msg in loaded_messages:
        content = _message_content_to_text(getattr(msg, "content", "")).strip()
        if not content:
            continue
        messages.append((_message_role(msg), content))
    cli.render_restored_messages(thread_id, messages)
