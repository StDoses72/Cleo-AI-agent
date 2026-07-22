from __future__ import annotations

import argparse
import asyncio
import base64
import mimetypes
import os
import shutil
import subprocess
import tempfile
import textwrap
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

if TYPE_CHECKING:
    from config.settings import SettingsModel
    from core.agent import Agent
    from core.integrations.agent_adapter import AgentAdapter, AgentEvent, AgentResult, AgentSession
    from core.memory.session_store import SessionStore
    from core.runtime.model import Runtime

SUPPORTED_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
LOCAL_CONFIG_PATH = "config/cleo.json"
CONFIG_TEMPLATE_PATH = Path(__file__).resolve().parent / "config" / "cleo.example.json"


def clear_screen() -> None:
    os.system("cls" if os.name == "nt" else "clear")


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
    async for text in agent.stream_text(
        message,
        thread_id=thread_id,
        loaded_info=loaded_info,
        images=images,
    ):
        received_text = True
        print(text, end="", flush=True)
    if not received_text:
        print("(No assistant response returned.)", end="")
    print()


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
        print(f"Running DreamAgent memory consolidation for {thread_id} -> {project_name}...")
        await DreamAgent().invoke(
            session_id=thread_id,
            project=project_name,
            space=space,
        )
        print("DreamAgent memory consolidation finished.")
    except Exception as exc:
        print(f"DreamAgent memory consolidation failed: {exc}")


def _productivity_event_payload(event: AgentEvent) -> dict[str, object]:
    payload = event.data.get("payload")
    return payload if isinstance(payload, dict) else event.data


def _productivity_event_summary(event: AgentEvent) -> str | None:
    payload = _productivity_event_payload(event)
    item = payload.get("item")
    item = item if isinstance(item, dict) else {}
    if event.type == "tool_call":
        command = item.get("command")
        if command:
            return f"[tool] {command}"
        server = item.get("server")
        tool = item.get("tool")
        if server or tool:
            return f"[tool] {server or 'tool'}/{tool or 'unknown'}"
        return f"[tool] {item.get('type', 'started')}"
    if event.type == "tool_result":
        status = item.get("status") or "completed"
        return f"[tool {status}]"
    if event.type == "plan_update":
        plan = payload.get("plan")
        if isinstance(plan, list):
            steps = [
                str(step.get("step"))
                for step in plan
                if isinstance(step, dict) and step.get("step")
            ]
            if steps:
                return "[plan] " + " | ".join(steps)
        return "[plan updated]"
    if event.type == "file_change" and not event.text:
        return "[file change]"
    if event.type == "error":
        return f"[error] {event.text or 'Codex reported an error'}"
    return None


async def _prompt_productivity_session(
    adapter: AgentAdapter,
    session_id: str,
    prompt: str,
) -> AgentResult:
    assistant_streamed = False
    terminal_streamed = False

    def on_event(event: AgentEvent) -> None:
        nonlocal assistant_streamed, terminal_streamed
        if event.type == "assistant_message_chunk" and event.text:
            assistant_streamed = True
            terminal_streamed = False
            print(event.text, end="", flush=True)
            return
        if event.type == "terminal_output" and event.text:
            if not terminal_streamed:
                print("\n[terminal]", flush=True)
            terminal_streamed = True
            print(event.text, end="", flush=True)
            return
        summary = _productivity_event_summary(event)
        if summary:
            terminal_streamed = False
            print(f"\n{summary}", flush=True)

    result = await adapter.prompt(session_id, prompt, on_event=on_event)
    if assistant_streamed or terminal_streamed:
        print()
    elif result.response:
        print(result.response)
    if result.status != "completed":
        details = f": {result.error}" if result.error else ""
        print(f"[session {result.status}]{details}")
    return result


async def _finish_productivity_session(
    adapter: AgentAdapter,
    session: AgentSession,
    runtime: Runtime,
) -> None:
    await adapter.close(session.id)
    runtime.append_recent_threads(session.id, "productivity")
    await _run_dream_agent(session.id, session.project, "productivity")


