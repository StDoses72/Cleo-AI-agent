"""Full-screen Textual interface for Cleo's primary chat mode."""

from __future__ import annotations

import argparse
import asyncio
import base64
import mimetypes
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from rich.markdown import Markdown
from rich.text import Text
from textual import on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.suggester import SuggestFromList
from textual.widgets import Button, Input, OptionList, Static
from textual.widgets.option_list import Option

from cleo.cli.context import clear_terminal_after_tui
from cleo.cli.lifecycle import (
    _launch_dream_agent_worker,
    _sync_session_events,
)
from cleo.cli.productivity import _run_productivity_mode, _slash_command_argument
from cleo.cli.productivity_tui import ProductivityApp
from cleo.memory.paths import DEFAULT_MEMORY_SPACE, validate_name

if TYPE_CHECKING:
    from langchain_core.messages import BaseMessage
    from textual.worker import Worker

    from cleo.agents import Agent
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


COMMANDS = (
    "/help",
    "/new",
    "/project",
    "/project ",
    "/project move ",
    "/sessions",
    "/resume ",
    "/rename ",
    "/attach",
    "/productivity",
    "/quit",
)


def _new_thread_id() -> str:
    return f"local-{uuid.uuid4().hex[:12]}"


@dataclass(frozen=True, slots=True)
class ChatSessionChoice:
    session_id: str


