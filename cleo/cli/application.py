"""Argument parsing and top-level Cleo CLI dispatch."""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from langchain_core.messages import BaseMessage

from cleo.cli.chat import (
    _new_thread_id,
    _print_streaming_reply,
    _project_name,
    _render_chat_header,
    _run_chat_loop,
)
from cleo.cli.context import clear_screen, cli
from cleo.cli.lifecycle import _run_dream_agent, _sync_session_events
from cleo.cli.productivity import _run_productivity_mode
from cleo.cli.workspace import reset_workspace_to_main

SOURCE_ROOT = Path(__file__).resolve().parents[2]
CONFIG_TEMPLATE_PATH = SOURCE_ROOT / "cleo" / "config" / "templates" / "cleo.example.json"
HARNESSES_TEMPLATE_PATH = (
    SOURCE_ROOT / "cleo" / "config" / "templates" / "harnesses.example.json"
)


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
            reset_workspace_to_main(SOURCE_ROOT)
        except RuntimeError as exc:
            raise SystemExit(f"Reset to main failed: {exc}") from exc
        return

    if args.productivity and args.thread_id is not None:
        raise SystemExit("--thread-id is only available for Cleo chat sessions.")
    if not args.productivity and any(
        value is not None for value in (args.provider, args.cwd, args.model)
    ):
        raise SystemExit("--provider, --cwd, and --model require --productivity.")

    from cleo.config.settings import settings
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore

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

    from cleo.agents import Agent

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