async def _run_productivity_loop(
    adapter: AgentAdapter,
    session: AgentSession,
    runtime: Runtime,
    *,
    provider: str,
    project_path: str,
    project: str,
    model: str | None,
    return_to_chat: bool = False,
) -> None:
    exit_action = "return to Cleo chat" if return_to_chat else "exit"
    print(
        "Cleo productivity mode. "
        f"Type /back or /quit to {exit_action}, /new to start a new harness session."
    )
    print(f"Provider: {session.provider}")
    print(f"Session id: {session.id}")
    print(f"Native session id: {session.native_session_id or 'pending'}")
    print(f"Project: {session.project}")
    print(f"Working directory: {session.project_path}")
    print()

    while True:
        try:
            prompt = (await asyncio.to_thread(input, "productivity>> ")).strip()
        except (EOFError, KeyboardInterrupt):
            print()
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
                provider,
                project_path=project_path,
                model=model,
                project=project,
            )
            runtime.update_current_thread_id(session.id)
            runtime.append_recent_threads(session.id, "productivity")
            print(f"Started new {provider} session: {session.id}")
            continue

        try:
            print()
            await _prompt_productivity_session(adapter, session.id, prompt)
            runtime.append_recent_threads(session.id, "productivity")
        except KeyboardInterrupt:
            print("\nCancelling the active harness turn...")
            await adapter.cancel(session.id)
        except Exception as exc:
            print(f"Productivity error: {exc}")
        print()

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
    from core.integrations.agent_adapter import AgentAdapter, CodexProvider

    default_model = settings.active_tools_profile.codex_model
    adapter = AgentAdapter(
        settings.active_directory_profile.root_path,
        session_store=store,
    )
    adapter.register(CodexProvider(default_model=default_model))

    provider = args.provider or "codex"
    if provider not in adapter.providers:
        available = ", ".join(adapter.providers)
        raise SystemExit(f"Unknown productivity provider {provider!r}; available: {available}")

    model = args.model or default_model
    project_path = args.cwd or "."
    project = args.project
    try:
        if args.resume_id is not None:
            manifest = store.load_manifest(args.resume_id)
            if manifest["space"] != "productivity":
                raise SystemExit(
                    f"Session {args.resume_id} is not a productivity session."
                )
            saved_provider = str(manifest["provider"])
            if args.provider is not None and args.provider != saved_provider:
                raise SystemExit(
                    f"Session {args.resume_id} belongs to provider {saved_provider!r}, "
                    f"not {args.provider!r}."
                )
            native_session_id = manifest.get("native_session_id")
            if not native_session_id:
                raise SystemExit(
                    f"Session {args.resume_id} has no native harness session id."
                )
            provider = saved_provider
            project_path = args.cwd or manifest.get("cwd") or "."
            project = args.project or str(manifest["project"])
            session = await adapter.resume_session(
                provider,
                str(native_session_id),
                project_path=project_path,
                model=model,
                project=project,
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
                provider=provider,
                project_path=project_path,
                project=session.project,
                model=model,
                return_to_chat=return_to_chat,
            )
        else:
            await _prompt_productivity_session(adapter, session.id, args.message)
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
) -> None:
    print(
        "Cleo AI Agent interactive chat. Type /productivity to open productivity mode, "
        "/quit to exit, or /new to start a fresh thread."
    )
    print(f"Thread id: {thread_id}")
    print(f"Project: {runtime.current_project or 'general'}")
    print()
    runtime.update_current_thread_id(thread_id)
    attachment_list: list[dict[str, str]] = []
    while True:
        try:
            if attachment_list:
                print("The current attachments to be sent with the next message:")
                for i, attachment in enumerate(attachment_list):
                    print(f"  {i + 1}. {attachment['name']}")
            message = (await asyncio.to_thread(input, ">> ")).strip()

        except EOFError:
            print()
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
            print()
            print("Chat interrupted by user. Exiting.")
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
            print(f"Closing session event log: {thread_id}")
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
            print("Exiting the chat. Goodbye!")
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
            print(f"Started new thread: {thread_id}")
            continue

        if message == "/productivity":
            from config.settings import settings
            from core.memory.session_store import SessionStore

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
                    SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH),
                    settings,
                    return_to_chat=True,
                )
            except (Exception, SystemExit) as exc:
                print(f"Unable to open productivity mode: {exc}")
            finally:
                runtime.update_current_space(saved_space)
                runtime.update_current_project(saved_project)
                runtime.update_current_thread_id(thread_id)
                runtime.append_recent_threads(thread_id, saved_space)
            clear_screen()
            print(f"Returned to Cleo chat. Thread id: {thread_id}")
            print(f"Project: {saved_project}")
            print()
            continue

        if message == "/attach":
            print(
                "Enter the file path to attach or leave empty to cancel "
                "(currently support image files only):"
            )
            file_path = (await asyncio.to_thread(input, ">> ")).strip().strip("\"'")
            if file_path:
                if not os.path.isfile(file_path):
                    print(f"File not found: {file_path}")
                    continue
                mime_type, _ = mimetypes.guess_type(file_path)
                if mime_type not in SUPPORTED_IMAGE_MIME_TYPES:
                    print(f"Unsupported image type: {mime_type or 'unknown'}")
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
            print()
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
            print()
            print("Chat interrupted by user. Exiting.")
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
            print(f"Error: {exc}")
            continue

        print()


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


