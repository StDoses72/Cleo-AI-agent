from __future__ import annotations

import argparse
import base64
import mimetypes
import os
import textwrap
import uuid
from typing import TYPE_CHECKING

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)

from core.memory.thread_memory import load_messages_from_file, save_messages_to_file
from core.runtime.model import Runtime

if TYPE_CHECKING:
    from core.agent import Agent

SUPPORTED_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def clear_screen() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def _new_thread_id() -> str:
    return f"local-{uuid.uuid4().hex[:12]}"


def _print_streaming_reply(
    agent: Agent,
    message: str,
    thread_id: str,
    loaded_info: list[BaseMessage] | None = None,
    images: list[dict[str, str]] | None = None,
) -> None:
    received_text = False
    for text in agent.stream_text(
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


def _save_thread_snapshot(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    fallback_messages: list[BaseMessage] | None = None,
) -> None:
    config = {"configurable": {"thread_id": thread_id}}
    thread_messages = agent.deepagent.get_state(config).values.get("messages", [])
    if not thread_messages and fallback_messages is not None:
        thread_messages = fallback_messages
    save_messages_to_file(thread_messages, f"{thread_id}.json", runtime)
    runtime.append_recent_threads(thread_id)


def _run_dream_agent(thread_id: str, project: str | None) -> None:
    from core.agent import DreamAgent

    project_name = project or "general"
    try:
        print(f"Running DreamAgent memory consolidation for {thread_id} -> {project_name}...")
        DreamAgent().invoke(thread_id=thread_id, project=project_name)
        print("DreamAgent memory consolidation finished.")
    except Exception as exc:
        print(f"DreamAgent memory consolidation failed: {exc}")


def _run_chat_loop(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    restored_messages: list[BaseMessage] | None = None,
) -> None:
    print("Cleo AI Agent interactive chat. Type /quit to exit, /new to start a fresh thread.")
    print(f"Thread id: {thread_id}")
    print()
    runtime.update_current_thread_id(thread_id)
    attachment_list: list[dict[str, str]] = []
    while True:
        try:
            if attachment_list:
                print("The current attachments to be sent with the next message:")
                for i, attachment in enumerate(attachment_list):
                    print(f"  {i + 1}. {attachment['name']}")
            message = input(">> ").strip()

        except EOFError:
            print()
            _save_thread_snapshot(agent, runtime, thread_id, restored_messages)
            runtime.update_runtime_json()
            break
        except KeyboardInterrupt:
            print()
            print("Chat interrupted by user. Exiting.")
            _save_thread_snapshot(agent, runtime, thread_id, restored_messages)
            runtime.update_runtime_json()
            break

        if not message:
            continue
        if message in {"/quit", "/exit"}:
            print(f"Saving thread snapshot: {thread_id}")
            _save_thread_snapshot(agent, runtime, thread_id, restored_messages)
            _run_dream_agent(thread_id, runtime.current_project)
            runtime.update_current_project(None)
            runtime.update_current_thread_id(None)
            runtime.update_runtime_json()
            print("Exiting the chat. Goodbye!")
            break
        if message == "/new":
            _save_thread_snapshot(agent, runtime, thread_id, restored_messages)
            thread_id = _new_thread_id()
            restored_messages = None
            runtime.update_current_project(None)
            runtime.update_current_thread_id(thread_id)
            runtime.update_runtime_json()
            clear_screen()
            print(f"Started new thread: {thread_id}")
            continue

        if message == "/attach":
            print(
                "Enter the file path to attach or leave empty to cancel "
                "(currently support image files only):"
            )
            file_path = input(">> ").strip().strip("\"'")
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
            _print_streaming_reply(
                agent,
                message,
                thread_id,
                loaded_info=restored_messages,
                images=attachment_list,
            )
            restored_messages = None
            attachment_list = []
        except KeyboardInterrupt:
            print()
            print("Chat interrupted by user. Exiting.")
            _save_thread_snapshot(agent, runtime, thread_id, restored_messages)
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Cleo AI Agent local runtime.")
    parser.add_argument(
        "message",
        nargs="?",
        default=None,
        help="Optional one-shot user message. Omit it to enter interactive chat.",
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
        help="Resume a saved thread snapshot by thread id.",
    )

    args = parser.parse_args()

    runtime = Runtime()
    loaded_messages: list[BaseMessage] | None = None
    if args.resume_id is not None:
        thread_id = args.resume_id
        try:
            loaded_messages = load_messages_from_file(f"{thread_id}.json")
        except FileNotFoundError as exc:
            raise SystemExit(f"No saved thread snapshot found for thread id: {thread_id}") from exc
    elif args.thread_id is not None:
        thread_id = args.thread_id
    elif args.message is None and runtime.current_thread_id:
        print(
            f"Determined an unfinished thread with id {runtime.current_thread_id}. "
            "Do you want to continue it? (y/n)"
        )
        choice = input(">> ").strip().lower()
        if choice == "y":
            thread_id = runtime.current_thread_id
            print(f"Recovering with thread id {thread_id}")
            loaded_messages = load_messages_from_file(f"{thread_id}.json")
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

    from core.agent import Agent

    agent = Agent()
    if args.resume_id is not None:
        if args.message is None:
            _print_restored_messages(thread_id, loaded_messages=loaded_messages)
            _run_chat_loop(agent, runtime, thread_id=thread_id, restored_messages=loaded_messages)
        else:
            _print_streaming_reply(agent, args.message, thread_id, loaded_info=loaded_messages)
            _save_thread_snapshot(agent, runtime, thread_id, loaded_messages)
            _run_dream_agent(thread_id, runtime.current_project)
        return
    else:
        if args.message is None:
            _run_chat_loop(agent, runtime, thread_id, restored_messages=loaded_messages)
        else:
            _print_streaming_reply(agent, args.message, thread_id, loaded_info=loaded_messages)
            _save_thread_snapshot(agent, runtime, thread_id, loaded_messages)
            _run_dream_agent(thread_id, runtime.current_project)
        return

if __name__ == "__main__":
    main()