class ChatSessionPicker(ModalScreen[ChatSessionChoice | None]):
    """Single-click picker for Cleo chat sessions only."""

    DEFAULT_CSS = """
    ChatSessionPicker {
        align: center middle;
        background: #09080fcc;
    }
    #chat-session-dialog {
        width: 90%;
        max-width: 110;
        height: 82%;
        max-height: 42;
        min-height: 14;
        padding: 1 2;
        border: round #8f61d4;
        background: #151020;
    }
    .picker-title {
        height: 2;
        color: #d4adff;
        text-style: bold;
    }
    .picker-hint {
        height: 2;
        color: #8e8499;
    }
    #chat-session-options {
        height: 1fr;
        margin: 1 0;
        border: round #382b4f;
        background: #0e0c15;
        scrollbar-color: #6f4bb8;
    }
    .picker-actions {
        height: 3;
        align-horizontal: right;
    }
    .picker-actions Button {
        min-width: 12;
        margin-left: 1;
    }
    """

    BINDINGS = (Binding("escape", "cancel", "Cancel", show=False),)

    def __init__(self, rows: list[dict[str, Any]], current_thread_id: str) -> None:
        super().__init__()
        self._choices: dict[str, ChatSessionChoice] = {}
        self._options: list[Option] = []
        for index, row in enumerate(rows):
            session_id = str(row.get("id") or "")
            if not session_id:
                continue
            option_id = f"chat-session-{index}"
            self._choices[option_id] = ChatSessionChoice(session_id)
            current = session_id == current_thread_id
            title = str(row.get("title") or "Untitled conversation").strip()
            label = Text()
            label.append("●  " if current else "   ", style="#83d697")
            label.append(title, style="bold #f0e9f7")
            label.append(
                f"\n   {session_id}  ·  {row.get('project') or 'general'}"
                f"  ·  {row.get('status') or 'unknown'}",
                style="dim",
            )
            self._options.append(Option(label, id=option_id))

    def compose(self) -> ComposeResult:
        with Vertical(id="chat-session-dialog"):
            yield Static("Resume a Cleo conversation", classes="picker-title")
            yield Static(
                "Click a row to resume it. Use ↑/↓ and Enter from the keyboard.",
                classes="picker-hint",
            )
            yield OptionList(*self._options, id="chat-session-options", markup=False)
            with Horizontal(classes="picker-actions"):
                yield Button("Cancel", id="chat-session-cancel")

    @on(OptionList.OptionSelected, "#chat-session-options")
    def _on_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        option_id = event.option.id
        if option_id is not None and option_id in self._choices:
            self.dismiss(self._choices[option_id])

    @on(Button.Pressed, "#chat-session-cancel")
    def _on_cancel_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class MemoryProjectPicker(ModalScreen[str | None]):
    """Picker for Cleo memory namespaces, kept distinct from workspace folders."""

    DEFAULT_CSS = """
    MemoryProjectPicker {
        align: center middle;
        background: #09080fcc;
    }
    #memory-project-dialog {
        width: 86%;
        max-width: 96;
        height: 78%;
        max-height: 36;
        min-height: 17;
        padding: 1 2;
        border: round #8f61d4;
        background: #151020;
    }
    .picker-title {
        height: 2;
        color: #d4adff;
        text-style: bold;
    }
    .picker-hint {
        height: 2;
        color: #8e8499;
    }
    #memory-project-options {
        height: 1fr;
        margin: 1 0;
        border: round #382b4f;
        background: #0e0c15;
        scrollbar-color: #6f4bb8;
    }
    #memory-project-name {
        height: 3;
        border: round #6f4bb8;
        background: #0e0c15;
    }
    .picker-actions {
        height: 3;
        align-horizontal: right;
    }
    .picker-actions Button {
        min-width: 12;
        margin-left: 1;
    }
    """

    BINDINGS = (Binding("escape", "cancel", "Cancel", show=False),)

    def __init__(
        self,
        projects: list[tuple[str, int]],
        current_project: str,
    ) -> None:
        super().__init__()
        self._projects: dict[str, str] = {}
        self._options: list[Option] = []
        for index, (project, session_count) in enumerate(projects):
            option_id = f"memory-project-{index}"
            self._projects[option_id] = project
            label = Text()
            label.append("●  " if project == current_project else "   ", style="#83d697")
            label.append(project, style="bold #f0e9f7")
            label.append(f"  ·  {session_count} conversation(s)", style="dim")
            self._options.append(Option(label, id=option_id))

    def compose(self) -> ComposeResult:
        with Vertical(id="memory-project-dialog"):
            yield Static("Choose a memory project", classes="picker-title")
            yield Static(
                "Memory projects group Cleo conversations; they are not filesystem folders.",
                classes="picker-hint",
            )
            yield OptionList(*self._options, id="memory-project-options", markup=False)
            yield Input(placeholder="Create a memory project…", id="memory-project-name")
            with Horizontal(classes="picker-actions"):
                yield Button("Create", id="memory-project-create", variant="primary")
                yield Button("Cancel", id="memory-project-cancel")

    @on(OptionList.OptionSelected, "#memory-project-options")
    def _on_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        option_id = event.option.id
        if option_id is not None and option_id in self._projects:
            self.dismiss(self._projects[option_id])

    @on(Input.Submitted, "#memory-project-name")
    def _on_name_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self._dismiss_name(event.value)

    @on(Button.Pressed, "#memory-project-create")
    def _on_create_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self._dismiss_name(self.query_one("#memory-project-name", Input).value)

    @on(Button.Pressed, "#memory-project-cancel")
    def _on_cancel_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(None)

    def _dismiss_name(self, value: str) -> None:
        try:
            project = validate_name(value, "project")
        except ValueError as exc:
            self.notify(str(exc), severity="warning")
            return
        self.dismiss(project)

    def action_cancel(self) -> None:
        self.dismiss(None)