def _print_wrapped_message(role: str, content: str) -> None:
    label = f"{role}: "
    paragraphs = content.splitlines() or [""]
    first = True
    for paragraph in paragraphs:
        wrapped_lines = textwrap.wrap(
            paragraph,
            width=88,
            initial_indent=label if first else " " * len(label),
            subsequent_indent=" " * len(label),
            replace_whitespace=False,
        )
        if wrapped_lines:
            for line in wrapped_lines:
                print(line)
        else:
            print(label if first else "")
        first = False


def _print_restored_messages(thread_id: str, loaded_messages: list[BaseMessage]) -> None:
    print()
    print(f"Restored thread: {thread_id}")
    print(f"Messages: {len(loaded_messages)}")
    print("-" * 72)
    for msg in loaded_messages:
        content = _message_content_to_text(getattr(msg, "content", "")).strip()
        if not content:
            continue
        _print_wrapped_message(_message_role(msg), content)
        print()
    print("-" * 72)
    print()


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
    preserve_paths: tuple[str, ...] = (LOCAL_CONFIG_PATH,),
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
        "--reset-to-main",
        action="store_true",
        help=(
            "Reset this repository to the local main branch and remove untracked "
            "or ignored files. Preserves config/cleo.json."
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
        help="Productivity harness provider. Defaults to codex.",
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
        print(
            f"Determined an unfinished thread with id {unfinished_thread_id}. "
            "Do you want to continue it? (y/n)"
        )
        choice = (await asyncio.to_thread(input, ">> ")).strip().lower()
        if choice == "y":
            thread_id = unfinished_thread_id
            print(f"Recovering with thread id {thread_id}")
            try:
                manifest = store.load_manifest(thread_id)
                loaded_messages = store.load_langchain_messages(thread_id)
                saved_project = str(manifest["project"])
                runtime.update_current_space(str(manifest["space"]))
            except FileNotFoundError:
                thread_id = _new_thread_id()
                loaded_messages = None
                saved_project = None
                print("The unfinished session was not found; starting a new one.")
            if saved_project:
                runtime.update_current_project(saved_project)
            _print_restored_messages(thread_id, loaded_messages)
        elif choice == "n":
            thread_id = _new_thread_id()
            print(f"Starting a new thread with id {thread_id}")
            clear_screen()
        else:
            thread_id = _new_thread_id()
            print(f"Starting a new thread with id {thread_id}")
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
    if args.resume_id is not None:
        if args.message is None:
            _print_restored_messages(thread_id, loaded_messages=loaded_messages)
            await _run_chat_loop(
                agent,
                runtime,
                thread_id=thread_id,
                restored_messages=loaded_messages,
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
