"""Productivity harness interaction flow."""

from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from cleo.cli.context import clear_screen, cli
from cleo.cli.lifecycle import _run_dream_agent
from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.config.settings import SettingsModel
    from cleo.harnesses import AgentAdapter, AgentResult, AgentSession
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


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
        from cleo.integrations.git import inspect_git_status

        cli.render_productivity_controls(
            _productivity_options(adapter, session.id),
            inspect_git_status(session.project_path),
        )

    def render_active_header() -> None:
        from cleo.integrations.git import inspect_git_status

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
            from cleo.integrations.git import inspect_git_status

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
