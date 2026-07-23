from __future__ import annotations

import argparse
import asyncio
import base64
import mimetypes
import os
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from core.cli import CleoCLI
from core.usage import ContextWindowUsage

if TYPE_CHECKING:
    from config.settings import SettingsModel
    from core.agent import Agent
    from core.integrations.agent_adapter import AgentAdapter, AgentResult, AgentSession
    from core.memory.session_store import SessionStore
    from core.runtime.model import Runtime

SUPPORTED_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
LOCAL_CONFIG_PATH = "config/cleo.json"
LOCAL_HARNESSES_CONFIG_PATH = "config/harnesses.json"
CONFIG_TEMPLATE_PATH = Path(__file__).resolve().parent / "config" / "cleo.example.json"
HARNESSES_TEMPLATE_PATH = (
    Path(__file__).resolve().parent / "config" / "harnesses.example.json"
)
cli = CleoCLI()


def clear_screen() -> None:
    cli.clear()


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


async def _sync_session_events(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    fallback_messages: list[BaseMessage] | None = None,
    *,
    status: str = "active",
) -> None:
    from config.settings import settings
    from core.memory.session_store import SessionStore

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
    from core.agent import DreamAgent

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


async def _prompt_productivity_session(
    adapter: AgentAdapter,
    session_id: str,
    prompt: str,
    *,
    model: str,
    context_usage: ContextWindowUsage,
) -> AgentResult:
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
    await adapter.close(session.id)
    runtime.append_recent_threads(session.id, "productivity")
    await _run_dream_agent(session.id, session.project, "productivity")


def _slash_command_argument(prompt: str, command: str) -> str:
    argument = prompt.removeprefix(command).strip()
    if (
        len(argument) >= 2
        and argument[0] in {'"', "'"}
        and argument[-1] == argument[0]
    ):
        return argument[1:-1]
    return argument