class AttachmentPrompt(ModalScreen[str | None]):
    """Small path prompt for the next-turn image attachment."""

    DEFAULT_CSS = """
    AttachmentPrompt {
        align: center middle;
        background: #09080fcc;
    }
    #attachment-dialog {
        width: 80%;
        max-width: 90;
        height: 13;
        padding: 1 2;
        border: round #8f61d4;
        background: #151020;
    }
    #attachment-title {
        height: 2;
        color: #d4adff;
        text-style: bold;
    }
    #attachment-hint {
        height: 2;
        color: #8e8499;
    }
    #attachment-path {
        height: 3;
        border: round #6f4bb8;
        background: #0e0c15;
    }
    #attachment-actions {
        height: 3;
        align-horizontal: right;
    }
    #attachment-actions Button {
        min-width: 12;
        margin-left: 1;
    }
    """

    BINDINGS = (Binding("escape", "cancel", "Cancel", show=False),)

    def compose(self) -> ComposeResult:
        with Vertical(id="attachment-dialog"):
            yield Static("Attach an image", id="attachment-title")
            yield Static("JPEG, PNG, WebP, and GIF are supported.", id="attachment-hint")
            yield Input(placeholder="Enter the image path…", id="attachment-path")
            with Horizontal(id="attachment-actions"):
                yield Button("Attach", id="attachment-add", variant="primary")
                yield Button("Cancel", id="attachment-cancel")

    def on_mount(self) -> None:
        self.query_one("#attachment-path", Input).focus()

    @on(Input.Submitted, "#attachment-path")
    def _on_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self._dismiss_path(event.value)

    @on(Button.Pressed, "#attachment-add")
    def _on_add_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self._dismiss_path(self.query_one("#attachment-path", Input).value)

    @on(Button.Pressed, "#attachment-cancel")
    def _on_cancel_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(None)

    def _dismiss_path(self, value: str) -> None:
        value = value.strip().strip("\"'")
        if not value:
            self.notify("Enter an image path.", severity="warning")
            return
        self.dismiss(value)

    def action_cancel(self) -> None:
        self.dismiss(None)


