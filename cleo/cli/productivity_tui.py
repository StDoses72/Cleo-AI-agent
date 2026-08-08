"""Full-screen Textual interface for interactive productivity sessions."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from rich.markdown import Markdown
from rich.pretty import Pretty
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from textual import on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.suggester import SuggestFromList
from textual.widgets import Button, Collapsible, Input, OptionList, Static
from textual.widgets.option_list import Option

from cleo.cli import productivity as productivity_cli
from cleo.cli.context import clear_terminal_after_tui
from cleo.cli.lifecycle import _launch_dream_agent_worker
from cleo.cli.productivity_history import (
    TranscriptEntry,
    event_transcript_entries,
    native_transcript_entries,
)
from cleo.cli.productivity_renderer import (
    capture_context_usage,
    event_payload,
    format_reset,
    summarize_diff,
    summarize_productivity_event,
)
from cleo.integrations.git import GitStatus, inspect_git_status, read_git_diff
from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from textual.worker import Worker

    from cleo.harnesses import (
        AgentAdapter,
        AgentEvent,
        AgentResult,
        AgentSession,
        HarnessModel,
        NativeSessionPage,
        SessionOptions,
    )
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore


COMMANDS = (
    "/help",
    "/new",
    "/cwd",
    "/project",
    "/git",
    "/diff",
    "/model ",
    "/effort ",
    "/access ",
    "/approval ",
    "/cd ",
    "/resume ",
    "/resume-native ",
    "/native ",
    "/sessions",
    "/account",
    "/fork",
    "/rename ",
    "/compact",
    "/archive",
    "/back",
    "/quit",
)


class DiffBlock(Collapsible):
    """A mouse-toggleable unified diff block."""

    DEFAULT_CSS = """
    DiffBlock {
        width: 100%;
        height: auto;
        margin: 0 0 1 0;
        border: round #6f4bb8;
        background: #12101b;
    }

    DiffBlock:focus-within {
        border: round #b98cff;
    }

    DiffBlock .diff-body {
        width: 100%;
        height: auto;
        max-height: 32;
        overflow-y: auto;
        padding: 0 1 1 1;
    }
    """

    def __init__(self, diff: str, *, collapsed: bool = True) -> None:
        self.diff = diff
        self.body = Static(self._syntax(diff))
        self.scroller = VerticalScroll(self.body, classes="diff-body")
        super().__init__(
            self.scroller,
            title=self._title(diff),
            collapsed=collapsed,
            classes="diff-block",
        )

    def replace_diff(self, diff: str) -> None:
        """Update an in-flight diff without adding another transcript card."""
        self.diff = diff
        self.title = self._title(diff)
        self.body.update(self._syntax(diff))

    @staticmethod
    def _syntax(diff: str) -> Syntax:
        return Syntax(
            diff or "No tracked working-tree changes.",
            "diff",
            theme="ansi_dark",
            word_wrap=True,
            background_color="default",
        )

    @staticmethod
    def _title(diff: str) -> str:
        summary = summarize_diff(diff)
        return f"Changes  ·  {summary.removesuffix(' · /diff to expand')}"


@dataclass(frozen=True, slots=True)
class SessionChoice:
    """A resumable row selected from the session picker."""

    kind: str
    session_id: str
    project: str
    cwd: str


@dataclass(frozen=True, slots=True)
class ProjectChoice:
    """A project directory selected from the project picker."""

    project: str
    cwd: str
    session_count: int = 0
    current: bool = False


class SessionPicker(ModalScreen[SessionChoice | None]):
    """Mouse-first picker for managed and provider-native sessions."""

    DEFAULT_CSS = """
    SessionPicker {
        align: center middle;
        background: #09080fcc;
    }

    #session-picker-dialog {
        width: 90%;
        max-width: 120;
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

    #session-options {
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

    def __init__(self, rows: list[dict[str, Any]], current_session_id: str) -> None:
        super().__init__()
        self._choices: dict[str, SessionChoice] = {}
        self._options: list[Option] = []
        for index, row in enumerate(rows):
            session_id = str(row.get("id") or "")
            if not session_id:
                continue
            origin = str(row.get("origin") or "cleo")
            is_native = origin == "native"
            native_id = str(row.get("native_session_id") or session_id)
            option_id = f"session-choice-{index}"
            choice = SessionChoice(
                kind="native" if is_native else "managed",
                session_id=native_id if is_native else session_id,
                project=str(row.get("project") or "general"),
                cwd=str(row.get("cwd") or ""),
            )
            self._choices[option_id] = choice
            title = str(row.get("title") or "Untitled session").strip()
            status = str(row.get("status") or "unknown")
            current = session_id == current_session_id
            resumable = current or is_native or bool(row.get("native_session_id"))
            label = Text()
            label.append("●  " if current else "   ", style="#83d697")
            label.append(title, style="bold #f0e9f7")
            label.append(f"\n   {session_id}  ·  {origin}  ·  {status}", style="dim")
            location = str(row.get("cwd") or row.get("project") or "")
            if location:
                label.append(f"\n   {location}", style="#8fd7ff")
            if not resumable:
                label.append("  ·  waiting for first turn", style="yellow")
            self._options.append(
                Option(label, id=option_id, disabled=not resumable)
            )

    def compose(self) -> ComposeResult:
        with Vertical(id="session-picker-dialog"):
            yield Static("Resume a session", classes="picker-title")
            yield Static(
                "Click a row to resume it. Use ↑/↓ and Enter from the keyboard.",
                classes="picker-hint",
            )
            if self._options:
                yield OptionList(*self._options, id="session-options", markup=False)
            else:
                yield OptionList(
                    Option("No resumable productivity sessions found.", disabled=True),
                    id="session-options",
                    markup=False,
                )
            with Horizontal(classes="picker-actions"):
                yield Button("Cancel", id="session-cancel")

    @on(OptionList.OptionSelected, "#session-options")
    def _on_session_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        option_id = event.option.id
        if option_id is not None and option_id in self._choices:
            self.dismiss(self._choices[option_id])

    @on(Button.Pressed, "#session-cancel")
    def _on_cancel_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ProjectPicker(ModalScreen[ProjectChoice | None]):
    """Recent-project picker with an escape hatch for an arbitrary folder."""

    DEFAULT_CSS = """
    ProjectPicker {
        align: center middle;
        background: #09080fcc;
    }

    #project-picker-dialog {
        width: 90%;
        max-width: 110;
        height: 82%;
        max-height: 40;
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

    #project-options {
        height: 1fr;
        margin: 1 0;
        border: round #382b4f;
        background: #0e0c15;
        scrollbar-color: #6f4bb8;
    }

    #project-path {
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

    def __init__(self, choices: tuple[ProjectChoice, ...]) -> None:
        super().__init__()
        self._choices: dict[str, ProjectChoice] = {}
        self._options: list[Option] = []
        for index, choice in enumerate(choices):
            option_id = f"project-choice-{index}"
            self._choices[option_id] = choice
            label = Text()
            label.append("●  " if choice.current else "   ", style="#83d697")
            label.append(choice.project, style="bold #f0e9f7")
            if choice.session_count:
                label.append(
                    f"  ·  {choice.session_count} saved session(s)",
                    style="dim",
                )
            label.append(f"\n   {choice.cwd}", style="#8fd7ff")
            self._options.append(Option(label, id=option_id))

    def compose(self) -> ComposeResult:
        with Vertical(id="project-picker-dialog"):
            yield Static("Open a project", classes="picker-title")
            yield Static(
                "Click a recent project, or enter any existing directory below.",
                classes="picker-hint",
            )
            yield OptionList(*self._options, id="project-options", markup=False)
            yield Input(
                placeholder="Enter a project directory…",
                id="project-path",
            )
            with Horizontal(classes="picker-actions"):
                yield Button("Open path", id="project-open", variant="primary")
                yield Button("Cancel", id="project-cancel")

    @on(OptionList.OptionSelected, "#project-options")
    def _on_project_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        option_id = event.option.id
        if option_id is not None and option_id in self._choices:
            self.dismiss(self._choices[option_id])

    @on(Input.Submitted, "#project-path")
    def _on_path_submitted(self, event: Input.Submitted) -> None:
        event.stop()
        self._dismiss_path(event.value)

    @on(Button.Pressed, "#project-open")
    def _on_open_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self._dismiss_path(self.query_one("#project-path", Input).value)

    @on(Button.Pressed, "#project-cancel")
    def _on_cancel_pressed(self, event: Button.Pressed) -> None:
        event.stop()
        self.dismiss(None)

    def _dismiss_path(self, value: str) -> None:
        value = value.strip()
        if not value:
            self.notify("Enter a directory to open.", severity="warning")
            return
        self.dismiss(ProjectChoice(project="", cwd=value))

    def action_cancel(self) -> None:
        self.dismiss(None)


class ProductivityApp(App[None]):
    """Textual shell around the existing harness adapter and session lifecycle."""

    TITLE = "Cleo Productivity"
    SUB_TITLE = "Agent workspace"
    CLOSE_TIMEOUT_SECONDS = 0.35

    CSS = """
    Screen {
        background: #09080f;
        color: #e9e5f0;
    }

    #topbar {
        height: 3;
        padding: 1 2 0 2;
        background: #151020;
        color: #f7f2ff;
        border-bottom: solid #6f4bb8;
    }

    #statusbar {
        height: 2;
        padding: 0 2;
        background: #100d18;
        color: #c9bdd8;
        border-bottom: solid #2e2440;
    }

    #workspace {
        height: 1fr;
    }

    #transcript {
        width: 1fr;
        height: 1fr;
        padding: 1 2;
        scrollbar-color: #6f4bb8;
        scrollbar-color-hover: #b98cff;
        scrollbar-color-active: #d9bfff;
    }

    #sidebar {
        width: 35;
        min-width: 29;
        height: 1fr;
        padding: 1;
        background: #0e0c15;
        border-left: solid #2e2440;
        scrollbar-color: #6f4bb8;
    }

    .side-card {
        width: 100%;
        height: auto;
        margin: 0 0 1 0;
        padding: 1;
        background: #151020;
        border: round #382b4f;
    }

    .side-title {
        color: #a787cf;
        text-style: bold;
    }

    #quick-actions {
        width: 100%;
        height: auto;
        layout: grid;
        grid-size: 2;
        grid-gutter: 1;
    }

    #quick-actions Button {
        width: 1fr;
        min-width: 10;
    }

    .message {
        width: 100%;
        height: auto;
        margin: 0 0 1 0;
        padding: 1 2;
        border: round #30283e;
        background: #100e17;
    }

    .user-message {
        border: round #375d73;
        background: #0d1820;
    }

    .assistant-message {
        border: round #45664f;
        background: #0d1711;
    }

    .terminal-message {
        border: round #6b5934;
        background: #17140d;
        color: #c4bda9;
    }

    .event-message {
        border: round #4b3b67;
    }

    .error-message {
        border: round #8b3e4b;
        background: #1d0d11;
    }

    .welcome {
        border: round #6f4bb8;
        background: #151020;
    }

    #composer {
        height: 5;
        padding: 0 2;
        background: #100d18;
        border-top: solid #2e2440;
    }

    #composer-hint {
        height: 1;
        color: #756b82;
    }

    #prompt {
        height: 3;
        border: round #6f4bb8;
        background: #171221;
        color: #f3edf9;
    }

    #prompt:focus {
        border: round #c89cff;
    }

    .busy #prompt {
        border: round #8b7444;
    }
    """

    BINDINGS = (
        Binding("ctrl+c", "cancel_turn", "Cancel turn", show=True),
        Binding("ctrl+d", "toggle_last_diff", "Toggle diff", show=True),
        Binding("ctrl+l", "clear_transcript", "Clear view", show=True),
        Binding("ctrl+q", "request_quit", "Quit", show=True),
    )

    def __init__(
        self,
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
        super().__init__()
        self.adapter = adapter
        self.session = session
        self.runtime = runtime
        self.store = store
        self.model_override = model
        self.provider_models = dict(provider_models or {})
        self.return_to_chat = return_to_chat
        self.restore_initial_history = restore_initial_history
        self.session_model = self._model_for(session.provider)
        self.active_model = self.session_model or "default"
        self.context_usage = ContextWindowUsage()
        self.available_models: tuple[HarnessModel, ...] = ()
        self.native_page: NativeSessionPage | None = None
        self.git_status: GitStatus | None = None
        self.session_closed = False
        self.busy = False
        self._productivity_exit_requested = False
        self._active_worker: Worker[Any] | None = None
        self._assistant_text = ""
        self._terminal_text = ""
        self._assistant_widget: Static | None = None
        self._terminal_widget: Static | None = None
        self._turn_diff: DiffBlock | None = None
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
                    yield Button("Diff", id="action-diff", classes="quick")
                    yield Button("Sessions", id="action-sessions", classes="quick")
                    yield Button("Help", id="action-help", classes="quick")
        with Vertical(id="composer"):
            yield Static(
                "Enter to send  ·  / for commands  ·  Ctrl+C cancel  ·  Ctrl+D diff",
                id="composer-hint",
            )
            yield Input(
                placeholder="Ask the agent, or type /help…",
                suggester=SuggestFromList(COMMANDS, case_sensitive=False),
                id="prompt",
            )

    def on_mount(self) -> None:
        self._update_chrome()
        self.query_one("#prompt", Input).focus()
        self.run_worker(
            self._load_initial_state(),
            name="load productivity workspace",
            group="lifecycle",
            exit_on_error=False,
        )

    async def _load_initial_state(self) -> None:
        self.available_models, self.native_page = (
            await productivity_cli._load_productivity_catalog(
                self.adapter,
                self.session.provider,
            )
        )
        await productivity_cli._refresh_rate_limit_usage(
            self.adapter,
            self.session.id,
            self.context_usage,
        )
        await self._refresh_git()
        self._update_chrome()
        if self.restore_initial_history:
            history = await self._load_session_history(
                provider=self.session.provider,
                native_session_id=self.session.native_session_id,
                managed_session_id=self.session.id,
            )
            await self._append_history(history)
            await self._append_notice(self._history_notice("Resumed session", history))
        else:
            await self._append_welcome()

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
            "action-diff": "/diff",
            "action-sessions": "/sessions",
            "action-help": "/help",
        }.get(event.button.id or "")
        if command:
            self._start_submission(command)

    def _start_submission(self, prompt: str) -> None:
        if self.busy or self._productivity_exit_requested:
            self.notify("The current operation is still running.", severity="warning")
            return
        if prompt in {"/back", "/quit", "/exit"}:
            self._exit_immediately()
            return
        self._set_busy(True)
        self._active_worker = self.run_worker(
            self._dispatch(prompt),
            name=f"productivity: {prompt[:32]}",
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
            await self._append_notice("Active operation cancelled.", tone="warning")
        except Exception as exc:
            await self._append_notice(f"Productivity error: {exc}", tone="error")
        finally:
            if not self._productivity_exit_requested:
                self._set_busy(False)

    async def _run_command(self, prompt: str) -> None:
        if prompt in {"/back", "/quit", "/exit"}:
            self._exit_immediately()
            return
        if prompt == "/help":
            await self._append_help()
            return
        if prompt == "/new":
            await self._new_session()
            return
        if prompt == "/cwd":
            await self._append_notice(self.session.project_path)
            return
        if prompt == "/project":
            await self._command_project()
            return
        if prompt == "/git":
            await self._refresh_git()
            await self._append_git_status()
            return
        if prompt == "/diff":
            await self._show_working_diff()
            return
        if prompt == "/model" or prompt.startswith("/model "):
            await self._command_model(prompt)
            return
        if prompt == "/effort" or prompt.startswith("/effort "):
            await self._command_option(prompt, "/effort", "effort", "Reasoning effort")
            return
        if prompt == "/access" or prompt.startswith("/access "):
            await self._command_option(prompt, "/access", "sandbox", "Filesystem access")
            return
        if prompt == "/approval" or prompt.startswith("/approval "):
            await self._command_option(
                prompt,
                "/approval",
                "approval_mode",
                "Approval behavior",
            )
            return
        if prompt == "/cd" or prompt.startswith("/cd "):
            await self._command_cd(prompt)
            return
        if prompt == "/resume" or prompt.startswith("/resume "):
            await self._command_resume(prompt)
            return
        if prompt == "/resume-native" or prompt.startswith("/resume-native "):
            await self._command_resume_native(prompt)
            return
        if prompt == "/native" or prompt.startswith("/native "):
            await self._command_native(prompt)
            return
        if prompt == "/sessions":
            await self._command_sessions()
            return
        if prompt == "/account":
            await self._command_account()
            return
        if prompt == "/fork":
            await self._command_fork()
            return
        if prompt == "/rename" or prompt.startswith("/rename "):
            await self._command_rename(prompt)
            return
        if prompt == "/compact":
            await self._command_compact()
            return
        if prompt == "/archive":
            await self._command_archive()
            return
        await self._append_notice(f"Unknown command: {prompt}. Type /help.", tone="error")

    async def _run_agent_turn(self, prompt: str) -> None:
        self._reset_turn_widgets()
        result = await self.adapter.prompt(
            self.session.id,
            prompt,
            on_event=self._on_agent_event,
        )
        await productivity_cli._refresh_rate_limit_usage(
            self.adapter,
            self.session.id,
            self.context_usage,
        )
        if result.response and self._assistant_widget is None:
            await self._append_assistant(result.response)
        await self._append_turn_status(result)
        self.runtime.append_recent_threads(self.session.id, "productivity")
        await self._refresh_git()
        self._update_chrome()

    async def _on_agent_event(self, event: AgentEvent) -> None:
        capture_context_usage(event, self.context_usage)
        provider_event_type = event.data.get("provider_event_type")
        if event.type in {"assistant_message_chunk", "agent_message"} and event.text:
            await self._stream_assistant(event.text)
            return
        if event.type == "terminal_output" and event.text:
            await self._stream_terminal(event.text)
            return
        if event.type == "file_change" and provider_event_type in {
            "item/fileChange/outputDelta",
            "item/fileChange/patchUpdated",
        }:
            return
        if event.type == "file_change" and provider_event_type == "turn/diff/updated":
            payload = event_payload(event)
            diff = event.text or payload.get("diff")
            if isinstance(diff, str):
                await self._upsert_turn_diff(diff)
            return
        summary = summarize_productivity_event(event)
        if summary is not None:
            label, message, style = summary
            await self._append_event(label, message, style)
        self._update_chrome()

    async def _new_session(self) -> None:
        previous = self.session
        new_session = await self.adapter.create_session(
            previous.provider,
            project_path=previous.project_path,
            model=self.session_model,
            project=previous.project,
        )
        await self._replace_session(
            new_session,
            f"Started new {new_session.provider} session.",
        )

    async def _command_model(self, prompt: str) -> None:
        requested = productivity_cli._slash_command_argument(prompt, "/model")
        if not requested:
            rows = [
                f"• {item.id}{'  (default)' if item.is_default else ''}"
                for item in self.available_models
            ]
            detail = "\n".join(rows) if rows else "Provider did not return a model catalog."
            await self._append_notice(f"Active model: {self.active_model}\n{detail}")
            return
        known = {item.id for item in self.available_models}
        if known and requested not in known:
            await self._append_notice(f"Unknown model: {requested}", tone="error")
            return
        options = await self._update_option("model", requested)
        self.session_model = options.model
        self.active_model = options.model or "default"
        self._update_chrome()
        await self._append_notice(
            f"Model set to {self.active_model}; it applies to the next turn.",
            tone="success",
        )

    async def _command_option(
        self,
        prompt: str,
        command: str,
        option_key: str,
        label: str,
    ) -> None:
        requested = productivity_cli._slash_command_argument(prompt, command)
        if not requested:
            options = productivity_cli._productivity_options(self.adapter, self.session.id)
            current = getattr(options, option_key) if options is not None else None
            await self._append_notice(f"{label}: {current or 'default'}")
            return
        options = await self._update_option(option_key, requested)
        self._update_chrome()
        await self._append_notice(
            f"{label} set to {getattr(options, option_key) or 'default'}.",
            tone="success",
        )

    async def _update_option(self, option_key: str, requested: str) -> SessionOptions:
        try:
            return await self.adapter.update_session_options(
                self.session.id,
                **{option_key: requested},
            )
        except (KeyError, NotImplementedError, ValueError) as exc:
            raise RuntimeError(str(exc)) from exc

    async def _command_cd(self, prompt: str) -> None:
        target = productivity_cli._resolve_productivity_cwd(
            productivity_cli._slash_command_argument(prompt, "/cd"),
            self.session.project_path,
        )
        next_session = await self.adapter.create_session(
            self.session.provider,
            project_path=target,
            model=self.session_model,
            project=Path(target).name or "general",
        )
        await self._replace_session(
            next_session,
            f"Changed cwd to {next_session.project_path}.",
            update_project=True,
        )

    async def _command_project(self) -> None:
        """Open a recent-project picker and start a session in the selection."""
        managed = self.store.list_sessions(space="productivity")
        choices_by_path: dict[str, ProjectChoice] = {}

        def add_choice(
            project: str,
            cwd: str,
            *,
            session_count: int = 0,
        ) -> None:
            if not cwd:
                return
            try:
                directory = Path(cwd).expanduser().resolve()
                if not directory.is_dir():
                    return
            except OSError:
                return
            path = str(directory)
            key = path.casefold()
            current = path.casefold() == str(
                Path(self.session.project_path).resolve()
            ).casefold()
            existing = choices_by_path.get(key)
            if existing is None:
                choices_by_path[key] = ProjectChoice(
                    project=project or directory.name or "general",
                    cwd=path,
                    session_count=session_count,
                    current=current,
                )
                return
            choices_by_path[key] = ProjectChoice(
                project=existing.project,
                cwd=existing.cwd,
                session_count=existing.session_count + session_count,
                current=existing.current or current,
            )

        add_choice(
            Path(self.session.project_path).name or "general",
            self.session.project_path,
        )
        for row in managed:
            add_choice(
                Path(str(row.get("cwd") or "")).name or "general",
                str(row.get("cwd") or ""),
                session_count=1,
            )
        choices = tuple(choices_by_path.values())
        choice = await self.push_screen_wait(ProjectPicker(choices))
        if choice is None:
            return
        target = productivity_cli._resolve_productivity_cwd(
            choice.cwd,
            self.session.project_path,
        )
        project = choice.project or Path(target).name or "general"
        if target.casefold() == self.session.project_path.casefold():
            await self._append_notice(f"Project {Path(target).name} is already open.")
            return
        next_session = await self.adapter.create_session(
            self.session.provider,
            project_path=target,
            model=self.session_model,
            project=project,
        )
        await self._replace_session(
            next_session,
            f"Opened project {project} in {next_session.project_path}.",
            update_project=True,
        )

    async def _command_resume(self, prompt: str) -> None:
        session_id = productivity_cli._slash_command_argument(prompt, "/resume")
        if not session_id:
            raise RuntimeError("Usage: /resume <productivity-session-id>")
        if session_id == self.session.id:
            await self._append_notice(f"Session {session_id} is already active.")
            return
        manifest = self.store.load_manifest(session_id)
        provider = str(manifest["provider"])
        resume_model = self._model_for(provider)
        native_session_id = str(manifest.get("native_session_id") or "") or None
        history = await self._load_session_history(
            provider=provider,
            native_session_id=native_session_id,
            managed_session_id=session_id,
        )
        resumed = await productivity_cli._resume_productivity_session(
            self.adapter,
            self.store,
            session_id,
            model=resume_model,
        )
        self.session_model = resume_model
        self.active_model = resume_model or "default"
        await self._replace_session(
            resumed,
            self._history_notice(
                f"Resumed {resumed.provider} session: {resumed.id}",
                history,
            ),
            update_project=True,
            reload_catalog=True,
            history=history,
        )

    async def _command_resume_native(self, prompt: str) -> None:
        native_id = productivity_cli._slash_command_argument(prompt, "/resume-native")
        if not native_id:
            raise RuntimeError("Usage: /resume-native <native-thread-id>")
        native_sessions = self.native_page.sessions if self.native_page is not None else ()
        native = next((item for item in native_sessions if item.id == native_id), None)
        await self._resume_native_session(
            native_id,
            cwd=native.cwd if native is not None else self.session.project_path,
            project=self.session.project,
        )

    async def _resume_native_session(
        self,
        native_id: str,
        *,
        cwd: str,
        project: str,
    ) -> None:
        history = await self._load_session_history(
            provider=self.session.provider,
            native_session_id=native_id,
            managed_session_id=None,
        )
        resumed = await self.adapter.resume_session(
            self.session.provider,
            native_id,
            project_path=cwd or self.session.project_path,
            model=self.session_model,
            project=project or self.session.project,
        )
        await self._replace_session(
            resumed,
            self._history_notice(f"Resumed native thread: {native_id}", history),
            update_project=True,
            history=history,
        )

    async def _load_session_history(
        self,
        *,
        provider: str,
        native_session_id: str | None,
        managed_session_id: str | None,
    ) -> tuple[TranscriptEntry, ...]:
        if native_session_id:
            try:
                detail = await self.adapter.read_native_session(
                    provider,
                    native_session_id,
                )
            except (KeyError, NotImplementedError, OSError, RuntimeError, ValueError):
                pass
            else:
                history = native_transcript_entries(detail.turns)
                if history:
                    return history
        if managed_session_id:
            try:
                events = await asyncio.to_thread(
                    self.store.read_events,
                    managed_session_id,
                )
            except (AttributeError, FileNotFoundError, OSError, ValueError):
                return ()
            return event_transcript_entries(events)
        return ()

    async def _append_history(self, history: tuple[TranscriptEntry, ...]) -> None:
        presentation = {
            "user": ("YOU", "bold #8fd7ff", "message user-message"),
            "assistant": ("CODEX", "bold #83d697", "message assistant-message"),
            "thought": ("THOUGHT", "bold #a787cf", "message thought-message"),
            "terminal": ("TERMINAL", "bold #d9bc7a", "message terminal-message"),
            "error": ("ERROR", "bold red", "message error-message"),
            "event": ("EVENT", "bold #a787cf", "message event-message"),
        }
        for entry in history:
            label, style, classes = presentation.get(
                entry.kind,
                presentation["event"],
            )
            heading = Text(f"{label}\n", style=style)
            await self._append_renderable(
                Text.assemble(heading, Text(entry.text)),
                classes=classes,
            )

    @staticmethod
    def _history_notice(prefix: str, history: tuple[TranscriptEntry, ...]) -> str:
        if not history:
            return f"{prefix}; no transcript content was returned."
        return f"{prefix} · restored {len(history)} transcript item(s)."

    async def _command_native(self, prompt: str) -> None:
        native_id = productivity_cli._slash_command_argument(prompt, "/native")
        if not native_id:
            raise RuntimeError("Usage: /native <native-thread-id>")
        detail = await self.adapter.read_native_session(self.session.provider, native_id)
        table = Table(title=detail.session.name or native_id, expand=True)
        table.add_column("Field", style="dim", no_wrap=True)
        table.add_column("Value", overflow="fold")
        table.add_row("status", detail.session.status)
        table.add_row("source", detail.session.source)
        table.add_row("cwd", detail.session.cwd)
        table.add_row("preview", detail.session.preview or "—")
        await self._append_renderable(table, classes="message event-message")
        if detail.turns:
            await self._append_renderable(
                Pretty(detail.turns, expand_all=False),
                classes="message terminal-message",
            )

    async def _command_sessions(self) -> None:
        from cleo.sessions.hub import merge_session_rows

        _, self.native_page = await productivity_cli._load_productivity_catalog(
            self.adapter,
            self.session.provider,
        )
        rows = merge_session_rows(
            self.store.list_sessions(space="productivity"),
            self.native_page.sessions,
            provider=self.session.provider,
        )
        choice = await self.push_screen_wait(SessionPicker(rows, self.session.id))
        if choice is None:
            return
        if choice.kind == "native":
            await self._resume_native_session(
                choice.session_id,
                cwd=choice.cwd or self.session.project_path,
                project=choice.project or self.session.project,
            )
            return
        await self._command_resume(f"/resume {choice.session_id}")

    async def _command_account(self) -> None:
        account = await self.adapter.account_status(self.session.provider)
        table = Table(title=f"{self.session.provider} account", expand=True)
        table.add_column("Field", style="dim")
        table.add_column("Value")
        table.add_row("authenticated", "yes" if account.authenticated else "no")
        table.add_row("type", account.account_type or "—")
        table.add_row("email", account.email or "—")
        table.add_row("plan", account.plan or "—")
        await self._append_renderable(table, classes="message event-message")

    async def _command_fork(self) -> None:
        forked = await self.adapter.fork_session(self.session.id)
        await self._replace_session(forked, f"Forked into session: {forked.id}")

    async def _command_rename(self, prompt: str) -> None:
        name = productivity_cli._slash_command_argument(prompt, "/rename")
        if not name:
            raise RuntimeError("Usage: /rename <name>")
        await self.adapter.rename_session(self.session.id, name)
        await self._append_notice(f"Native thread renamed to: {name}", tone="success")

    async def _command_compact(self) -> None:
        await self.adapter.compact_session(self.session.id)
        self.context_usage = ContextWindowUsage()
        await productivity_cli._refresh_rate_limit_usage(
            self.adapter,
            self.session.id,
            self.context_usage,
        )
        self._update_chrome()
        await self._append_notice("Native context compaction started.", tone="success")

    async def _command_archive(self) -> None:
        previous = self.session
        await self.adapter.archive_session(previous.id)
        new_session = await self.adapter.create_session(
            previous.provider,
            project_path=previous.project_path,
            model=self.session_model,
            project=previous.project,
        )
        await self._replace_session(
            new_session,
            "Archived thread and started a new session.",
        )

    async def _replace_session(
        self,
        next_session: AgentSession,
        message: str,
        *,
        update_project: bool = False,
        reload_catalog: bool = False,
        history: tuple[TranscriptEntry, ...] = (),
    ) -> None:
        previous = self.session
        await productivity_cli._finish_productivity_session(
            self.adapter,
            previous,
            self.runtime,
            consolidate=False,
            close_timeout_seconds=self.CLOSE_TIMEOUT_SECONDS,
        )
        self._queue_consolidation(previous)
        if reload_catalog:
            self.available_models, self.native_page = (
                await productivity_cli._load_productivity_catalog(
                    self.adapter,
                    next_session.provider,
                )
            )
        await self._adopt_session(
            next_session,
            message,
            update_project=update_project,
            history=history,
        )

    async def _adopt_session(
        self,
        session: AgentSession,
        message: str,
        *,
        update_project: bool = False,
        history: tuple[TranscriptEntry, ...] = (),
    ) -> None:
        self.session = session
        self.session_closed = False
        if update_project:
            self.runtime.update_current_project(session.project)
        self.runtime.update_current_thread_id(session.id)
        self.runtime.append_recent_threads(session.id, "productivity")
        self.context_usage = ContextWindowUsage()
        await productivity_cli._refresh_rate_limit_usage(
            self.adapter,
            session.id,
            self.context_usage,
        )
        await self._refresh_git()
        await self._clear_transcript()
        await self._append_history(history)
        await self._append_notice(message, tone="success")
        self._update_chrome()

    async def _show_working_diff(self) -> None:
        diff = await asyncio.to_thread(read_git_diff, self.session.project_path)
        if diff is None:
            await self._append_notice("Current directory is not a Git repository.", tone="error")
            return
        if not diff.strip():
            await self._append_notice("No tracked working-tree changes.")
            return
        await self._append_renderable(DiffBlock(diff, collapsed=False))

    async def _refresh_git(self) -> None:
        self.git_status = await asyncio.to_thread(
            inspect_git_status,
            self.session.project_path,
        )
        self._update_chrome()

    async def _append_git_status(self) -> None:
        status = self.git_status
        if status is None:
            await self._append_notice("Current directory is not a Git repository.")
            return
        changes = "\n".join(status.changes) if status.changes else "Working tree clean."
        await self._append_notice(
            f"{status.branch}  ·  {status.dirty_count} change(s)\n{changes}"
        )

    def _exit_immediately(self) -> None:
        """End the Textual app before provider and memory cleanup begins."""
        if self._productivity_exit_requested:
            return
        self._productivity_exit_requested = True
        self._queue_consolidation(self.session)
        self.session_closed = True
        self.exit()

    def _queue_consolidation(self, session: AgentSession) -> None:
        self._deferred_consolidations.append(
            (session.id, session.project, "productivity")
        )

    def _launch_deferred_consolidations(self) -> None:
        if self._consolidations_launched or not self._deferred_consolidations:
            return
        self._consolidations_launched = _launch_dream_agent_worker(
            self._deferred_consolidations,
            store=self.store,
        )

    def action_cancel_turn(self) -> None:
        if not self.busy:
            self.notify("No active turn.")
            return
        self.run_worker(
            self._cancel_active_turn(),
            name="cancel agent turn",
            group="cancel",
            exclusive=True,
            exit_on_error=False,
        )

    async def _cancel_active_turn(self) -> None:
        try:
            await self.adapter.cancel(self.session.id)
        finally:
            if self._active_worker is not None:
                self._active_worker.cancel()
        self.notify("Cancelling the active turn…", severity="warning")

    def action_request_quit(self) -> None:
        if self.busy:
            self.notify("Cancel the active turn before leaving.", severity="warning")
            return
        self._exit_immediately()

    def action_toggle_last_diff(self) -> None:
        blocks = list(self.query(DiffBlock))
        if not blocks:
            self._start_submission("/diff")
            return
        block = blocks[-1]
        block.collapsed = not block.collapsed
        block.scroll_visible(animate=False)

    def action_clear_transcript(self) -> None:
        if not self.busy:
            self.run_worker(
                self._clear_transcript(add_welcome=True),
                name="clear transcript",
                group="view",
                exclusive=True,
                exit_on_error=False,
            )

    async def _clear_transcript(self, *, add_welcome: bool = False) -> None:
        transcript = self.query_one("#transcript", VerticalScroll)
        await transcript.remove_children()
        self._reset_turn_widgets()
        if add_welcome:
            await self._append_welcome()

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
            "Agent is working…  Ctrl+C to cancel"
            if busy
            else "Enter to send  ·  / for commands  ·  Ctrl+C cancel  ·  Ctrl+D diff"
        )

    def _update_chrome(self) -> None:
        if not self.is_mounted:
            return
        top = Text()
        top.append("CLEO PRODUCTIVITY", style="bold #d4adff")
        top.append(f"   {self.session.provider.upper()}", style="bold #8fd7ff")
        workspace_name = Path(self.session.project_path).name or self.session.project
        top.append(f"   {workspace_name}", style="dim")
        self.query_one("#topbar", Static).update(top)

        status = Text()
        status.append(f"MODEL  {self.active_model}", style="bold #d4adff")
        status.append("    ")
        status.append(self._usage_status(), style="#bcb0ca")
        self.query_one("#statusbar", Static).update(status)

        session_text = Text()
        session_text.append("SESSION\n", style="bold #a787cf")
        session_text.append(f"{self.session.id}\n", style="#e9e5f0")
        session_text.append(f"native  {self.session.native_session_id or 'pending'}\n", style="dim")
        session_text.append(self.session.project_path, style="dim")
        self.query_one("#session-card", Static).update(session_text)

        options = productivity_cli._productivity_options(self.adapter, self.session.id)
        control_text = Text()
        control_text.append("CONTROLS\n", style="bold #a787cf")
        if options is None:
            control_text.append("provider defaults", style="dim")
        else:
            control_text.append(f"effort    {options.effort or 'default'}\n")
            control_text.append(f"access    {options.sandbox or 'default'}\n")
            control_text.append(f"approval  {options.approval_mode or 'default'}")
        self.query_one("#control-card", Static).update(control_text)

        git_text = Text()
        git_text.append("GIT\n", style="bold #a787cf")
        if self.git_status is None:
            git_text.append("not a repository", style="dim")
        else:
            git_text.append(self.git_status.branch, style="bold #8fd7ff")
            if self.git_status.ahead:
                git_text.append(f"  ↑{self.git_status.ahead}", style="green")
            if self.git_status.behind:
                git_text.append(f"  ↓{self.git_status.behind}", style="yellow")
            git_text.append(f"\n{self.git_status.dirty_count} change(s)", style="dim")
        self.query_one("#git-card", Static).update(git_text)

    def _usage_status(self) -> str:
        if self.context_usage.rate_limits_loaded:
            windows = {
                item.window_minutes: item
                for item in self.context_usage.rate_limit_windows
                if item.window_minutes is not None
            }
            labels: list[str] = []
            for minutes, label in ((300, "5H"), (10_080, "WEEK")):
                window = windows.get(minutes)
                if window is None:
                    labels.append(f"{label} n/a")
                    continue
                remaining = max(0, min(100 - window.used_percent, 100))
                reset = (
                    f" · {format_reset(window.resets_at)}"
                    if window.resets_at is not None
                    else ""
                )
                labels.append(f"{label} {remaining}% left{reset}")
            return "LIMITS  " + "    ".join(labels)
        if self.context_usage.used_tokens is None:
            return "CONTEXT  waiting"
        if self.context_usage.window_tokens:
            ratio = self.context_usage.ratio or 0
            return (
                f"CONTEXT  {self.context_usage.used_tokens:,} / "
                f"{self.context_usage.window_tokens:,}  {ratio:.0%}"
            )
        return f"CONTEXT  {self.context_usage.used_tokens:,} used"

    def _model_for(self, provider: str) -> str | None:
        return self.model_override or self.provider_models.get(provider)

    def _reset_turn_widgets(self) -> None:
        self._assistant_text = ""
        self._terminal_text = ""
        self._assistant_widget = None
        self._terminal_widget = None
        self._turn_diff = None

    async def _append_welcome(self) -> None:
        action = "return to Cleo chat" if self.return_to_chat else "exit"
        content = Markdown(
            "### Workspace ready\n"
            f"Connected to **{self.session.provider}** in `{self.session.project_path}`.\n\n"
            "Code changes arrive as collapsed, clickable diff cards. "
            f"Use `/back` to {action}, or `/help` for commands."
        )
        await self._append_renderable(content, classes="message welcome")

    async def _append_help(self) -> None:
        await self._append_renderable(
            Markdown(
                "### Commands\n"
                "- `/project` choose a project · `/cwd` location · `/git` status\n"
                "- `/diff` expand the working-tree diff\n"
                "- `/model`, `/effort`, `/access`, `/approval` runtime controls\n"
                "- `/new`, `/resume`, `/resume-native`, `/fork`, `/archive` sessions\n"
                "- `/sessions` click-to-resume · `/native`, `/account`, `/rename`, `/compact`\n"
                "- `/back` return to Cleo · `/quit` leave"
            ),
            classes="message event-message",
        )

    async def _append_user(self, message: str) -> None:
        text = Text()
        text.append("YOU\n", style="bold #8fd7ff")
        text.append(message)
        await self._append_renderable(text, classes="message user-message")

    async def _append_command(self, command: str) -> None:
        text = Text()
        text.append("COMMAND  ", style="bold #a787cf")
        text.append(command, style="dim")
        await self._append_renderable(text, classes="message event-message")

    async def _append_assistant(self, message: str) -> None:
        text = Text("CODEX\n", style="bold #83d697")
        widget = Static(classes="message assistant-message")
        await self._mount(widget)
        self._assistant_widget = widget
        self._assistant_text = message
        widget.update(Text.assemble(text, Text(message)))

    async def _stream_assistant(self, chunk: str) -> None:
        self._assistant_text += chunk
        if self._assistant_widget is None:
            self._assistant_widget = Static(classes="message assistant-message")
            await self._mount(self._assistant_widget)
        label = Text("CODEX\n", style="bold #83d697")
        self._assistant_widget.update(
            Text.assemble(label, Text(self._assistant_text))
        )
        self._scroll_end()

    async def _stream_terminal(self, chunk: str) -> None:
        self._terminal_text += chunk
        if self._terminal_widget is None:
            self._terminal_widget = Static(classes="message terminal-message")
            await self._mount(self._terminal_widget)
        label = Text("TERMINAL\n", style="bold #d7b66f")
        self._terminal_widget.update(
            Text.assemble(label, Text(self._terminal_text, style="dim"))
        )
        self._scroll_end()

    async def _upsert_turn_diff(self, diff: str) -> None:
        if self._turn_diff is None:
            self._turn_diff = DiffBlock(diff, collapsed=True)
            await self._mount(self._turn_diff)
        else:
            self._turn_diff.replace_diff(diff)
        self._scroll_end()

    async def _append_event(self, label: str, message: str, style: str) -> None:
        colors = {
            "yellow": "#d7b66f",
            "blue": "#8fd7ff",
            "magenta": "#d4adff",
            "red": "#ff8795",
            "green": "#83d697",
        }
        text = Text()
        text.append(f"{label:<9}", style=f"bold {colors.get(style, '#d4adff')}")
        text.append(message)
        classes = "message error-message" if style == "red" else "message event-message"
        await self._append_renderable(text, classes=classes)

    async def _append_turn_status(self, result: AgentResult) -> None:
        style = "#83d697" if result.status == "completed" else "#d7b66f"
        text = Text()
        text.append(result.status.upper(), style=f"bold {style}")
        text.append(f"   turn {result.turn_id}", style="dim")
        if result.error:
            text.append(f"\n{result.error}", style="#ff8795")
        await self._append_renderable(text, classes="message event-message")

    async def _append_notice(self, message: str, *, tone: str = "info") -> None:
        color = {
            "success": "#83d697",
            "warning": "#d7b66f",
            "error": "#ff8795",
            "info": "#a787cf",
        }[tone]
        text = Text()
        text.append("CLEO  ", style=f"bold {color}")
        text.append(message)
        classes = "message error-message" if tone == "error" else "message event-message"
        await self._append_renderable(text, classes=classes)

    async def _append_renderable(
        self,
        renderable: Any,
        *,
        classes: str | None = None,
    ) -> None:
        widget = (
            renderable
            if isinstance(renderable, DiffBlock)
            else Static(renderable, classes=classes)
        )
        await self._mount(widget)

    async def _mount(self, widget: Static | DiffBlock) -> None:
        transcript = self.query_one("#transcript", VerticalScroll)
        await transcript.mount(widget)
        self._scroll_end()

    def _scroll_end(self) -> None:
        self.query_one("#transcript", VerticalScroll).scroll_end(animate=False)


async def run_productivity_tui(
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
    """Run the interactive TUI and guarantee backend cleanup on abnormal exit."""
    app = ProductivityApp(
        adapter,
        session,
        runtime,
        store,
        model=model,
        provider_models=provider_models,
        return_to_chat=return_to_chat,
        restore_initial_history=restore_initial_history,
    )
    try:
        await app.run_async(mouse=True)
    finally:
        clear_terminal_after_tui()
        if not app.session_closed:
            await productivity_cli._finish_productivity_session(
                adapter,
                app.session,
                runtime,
                consolidate=False,
                close_timeout_seconds=app.CLOSE_TIMEOUT_SECONDS,
            )
            app._queue_consolidation(app.session)
            app.session_closed = True
        runtime.current_thread_id = None
        runtime.current_project = None
        try:
            runtime.update_runtime_json()
        except OSError:
            pass
        app._launch_deferred_consolidations()
