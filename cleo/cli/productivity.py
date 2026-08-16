"""Productivity harness startup and backend lifecycle helpers."""

from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

from cleo.cli.context import cli
from cleo.cli.lifecycle import _run_dream_agent
from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.config.settings import SettingsModel
    from cleo.harnesses import AgentAdapter, AgentResult, AgentSession
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


class ProductivityStartupError(RuntimeError):
    """Raised when an interactive harness session cannot be initialized."""


async def _prompt_productivity_session(
    adapter: AgentAdapter,
    session_id: str,
    prompt: str,
    *,
    model: str,
    context_usage: ContextWindowUsage,
) -> AgentResult:
    """Run one non-interactive harness turn with the Rich stream renderer."""
    renderer = cli.productivity_renderer(
        model=model,
        context_usage=context_usage,
    )
    result = await adapter.prompt(session_id, prompt, on_event=renderer)
    await _refresh_rate_limit_usage(adapter, session_id, context_usage)
    renderer.finish(result)
    return result


async def _refresh_rate_limit_usage(
    adapter: AgentAdapter,
    session_id: str,
    context_usage: ContextWindowUsage,
) -> None:
    """Refresh optional account limits without breaking non-Codex providers."""
    method = getattr(adapter, "account_rate_limits", None)
    if not callable(method):
        return
    try:
        windows = await method(session_id)
    except (KeyError, NotImplementedError, OSError, RuntimeError):
        return
    context_usage.update_rate_limits(windows)


async def _finish_productivity_session(
    adapter: AgentAdapter,
    session: AgentSession,
    runtime: Runtime,
    *,
    consolidate: bool = True,
    close_timeout_seconds: float | None = None,
) -> None:
    """Close a harness route and optionally run memory consolidation.

    Interactive TUIs may provide a short close timeout and defer consolidation so
    a stuck provider client or a long DreamAgent turn cannot trap the terminal in
    its alternate screen. One-shot callers retain the synchronous lifecycle.
    """
    if close_timeout_seconds is None:
        await adapter.close(session.id)
    else:
        try:
            await asyncio.wait_for(
                adapter.close(session.id),
                timeout=close_timeout_seconds,
            )
        except Exception:
            # Provider close implementations remove their runtime before awaiting
            # SDK teardown, so a later adapter.aclose() can safely finish bookkeeping.
            pass
    runtime.append_recent_threads(session.id, "productivity")
    if consolidate:
        await _run_dream_agent(session.id, session.project, "productivity")


def _slash_command_argument(prompt: str, command: str) -> str:
    """Return a slash-command argument with one matching quote pair removed."""
    argument = prompt.removeprefix(command).strip()
    if (
        len(argument) >= 2
        and argument[0] in {'"', "'"}
        and argument[-1] == argument[0]
    ):
        return argument[1:-1]
    return argument


def _resolve_productivity_cwd(argument: str, current_cwd: str) -> str:
    """Resolve a /cd argument to an existing absolute directory."""
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
    """Resume a saved productivity route after validating its manifest."""
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
    """Best-effort model and native-session catalog loading."""
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
    """Read optional session controls from a capable adapter."""
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
    """Render the compact non-interactive productivity header."""
    from cleo.integrations.git import inspect_git_status

    cli.render_productivity_header(
        session,
        model=active_model,
        context_usage=context_usage,
        options=_productivity_options(adapter, session.id),
        git_status=inspect_git_status(session.project_path),
    )


async def _run_productivity_loop(
    adapter: AgentAdapter,
    session: AgentSession,
    runtime: Runtime,
    store: SessionStore,
    *,
    model: str | None,
    provider_models: Mapping[str, str | None] | None = None,
    return_to_chat: bool = False,
    restore_initial_history: bool = False,
) -> None:
    """Run the full-screen Textual productivity workspace."""
    from cleo.cli.productivity_tui import run_productivity_tui

    await run_productivity_tui(
        adapter,
        session,
        runtime,
        store,
        model=model,
        provider_models=provider_models,
        return_to_chat=return_to_chat,
        restore_initial_history=restore_initial_history,
    )


async def _run_productivity_mode(
    args: argparse.Namespace,
    runtime: Runtime,
    store: SessionStore,
    settings: SettingsModel,
    *,
    return_to_chat: bool = False,
) -> None:
    """Build the selected adapter/session and dispatch interactive or one-shot mode."""
    from cleo.integrations.harnesses.factory import build_agent_adapter

    adapter = build_agent_adapter(
        settings.active_directory_profile.root_path,
        settings.productivity,
        session_store=store,
    )

    if args.resume_id is not None:
        try:
            resume_manifest = store.load_manifest(args.resume_id)
        except FileNotFoundError as exc:
            raise ProductivityStartupError(
                f"No saved session found for id: {args.resume_id}"
            ) from exc
        provider = args.provider or str(resume_manifest["provider"])
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
    except (KeyError, ValueError) as exc:
        raise ProductivityStartupError(f"Unable to start productivity session: {exc}") from exc
    except OSError as exc:
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
                restore_initial_history=args.resume_id is not None,
            )
        else:
            context_usage = ContextWindowUsage()
            await _refresh_rate_limit_usage(adapter, session.id, context_usage)
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
        try:
            await asyncio.wait_for(
                adapter.aclose(),
                timeout=0.5 if args.message is None else 3.0,
            )
        except Exception:
            pass