def _resolve_productivity_cwd(argument: str, current_cwd: str) -> str:
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
    from core.integrations.agent_adapter import NativeSessionPage

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
    session_options = getattr(adapter, "session_options", None)
    if not callable(session_options):
        return None
    try:
        return session_options(session_id)
    except (KeyError, NotImplementedError):
        return None


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
    exit_action = "return to Cleo chat" if return_to_chat else "exit"
    configured_models = provider_models or {}

    def model_for(provider: str) -> str | None:
        return model or configured_models.get(provider)

    session_model = model_for(session.provider)
    active_model = session_model or "default"
    context_usage = ContextWindowUsage()
    available_models, native_page = await _load_productivity_catalog(
        adapter,
        session.provider,
    )

    def render_active_controls() -> None:
        from core.git_status import inspect_git_status

        cli.render_productivity_controls(
            _productivity_options(adapter, session.id),
            inspect_git_status(session.project_path),
        )

    def render_active_header() -> None:
        from core.git_status import inspect_git_status

        cli.render_productivity_header(
            session,
            model=active_model,
            context_usage=context_usage,
            options=_productivity_options(adapter, session.id),
            git_status=inspect_git_status(session.project_path),
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
            await _finish_productivity_session(adapter, session, runtime)
            session = await adapter.create_session(
                session.provider,
                project_path=session.project_path,
                model=session_model,
                project=session.project,
            )
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            context_usage = ContextWindowUsage()
            clear_screen()
            render_active_header()
            cli.success(f"Started new {session.provider} session: {session.id}")
            continue
        if prompt == "/cwd":
            cli.info(session.project_path)
            continue
        if prompt == "/project":
            from core.git_status import inspect_git_status

            cli.info(f"{session.project} · {session.project_path}")
            cli.render_git_status(inspect_git_status(session.project_path))
            continue
        if prompt == "/git":
            from core.git_status import inspect_git_status

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
            try:
                options = await adapter.update_session_options(
                    session.id,
                    model=requested,
                )
            except (KeyError, NotImplementedError, ValueError) as exc:
                cli.error(str(exc))
                continue
            session_model = options.model
            active_model = session_model or "default"
            cli.success(f"Model set to {active_model}; it applies to the next turn.")
            cli.render_runtime_status(
                active_model,
                context_usage,
                accent="magenta",
            )
            render_active_controls()
            continue
        if prompt == "/effort" or prompt.startswith("/effort "):
            requested = _slash_command_argument(prompt, "/effort")
            current = _productivity_options(adapter, session.id)
            if not requested:
                cli.info(f"Reasoning effort: {(current and current.effort) or 'default'}")
                continue
            try:
                options = await adapter.update_session_options(
                    session.id,
                    effort=requested,
                )
            except (KeyError, NotImplementedError, ValueError) as exc:
                cli.error(str(exc))
                continue
            cli.success(f"Reasoning effort set to {options.effort}.")
            render_active_controls()
            continue
        if prompt == "/access" or prompt.startswith("/access "):
            requested = _slash_command_argument(prompt, "/access")
            current = _productivity_options(adapter, session.id)
            if not requested:
                cli.info(f"Filesystem access: {(current and current.sandbox) or 'default'}")
                continue
            try:
                options = await adapter.update_session_options(
                    session.id,
                    sandbox=requested,
                )
            except (KeyError, NotImplementedError, ValueError) as exc:
                cli.error(str(exc))
                continue
            cli.success(f"Filesystem access set to {options.sandbox}.")
            render_active_controls()
            continue
        if prompt == "/approval" or prompt.startswith("/approval "):
            requested = _slash_command_argument(prompt, "/approval")
            current = _productivity_options(adapter, session.id)
            if not requested:
                cli.info(
                    f"Approval behavior: "
                    f"{(current and current.approval_mode) or 'default'}"
                )
                continue
            try:
                options = await adapter.update_session_options(
                    session.id,
                    approval_mode=requested,
                )
            except (KeyError, NotImplementedError, ValueError) as exc:
                cli.error(str(exc))
                continue
            cli.success(f"Approval behavior set to {options.approval_mode}.")
            render_active_controls()
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
            previous_session = session
            await _finish_productivity_session(adapter, previous_session, runtime)
            session = next_session
            runtime.update_current_project(session.project)
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            context_usage = ContextWindowUsage()
            clear_screen()
            render_active_header()
            cli.success(
                f"Changed cwd to {session.project_path}; started session {session.id}."
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
            previous_session = session
            await _finish_productivity_session(adapter, previous_session, runtime)
            session = resumed_session
            session_model = resume_model
            active_model = session_model or "default"
            runtime.update_current_project(session.project)
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            context_usage = ContextWindowUsage()
            clear_screen()
            available_models, native_page = await _load_productivity_catalog(
                adapter,
                session.provider,
            )
            render_active_header()
            cli.success(f"Resumed {session.provider} session: {session.id}")
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
            previous_session = session
            await _finish_productivity_session(adapter, previous_session, runtime)
            session = resumed_session
            runtime.update_current_project(session.project)
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            context_usage = ContextWindowUsage()
            clear_screen()
            render_active_header()
            cli.success(f"Attached native thread as Cleo session: {session.id}")
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
            from core.session_hub import merge_session_rows

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
            previous_session = session
            await _finish_productivity_session(adapter, previous_session, runtime)
            session = forked
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            context_usage = ContextWindowUsage()
            clear_screen()
            render_active_header()
            cli.success(f"Forked native thread into session: {session.id}")
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
            await _finish_productivity_session(adapter, session, runtime)
            session = await adapter.create_session(
                session.provider,
                project_path=session.project_path,
                model=session_model,
                project=session.project,
            )
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            context_usage = ContextWindowUsage()
            clear_screen()
            render_active_header()
            cli.success("Archived the native thread and started a new session.")
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
    from core.integrations.agent_adapter.factory import build_agent_adapter

    adapter = build_agent_adapter(
        settings.active_directory_profile.root_path,
        settings.productivity,
        session_store=store,
    )

    if args.resume_id is not None and args.provider is None:
        try:
            resume_manifest = store.load_manifest(args.resume_id)
        except FileNotFoundError as exc:
            raise SystemExit(f"No saved session found for id: {args.resume_id}") from exc
        provider = str(resume_manifest["provider"])
    else:
        provider = args.provider or settings.productivity.default_provider
    if provider not in adapter.providers:
        available = ", ".join(adapter.providers)
        raise SystemExit(f"Unknown productivity provider {provider!r}; available: {available}")

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
        raise SystemExit(f"No saved session found for id: {args.resume_id}") from exc
    except (KeyError, ValueError) as exc:
        raise SystemExit(f"Unable to start productivity session: {exc}") from exc

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
            from core.git_status import inspect_git_status

            context_usage = ContextWindowUsage()
            cli.render_productivity_header(
                session,
                model=display_model,
                context_usage=context_usage,
                options=_productivity_options(adapter, session.id),
                git_status=inspect_git_status(session.project_path),
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


async def _run_chat_loop(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    restored_messages: list[BaseMessage] | None = None,
    store: SessionStore | None = None,
) -> None:
    if store is None:
        from config.settings import settings
        from core.memory.session_store import SessionStore

        store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    runtime.update_current_thread_id(thread_id)
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
                from core.agent import Agent

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
            from config.settings import settings

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


def _run_git(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip() or "no output"
        command = "git " + " ".join(args)
        raise RuntimeError(f"{command} failed: {details}")
    return result


def _validated_preserve_paths(
    repo_root: Path,
    preserve_paths: tuple[str, ...],
) -> list[tuple[str, Path]]:
    validated: list[tuple[str, Path]] = []
    for rel in preserve_paths:
        rel_path = Path(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            raise RuntimeError(f"Refusing invalid preserve path: {rel}")

        absolute = (repo_root / rel_path).resolve()
        if not absolute.is_relative_to(repo_root):
            raise RuntimeError(f"Refusing preserve path outside repository: {rel}")

        validated.append((rel_path.as_posix(), absolute))
    return validated


def _copy_path(src: Path, dst: Path) -> None:
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
        return
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def _git_clean_args(preserved: list[tuple[str, Path]]) -> list[str]:
    args = ["clean", "-ffdx"]
    for rel, _ in preserved:
        args.extend(["-e", rel])
    return args


def reset_workspace_to_main(
    repo_root: Path,
    *,
    main_branch: str = "main",
    preserve_paths: tuple[str, ...] = (
        LOCAL_CONFIG_PATH,
        LOCAL_HARNESSES_CONFIG_PATH,
    ),
) -> None:
    repo_root = repo_root.resolve()

    git_root = Path(_run_git(repo_root, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if git_root != repo_root:
        raise RuntimeError(f"Refusing to reset unexpected repository root: {git_root}")

    try:
        _run_git(repo_root, "rev-parse", "--verify", "--quiet", f"refs/heads/{main_branch}")
    except RuntimeError as exc:
        raise RuntimeError(f"Local branch '{main_branch}' does not exist.") from exc

    preserved = _validated_preserve_paths(repo_root, preserve_paths)
    clean_args = _git_clean_args(preserved)

    with tempfile.TemporaryDirectory(prefix="cleo-reset-") as tmp_dir:
        backup_root = Path(tmp_dir)
        for rel, absolute in preserved:
            if absolute.exists():
                _copy_path(absolute, backup_root / rel)

        _run_git(repo_root, "reset", "--hard")
        _run_git(repo_root, *clean_args)
        _run_git(repo_root, "switch", main_branch)
        _run_git(repo_root, "reset", "--hard", main_branch)
        _run_git(repo_root, *clean_args)

        for rel, absolute in preserved:
            backup = backup_root / rel
            if backup.exists():
                _copy_path(backup, absolute)

    print(f"Reset workspace to local '{main_branch}' branch.")
    if preserved:
        preserved_list = ", ".join(rel for rel, _ in preserved)
        print(f"Preserved local file(s): {preserved_list}")


async def amain() -> None:
    parser = argparse.ArgumentParser(description="Run the Cleo AI Agent local runtime.")
    parser.add_argument(
        "message",
        nargs="?",
        default=None,
        help="Optional one-shot user message. Omit it to enter interactive chat.",
    )
    parser.add_argument(
        "--print-config-template",
        action="store_true",
        help="Print a portable cleo.json template and exit.",
    )
    parser.add_argument(
        "--print-harnesses-template",
        action="store_true",
        help="Print a portable harnesses.json template and exit.",
    )
    parser.add_argument(
        "--reset-to-main",
        action="store_true",
        help=(
            "Reset this repository to the local main branch and remove untracked "
            "or ignored files. Preserves local Cleo and harness configuration."
        ),
    )
    parser.add_argument(
        "--project",
        type=_project_name,
        default=None,
        help="Bind this thread and its memory retrieval tools to a project name.",
    )
    parser.add_argument(
        "--productivity",
        action="store_true",
        help="Run an external agent harness through Cleo's productivity adapter.",
    )
    parser.add_argument(
        "--provider",
        default=None,
        help="Productivity harness provider. Defaults to harnesses.json selection.",
    )
    parser.add_argument(
        "--cwd",
        default=None,
        help="Working directory for the productivity harness. Defaults to this project root.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Optional productivity harness model override.",
    )
    thread_group = parser.add_mutually_exclusive_group()

    thread_group.add_argument(
        "--thread-id",
        default=None,
        help=(
            "Conversation thread id used by the in-memory checkpointer. "
            "Defaults to a generated id."
        ),
    )
    thread_group.add_argument(
        "--resume",
        dest="resume_id",
        metavar="THREAD_ID",
        default=None,
        help="Resume a saved Cleo or productivity session by Cleo session id.",
    )

    args = parser.parse_args()

    if args.print_config_template and args.print_harnesses_template:
        raise SystemExit("Choose only one config template to print.")

    if args.print_config_template:
        if (
            args.message is not None
            or args.thread_id is not None
            or args.resume_id is not None
            or args.reset_to_main
            or args.project is not None
            or args.productivity
            or args.provider is not None
            or args.cwd is not None
            or args.model is not None
        ):
            raise SystemExit(
                "--print-config-template cannot be combined with other operations."
            )
        print(CONFIG_TEMPLATE_PATH.read_text(encoding="utf-8"), end="")
        return

    if args.print_harnesses_template:
        if (
            args.message is not None
            or args.thread_id is not None
            or args.resume_id is not None
            or args.reset_to_main
            or args.project is not None
            or args.productivity
            or args.provider is not None
            or args.cwd is not None
            or args.model is not None
        ):
            raise SystemExit(
                "--print-harnesses-template cannot be combined with other operations."
            )
        print(HARNESSES_TEMPLATE_PATH.read_text(encoding="utf-8"), end="")
        return

    if args.reset_to_main:
        if (
            args.message is not None
            or args.thread_id is not None
            or args.resume_id is not None
            or args.project is not None
            or args.productivity
            or args.provider is not None
            or args.cwd is not None
            or args.model is not None
            or args.print_harnesses_template
        ):
            raise SystemExit("--reset-to-main cannot be combined with chat or thread arguments.")
        try:
            reset_workspace_to_main(Path(__file__).resolve().parent)
        except RuntimeError as exc:
            raise SystemExit(f"Reset to main failed: {exc}") from exc
        return

    if args.productivity and args.thread_id is not None:
        raise SystemExit("--thread-id is only available for Cleo chat sessions.")
    if not args.productivity and any(
        value is not None for value in (args.provider, args.cwd, args.model)
    ):
        raise SystemExit("--provider, --cwd, and --model require --productivity.")

    from config.settings import settings
    from core.memory.session_store import SessionStore
    from core.runtime.model import Runtime

    runtime = Runtime()
    store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    if args.productivity:
        await _run_productivity_mode(args, runtime, store, settings)
        return

    unfinished_thread_id = (
        runtime.current_thread_id
        if runtime.current_space == "non_productivity"
        else None
    )
    runtime.update_current_space("non_productivity")
    if args.project is not None:
        runtime.update_current_project(args.project)
    loaded_messages: list[BaseMessage] | None = None
    if args.resume_id is not None:
        thread_id = args.resume_id
        try:
            manifest = store.load_manifest(thread_id)
            if manifest["provider"] != "cleo":
                raise SystemExit(
                    "The Cleo chat CLI can only resume Cleo sessions; "
                    "use the productivity interface for harness sessions."
                )
            loaded_messages = store.load_langchain_messages(thread_id)
            saved_project = str(manifest["project"])
        except FileNotFoundError as exc:
            raise SystemExit(f"No saved session found for id: {thread_id}") from exc
        if args.project is not None and saved_project and args.project != saved_project:
            raise SystemExit(
                f"Saved thread {thread_id} belongs to project {saved_project!r}, "
                f"not {args.project!r}."
            )
        runtime.update_current_space(str(manifest["space"]))
        runtime.update_current_project(saved_project or args.project or "general")
    elif args.thread_id is not None:
        thread_id = args.thread_id
    elif args.message is None and unfinished_thread_id:
        cli.info(
            f"Determined an unfinished thread with id {unfinished_thread_id}. "
            "Do you want to continue it? (y/n)"
        )
        choice = (await asyncio.to_thread(cli.field_prompt, "resume [y/n]")).lower()
        if choice == "y":
            thread_id = unfinished_thread_id
            cli.info(f"Recovering with thread id {thread_id}")
            try:
                manifest = store.load_manifest(thread_id)
                loaded_messages = store.load_langchain_messages(thread_id)
                saved_project = str(manifest["project"])
                runtime.update_current_space(str(manifest["space"]))
            except FileNotFoundError:
                thread_id = _new_thread_id()
                loaded_messages = None
                saved_project = None
                cli.warning("The unfinished session was not found; starting a new one.")
            if saved_project:
                runtime.update_current_project(saved_project)
        elif choice == "n":
            thread_id = _new_thread_id()
            cli.info(f"Starting a new thread with id {thread_id}")
            clear_screen()
        else:
            thread_id = _new_thread_id()
            cli.info(f"Starting a new thread with id {thread_id}")
            clear_screen()
    else:
        thread_id = _new_thread_id()

    if runtime.current_project is None:
        runtime.update_current_project("general")

    from core.agent import Agent

    agent = Agent(
        project=runtime.current_project or "general",
        space=runtime.current_space,
    )
    if args.message is not None:
        _render_chat_header(agent, runtime, thread_id)
    if args.resume_id is not None:
        if args.message is None:
            await _run_chat_loop(
                agent,
                runtime,
                thread_id=thread_id,
                restored_messages=loaded_messages,
                store=store,
            )
        else:
            await _print_streaming_reply(
                agent,
                args.message,
                thread_id,
                loaded_info=loaded_messages,
            )
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                loaded_messages,
                status="completed",
            )
            await _run_dream_agent(
                thread_id,
                runtime.current_project,
                runtime.current_space,
            )
        return
    else:
        if args.message is None:
            await _run_chat_loop(
                agent,
                runtime,
                thread_id,
                restored_messages=loaded_messages,
                store=store,
            )
        else:
            await _print_streaming_reply(
                agent,
                args.message,
                thread_id,
                loaded_info=loaded_messages,
            )
            await _sync_session_events(
                agent,
                runtime,
                thread_id,
                loaded_messages,
                status="completed",
            )
            await _run_dream_agent(
                thread_id,
                runtime.current_project,
                runtime.current_space,
            )
        return

def main() -> None:
    """Synchronous console-script boundary for the async Cleo runtime."""
    asyncio.run(amain())


if __name__ == "__main__":
    main()