class CleoChatApp(App[None]):
    """Textual shell for Cleo chat, memory projects, and session navigation."""

    TITLE = "Cleo"
    SUB_TITLE = "Personal agent"
    CSS = ProductivityApp.CSS
    SYNC_TIMEOUT_SECONDS = 0.5

    BINDINGS = (
        Binding("ctrl+c", "cancel_turn", "Cancel turn", show=True),
        Binding("ctrl+l", "clear_transcript", "Clear view", show=True),
        Binding("ctrl+q", "request_quit", "Quit", show=True),
    )

    def __init__(
        self,
        agent: Agent,
        runtime: Runtime,
        thread_id: str,
        store: SessionStore,
        *,
        restored_messages: list[BaseMessage] | None = None,
    ) -> None:
        super().__init__()
        self.agent = agent
        self.runtime = runtime
        self.thread_id = thread_id
        self.store = store
        self.restored_messages = restored_messages
        self.attachments: list[dict[str, str]] = []
        self.busy = False
        self.session_closed = False
        self._cleo_exit_requested = False
        self._active_worker: Worker[Any] | None = None
        self._assistant_widget: Static | None = None
        self._assistant_text = ""
        self._deferred_consolidations: list[tuple[str, str | None, str]] = []
        self._consolidations_launched = False

    def compose(self) -> ComposeResult:
        yield Static(id="topbar")
        yield Static(id="statusbar")
        with Horizontal(id="workspace"):
            yield VerticalScroll(id="transcript")
            with VerticalScroll(id="sidebar"):
                yield Static(id="session-card", classes="side-card")
                yield Static(id="control-card", classes="side-card")
                yield Static(id="git-card", classes="side-card")
                with Vertical(id="quick-actions"):
                    yield Button("New", id="action-new", classes="quick")
                    yield Button("Project", id="action-project", classes="quick")
                    yield Button("Sessions", id="action-sessions", classes="quick")
                    yield Button("Productivity", id="action-productivity", classes="quick")
                    yield Button("Attach", id="action-attach", classes="quick")
                    yield Button("Help", id="action-help", classes="quick")
        with Vertical(id="composer"):
            yield Static(
                "Enter to send  ·  / for commands  ·  Ctrl+C cancel  ·  Ctrl+Q quit",
                id="composer-hint",
            )
            yield Input(
                placeholder="Ask Cleo, or type /help…",
                suggester=SuggestFromList(COMMANDS, case_sensitive=False),
                id="prompt",
            )

    def on_mount(self) -> None:
        self.runtime.update_current_space(DEFAULT_MEMORY_SPACE)
        self.runtime.update_current_thread_id(self.thread_id)
        self._update_chrome()
        self.query_one("#prompt", Input).focus()
        self.run_worker(
            self._show_initial_state(),
            name="load Cleo chat",
            group="lifecycle",
            exit_on_error=False,
        )

    async def _show_initial_state(self) -> None:
        await self._append_renderable(
            Markdown(
                "### Cleo is ready\n"
                f"Memory project: **{self.runtime.current_project or 'general'}**\n\n"
                "Use `/project` for memory namespaces, `/sessions` to resume, "
                "or `/productivity` for a code workspace."
            ),
            classes="message welcome",
        )
        if self.restored_messages:
            await self._append_restored_messages(self.restored_messages)

    @on(Input.Submitted, "#prompt")
    def _on_prompt_submitted(self, event: Input.Submitted) -> None:
        prompt = event.value.strip()
        event.input.value = ""
        if prompt:
            self._start_submission(prompt)

    @on(Button.Pressed)
    def _on_button_pressed(self, event: Button.Pressed) -> None:
        command = {
            "action-new": "/new",
            "action-project": "/project",
            "action-sessions": "/sessions",
            "action-productivity": "/productivity",
            "action-attach": "/attach",
            "action-help": "/help",
        }.get(event.button.id or "")
        if command:
            self._start_submission(command)

    def _start_submission(self, prompt: str) -> None:
        if self.busy or self._cleo_exit_requested:
            self.notify("The current operation is still running.", severity="warning")
            return
        if prompt in {"/quit", "/exit"}:
            self._exit_immediately()
            return
        self._set_busy(True)
        self._active_worker = self.run_worker(
            self._dispatch(prompt),
            name=f"Cleo: {prompt[:32]}",
            group="agent",
            exclusive=True,
            exit_on_error=False,
        )

    async def _dispatch(self, prompt: str) -> None:
        try:
            if prompt.startswith("/"):
                await self._append_command(prompt)
                await self._run_command(prompt)
            else:
                await self._append_user(prompt)
                await self._run_agent_turn(prompt)
        except asyncio.CancelledError:
            if not self._cleo_exit_requested:
                await self._append_notice("Active operation cancelled.", tone="warning")
                await self._persist_interrupted()
        except Exception as exc:
            await self._append_notice(f"Cleo error: {exc}", tone="error")
        finally:
            if not self._cleo_exit_requested:
                self._set_busy(False)

    async def _run_command(self, prompt: str) -> None:
        if prompt in {"/quit", "/exit"}:
            self._exit_immediately()
            return
        if prompt == "/help":
            await self._append_help()
            return
        if prompt == "/new":
            await self._new_thread()
            return
        if prompt == "/project" or prompt.startswith("/project "):
            await self._command_project(prompt)
            return
        if prompt == "/sessions":
            await self._command_sessions()
            return
        if prompt == "/resume" or prompt.startswith("/resume "):
            await self._command_resume(prompt)
            return
        if prompt == "/rename" or prompt.startswith("/rename "):
            await self._command_rename(prompt)
            return
        if prompt == "/attach":
            await self._command_attach()
            return
        if prompt == "/productivity":
            await self._command_productivity()
            return
        await self._append_notice(f"Unknown command: {prompt}. Type /help.", tone="error")

    async def _run_agent_turn(self, prompt: str) -> None:
        self._assistant_text = ""
        self._assistant_widget = None
        async for chunk in self.agent.stream_text(
            prompt,
            thread_id=self.thread_id,
            loaded_info=self.restored_messages,
            images=self.attachments,
        ):
            await self._stream_assistant(chunk)
        if self._assistant_widget is None:
            await self._append_notice("Cleo completed without a text response.")
        self.restored_messages = None
        self.attachments = []
        await self._sync_current("active")
        self._update_chrome()

    async def _new_thread(self) -> None:
        await self._complete_current()
        self.thread_id = _new_thread_id()
        self.restored_messages = None
        self.attachments = []
        self.runtime.update_current_thread_id(self.thread_id)
        self.runtime.append_recent_threads(self.thread_id, DEFAULT_MEMORY_SPACE)
        await self._clear_transcript()
        await self._append_notice(f"Started new conversation: {self.thread_id}", tone="success")
        self._update_chrome()

    async def _command_project(self, prompt: str) -> None:
        argument = _slash_command_argument(prompt, "/project")
        if argument == "move" or argument.startswith("move "):
            target = argument.removeprefix("move").strip()
            if not target:
                raise RuntimeError("Usage: /project move <name>")
            await self._move_current_thread(validate_name(target, "project"))
            return
        if argument:
            await self._switch_project(validate_name(argument, "project"))
            return

        rows = self.store.list_sessions(space=DEFAULT_MEMORY_SPACE)
        counts: dict[str, int] = {}
        for row in rows:
            project = str(row.get("project") or "general")
            counts[project] = counts.get(project, 0) + 1
        for project in self.runtime.projects_for(DEFAULT_MEMORY_SPACE):
            counts.setdefault(project, 0)
        current = self.runtime.current_project or "general"
        projects = [(current, counts.pop(current, 0)), *counts.items()]
        selected = await self.push_screen_wait(MemoryProjectPicker(projects, current))
        if selected is not None:
            await self._switch_project(selected)

    async def _switch_project(self, project: str) -> None:
        current = self.runtime.current_project or "general"
        if project == current:
            await self._append_notice(f"Memory project {project!r} is already active.")
            return
        from cleo.agents import Agent

        next_agent = Agent(project=project, space=DEFAULT_MEMORY_SPACE)
        await self._complete_current()
        self.agent = next_agent
        self.thread_id = _new_thread_id()
        self.restored_messages = None
        self.attachments = []
        self.runtime.update_current_space(DEFAULT_MEMORY_SPACE)
        self.runtime.update_current_project(project)
        self.runtime.update_current_thread_id(self.thread_id)
        self.runtime.append_recent_threads(self.thread_id, DEFAULT_MEMORY_SPACE)
        await self._clear_transcript()
        await self._append_notice(
            f"Opened memory project {project!r}; started {self.thread_id}.",
            tone="success",
        )
        self._update_chrome()

    async def _move_current_thread(self, project: str) -> None:
        current = self.runtime.current_project or "general"
        if project == current:
            await self._append_notice(f"Conversation is already in {project!r}.")
            return
        from cleo.agents import Agent

        next_agent = Agent(project=project, space=DEFAULT_MEMORY_SPACE)
        await self._sync_current("active")
        messages = self.store.load_langchain_messages(self.thread_id)
        self.store.move_session(self.thread_id, project)
        self.agent = next_agent
        self.restored_messages = messages
        self.runtime.update_current_project(project)
        self.runtime.update_current_thread_id(self.thread_id)
        await self._clear_transcript()
        await self._append_restored_messages(messages)
        await self._append_notice(
            f"Moved this conversation to memory project {project!r}.",
            tone="success",
        )
        self._update_chrome()

    async def _command_sessions(self) -> None:
        rows = [
            row
            for row in self.store.list_sessions(space=DEFAULT_MEMORY_SPACE)
            if row.get("provider") == "cleo"
        ]
        if not any(row.get("id") == self.thread_id for row in rows):
            rows.insert(
                0,
                {
                    "id": self.thread_id,
                    "project": self.runtime.current_project or "general",
                    "status": "active",
                    "title": None,
                },
            )
        selected = await self.push_screen_wait(ChatSessionPicker(rows, self.thread_id))
        if selected is not None:
            await self._resume_thread(selected.session_id)

    async def _command_resume(self, prompt: str) -> None:
        session_id = _slash_command_argument(prompt, "/resume")
        if not session_id:
            raise RuntimeError("Usage: /resume <cleo-session-id>")
        await self._resume_thread(session_id)

    async def _resume_thread(self, session_id: str) -> None:
        if session_id == self.thread_id:
            await self._append_notice(f"Conversation {session_id} is already active.")
            return
        manifest = self.store.load_manifest(session_id)
        if (
            manifest["space"] != DEFAULT_MEMORY_SPACE
            or manifest["provider"] != "cleo"
        ):
            raise ValueError(f"Session {session_id} is not a Cleo conversation.")
        messages = self.store.load_langchain_messages(session_id)
        project = str(manifest["project"])
        from cleo.agents import Agent
        from cleo.agents.profiles import session_profile
        from cleo.config.settings import settings

        resumed_agent = Agent(
            project=project, space=DEFAULT_MEMORY_SPACE,
            profile=session_profile(settings, manifest), project_path=manifest.get("cwd"),
        )
        await self._complete_current()
        self.agent = resumed_agent
        self.thread_id = session_id
        self.restored_messages = messages
        self.attachments = []
        self.runtime.update_current_space(DEFAULT_MEMORY_SPACE)
        self.runtime.update_current_project(project)
        self.runtime.update_current_thread_id(session_id)
        self.runtime.append_recent_threads(session_id, DEFAULT_MEMORY_SPACE)
        await self._clear_transcript()
        await self._append_restored_messages(messages)
        await self._append_notice(f"Resumed Cleo conversation: {session_id}", tone="success")
        self._update_chrome()

    async def _command_rename(self, prompt: str) -> None:
        title = _slash_command_argument(prompt, "/rename")
        if not title:
            raise RuntimeError("Usage: /rename <title>")
        await self._sync_current("active")
        renamed = self.store.rename_session(self.thread_id, title)
        await self._append_notice(f"Renamed conversation to {renamed['title']!r}.", tone="success")

    async def _command_attach(self) -> None:
        path_value = await self.push_screen_wait(AttachmentPrompt())
        if path_value is None:
            return
        path = Path(os.path.expandvars(path_value)).expanduser().resolve()
        if not path.is_file():
            raise ValueError(f"File not found: {path}")
        mime_type, _ = mimetypes.guess_type(path)
        supported = {"image/jpeg", "image/png", "image/webp", "image/gif"}
        if mime_type not in supported:
            raise ValueError(f"Unsupported image type: {mime_type or 'unknown'}")
        data = await asyncio.to_thread(path.read_bytes)
        self.attachments.append(
            {
                "base64": base64.b64encode(data).decode("utf-8"),
                "mime_type": mime_type,
                "name": path.name,
            }
        )
        self._update_chrome()
        await self._append_notice(f"Attached {path.name} for the next message.", tone="success")

    async def _command_productivity(self) -> None:
        from cleo.config.settings import settings

        saved_project = self.runtime.current_project or "general"
        saved_thread = self.thread_id
        await self._sync_current("active")
        args = argparse.Namespace(
            message=None,
            provider=None,
            cwd=str(settings.active_directory_profile.root_path),
            model=None,
            project=None,
            resume_id=None,
        )
        try:
            with self.suspend():
                await _run_productivity_mode(
                    args,
                    self.runtime,
                    self.store,
                    settings,
                    return_to_chat=True,
                )
        finally:
            self.runtime.update_current_space(DEFAULT_MEMORY_SPACE)
            self.runtime.update_current_project(saved_project)
            self.runtime.update_current_thread_id(saved_thread)
            self.runtime.append_recent_threads(saved_thread, DEFAULT_MEMORY_SPACE)
        self._update_chrome()
        await self._append_notice("Returned to Cleo chat.", tone="success")

    async def _complete_current(self) -> None:
        await self._sync_current("completed")
        self._queue_consolidation(self.thread_id, self.runtime.current_project)

    async def _sync_current(self, status: str) -> None:
        await _sync_session_events(
            self.agent,
            self.runtime,
            self.thread_id,
            self.restored_messages,
            status=status,
            store=self.store,
        )

    async def _persist_interrupted(self) -> None:
        """Best-effort persistence for cancellation and abnormal TUI exit."""
        try:
            await asyncio.wait_for(
                self._sync_current("interrupted"),
                timeout=self.SYNC_TIMEOUT_SECONDS,
            )
        except Exception:
            pass

    def _exit_immediately(self) -> None:
        """End the Textual app without waiting for persistence or DreamAgent."""
        if self._cleo_exit_requested:
            return
        self._cleo_exit_requested = True
        self._queue_consolidation(self.thread_id, self.runtime.current_project)
        self.session_closed = True
        self.exit()

    def _queue_consolidation(self, thread_id: str, project: str | None) -> None:
        self._deferred_consolidations.append(
            (thread_id, project, DEFAULT_MEMORY_SPACE)
        )

    def _launch_consolidations(self) -> None:
        if self._consolidations_launched or not self._deferred_consolidations:
            return
        self._consolidations_launched = _launch_dream_agent_worker(
            self._deferred_consolidations,
            store=self.store,
        )

    def action_cancel_turn(self) -> None:
        if not self.busy or self._active_worker is None:
            self.notify("No active turn.")
            return
        self._active_worker.cancel()

    def action_request_quit(self) -> None:
        if self.busy:
            self.notify("Cancel the active turn before leaving.", severity="warning")
            return
        self._exit_immediately()

    def action_clear_transcript(self) -> None:
        if not self.busy:
            self.run_worker(
                self._clear_transcript(add_welcome=True),
                name="clear chat view",
                group="view",
                exclusive=True,
                exit_on_error=False,
            )

    async def _clear_transcript(self, *, add_welcome: bool = False) -> None:
        await self.query_one("#transcript", VerticalScroll).remove_children()
        self._assistant_widget = None
        self._assistant_text = ""
        if add_welcome:
            await self._show_initial_state()

    def _set_busy(self, busy: bool) -> None:
        self.busy = busy
        self.set_class(busy, "busy")
        prompt = self.query_one("#prompt", Input)
        prompt.disabled = busy
        for button in self.query(".quick").nodes:
            if isinstance(button, Button):
                button.disabled = busy
        if not busy:
            prompt.focus()
        self.query_one("#composer-hint", Static).update(
            "Cleo is working…  Ctrl+C to cancel"
            if busy
            else "Enter to send  ·  / for commands  ·  Ctrl+C cancel  ·  Ctrl+Q quit"
        )

    def _update_chrome(self) -> None:
        if not self.is_mounted:
            return
        project = self.runtime.current_project or "general"
        top = Text()
        top.append("CLEO", style="bold #d4adff")
        top.append("   CHAT", style="bold #8fd7ff")
        top.append(f"   {project}", style="dim")
        self.query_one("#topbar", Static).update(top)

        usage = self.agent.context_usage
        status = Text()
        status.append(f"MODEL  {self.agent.model_name}", style="bold #d4adff")
        if usage.used_tokens is None:
            status.append("    CONTEXT  waiting", style="#bcb0ca")
        elif usage.window_tokens:
            status.append(
                f"    CONTEXT  {usage.used_tokens:,} / {usage.window_tokens:,}"
                f"  {(usage.ratio or 0):.0%}",
                style="#bcb0ca",
            )
        else:
            status.append(f"    CONTEXT  {usage.used_tokens:,} used", style="#bcb0ca")
        self.query_one("#statusbar", Static).update(status)

        session_text = Text()
        session_text.append("CONVERSATION\n", style="bold #a787cf")
        session_text.append(self.thread_id, style="#e9e5f0")
        self.query_one("#session-card", Static).update(session_text)

        project_text = Text()
        project_text.append("MEMORY PROJECT\n", style="bold #a787cf")
        project_text.append(project, style="bold #8fd7ff")
        session_count = len(
            self.store.list_sessions(space=DEFAULT_MEMORY_SPACE, project=project)
        )
        project_text.append(f"\n{session_count} saved conversation(s)", style="dim")
        self.query_one("#control-card", Static).update(project_text)

        attachment_text = Text()
        attachment_text.append("NEXT MESSAGE\n", style="bold #a787cf")
        if self.attachments:
            attachment_text.append("\n".join(item["name"] for item in self.attachments))
        else:
            attachment_text.append("no attachments", style="dim")
        self.query_one("#git-card", Static).update(attachment_text)

    async def _append_help(self) -> None:
        await self._append_renderable(
            Markdown(
                "### Commands\n"
                "- `/project` choose a memory project; "
                "`/project move <name>` moves this conversation\n"
                "- `/sessions` click to resume a Cleo conversation · `/new` start fresh\n"
                "- `/attach` add an image to the next message · `/rename <title>`\n"
                "- `/productivity` open the code workspace · `/quit` leave"
            ),
            classes="message event-message",
        )

    async def _append_restored_messages(self, messages: list[BaseMessage]) -> None:
        from cleo.cli.chat import _message_content_to_text, _message_role

        for message in messages:
            content = _message_content_to_text(message.content)
            if not content:
                continue
            role = _message_role(message)
            if role == "User":
                text = Text("YOU\n", style="bold #8fd7ff")
                await self._append_renderable(
                    Text.assemble(text, Text(content)),
                    classes="message user-message",
                )
            elif role == "Assistant":
                text = Text("CLEO\n", style="bold #83d697")
                await self._append_renderable(
                    Text.assemble(text, Text(content)),
                    classes="message assistant-message",
                )
            else:
                text = Text(f"{role}\n", style="bold #a787cf")
                await self._append_renderable(
                    Text.assemble(text, Text(content)),
                    classes="message event-message",
                )

    async def _append_user(self, message: str) -> None:
        label = Text("YOU\n", style="bold #8fd7ff")
        await self._append_renderable(
            Text.assemble(label, Text(message)),
            classes="message user-message",
        )

    async def _append_command(self, command: str) -> None:
        text = Text("COMMAND  ", style="bold #a787cf")
        text.append(command, style="dim")
        await self._append_renderable(text, classes="message event-message")

    async def _stream_assistant(self, chunk: str) -> None:
        self._assistant_text += chunk
        if self._assistant_widget is None:
            self._assistant_widget = Static(classes="message assistant-message")
            await self._mount(self._assistant_widget)
        label = Text("CLEO\n", style="bold #83d697")
        self._assistant_widget.update(
            Text.assemble(label, Text(self._assistant_text))
        )
        self._scroll_end()

    async def _append_notice(self, message: str, *, tone: str = "info") -> None:
        styles = {
            "info": ("INFO", "bold #a787cf", "message event-message"),
            "success": ("DONE", "bold #83d697", "message assistant-message"),
            "warning": ("NOTE", "bold yellow", "message terminal-message"),
            "error": ("ERROR", "bold red", "message error-message"),
        }
        label, style, classes = styles[tone]
        text = Text(f"{label}\n", style=style)
        text.append(message)
        await self._append_renderable(text, classes=classes)

    async def _append_renderable(self, renderable: Any, *, classes: str) -> None:
        await self._mount(Static(renderable, classes=classes))

    async def _mount(self, widget: Static) -> None:
        transcript = self.query_one("#transcript", VerticalScroll)
        await transcript.mount(widget)
        self._scroll_end()

    def _scroll_end(self) -> None:
        self.query_one("#transcript", VerticalScroll).scroll_end(animate=False)


async def run_chat_tui(
    agent: Agent,
    runtime: Runtime,
    thread_id: str,
    store: SessionStore,
    *,
    restored_messages: list[BaseMessage] | None = None,
) -> None:
    """Run Cleo chat and guarantee best-effort persistence on abnormal exit."""
    app = CleoChatApp(
        agent,
        runtime,
        thread_id,
        store,
        restored_messages=restored_messages,
    )
    try:
        await app.run_async(mouse=True)
    finally:
        clear_terminal_after_tui()
        if not app.session_closed:
            await app._persist_interrupted()
            app._queue_consolidation(app.thread_id, runtime.current_project)
            app.session_closed = True
        runtime.current_project = None
        runtime.current_thread_id = None
        try:
            runtime.update_runtime_json()
        except OSError:
            pass
        app._launch_consolidations()
