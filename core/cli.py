"""Rich terminal presentation for Cleo chat, productivity, and session views."""

from __future__ import annotations

from contextlib import AbstractContextManager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import Completer, Completion, PathCompleter
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.styles import Style
from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.status import Status
from rich.table import Table
from rich.text import Text

from core.usage import ContextWindowUsage

if TYPE_CHECKING:
    from core.git_status import GitStatus
    from core.integrations.agent_adapter import (
        AgentEvent,
        AgentResult,
        AgentSession,
        HarnessAccount,
        HarnessModel,
        NativeSession,
        NativeSessionDetail,
        SessionOptions,
    )

CLIMode = Literal["chat", "productivity"]

CHAT_COMMANDS = {
    "/productivity": "open the productivity workspace",
    "/resume": "resume a saved Cleo thread",
    "/sessions": "show saved sessions",
    "/new": "start a new Cleo thread",
    "/attach": "attach an image",
    "/quit": "exit Cleo",
    "/exit": "exit Cleo",
}

PRODUCTIVITY_COMMANDS = {
    "/project": "show project, repository, and working tree",
    "/git": "show Git status",
    "/cd": "switch working directory and start a new session",
    "/cwd": "show the current working directory",
    "/resume": "resume a saved productivity session",
    "/resume-native": "attach and resume a native harness thread",
    "/native": "inspect a native harness thread",
    "/sessions": "show Cleo and native sessions",
    "/model": "show or change the model",
    "/effort": "show or change reasoning effort",
    "/access": "show or change filesystem access",
    "/approval": "show or change approval behavior",
    "/account": "show harness account status",
    "/fork": "fork the current native thread",
    "/rename": "rename the current native thread",
    "/compact": "compact the current native context",
    "/archive": "archive the current native thread",
    "/new": "start a new harness session",
    "/back": "return to Cleo chat",
    "/quit": "leave productivity mode",
    "/exit": "leave productivity mode",
}

_PROMPT_STYLE = Style.from_dict(
    {
        "chat-prompt": "bold ansicyan",
        "productivity-prompt": "bold ansimagenta",
        "completion-menu.completion": "bg:#202020 #dddddd",
        "completion-menu.completion.current": "bg:#875f87 #ffffff bold",
        "completion-menu.meta.completion": "bg:#202020 #888888",
        "completion-menu.meta.completion.current": "bg:#875f87 #ffffff",
    }
)


class SlashCommandCompleter(Completer):
    """Complete mode-specific slash commands, directories, and saved sessions."""

    def __init__(
        self,
        mode: CLIMode,
        *,
        cwd: str | None = None,
        sessions: list[dict[str, Any]] | None = None,
        native_sessions: tuple[NativeSession, ...] = (),
        models: tuple[HarnessModel, ...] = (),
    ) -> None:
        self.mode = mode
        self.commands = (
            PRODUCTIVITY_COMMANDS if mode == "productivity" else CHAT_COMMANDS
        )
        self.sessions = sessions or []
        self.native_sessions = native_sessions
        self.models = models
        base_path = str(Path(cwd).expanduser()) if cwd else None
        self.path_completer = PathCompleter(
            only_directories=True,
            expanduser=True,
            get_paths=(lambda: [base_path]) if base_path else None,
        )

    def get_completions(self, document: Document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return

        if " " not in text:
            for command, description in self.commands.items():
                if command.startswith(text):
                    yield Completion(
                        command,
                        start_position=-len(text),
                        display_meta=description,
                    )
            return

        command, argument = text.split(" ", 1)
        if command == "/cd":
            argument_document = Document(argument, cursor_position=len(argument))
            yield from self.path_completer.get_completions(
                argument_document,
                complete_event,
            )
            return

        if command == "/resume":
            for session in self.sessions:
                session_id = str(session.get("id") or "")
                if not session_id:
                    continue
                if self.mode == "productivity" and not session.get(
                    "native_session_id"
                ):
                    continue
                if self.mode == "chat" and session.get("provider") != "cleo":
                    continue
                if session_id.startswith(argument):
                    meta = " / ".join(
                        filter(
                            None,
                            (
                                str(session.get("project") or ""),
                                str(session.get("provider") or ""),
                                str(session.get("status") or ""),
                            ),
                        )
                    )
                    yield Completion(
                        session_id,
                        start_position=-len(argument),
                        display_meta=meta,
                    )
            return

        if command in {"/native", "/resume-native"}:
            for session in self.native_sessions:
                if session.id.startswith(argument):
                    yield Completion(
                        session.id,
                        start_position=-len(argument),
                        display_meta=session.name or session.preview or session.cwd,
                    )
            return

        choices = {
            "/model": tuple(model.id for model in self.models),
            "/effort": ("none", "minimal", "low", "medium", "high", "xhigh"),
            "/access": ("read-only", "workspace-write", "full-access"),
            "/approval": ("deny_all", "auto_review"),
        }.get(command, ())
        for choice in choices:
            if choice.startswith(argument):
                yield Completion(choice, start_position=-len(argument))


class CleoCLI:
    """Terminal input and rendering for chat, productivity, and session views."""

    def __init__(self, console: Console | None = None) -> None:
        self.console = console or Console(highlight=False)
        self._prompt_session: PromptSession[str] | None = None

    def clear(self) -> None:
        self.console.clear()

    def prompt(
        self,
        mode: CLIMode = "chat",
        *,
        cwd: str | None = None,
        sessions: list[dict[str, Any]] | None = None,
        native_sessions: tuple[NativeSession, ...] = (),
        models: tuple[HarnessModel, ...] = (),
    ) -> str:
        label = "productivity" if mode == "productivity" else "cleo"
        style = "bold magenta" if mode == "productivity" else "bold cyan"
        if self.console.is_terminal:
            if self._prompt_session is None:
                self._prompt_session = PromptSession(history=InMemoryHistory())
            prompt_style = (
                "class:productivity-prompt"
                if mode == "productivity"
                else "class:chat-prompt"
            )
            marker = FormattedText([(prompt_style, f"{label} ❯ ")])
            return self._prompt_session.prompt(
                marker,
                completer=SlashCommandCompleter(
                    mode,
                    cwd=cwd,
                    sessions=sessions,
                    native_sessions=native_sessions,
                    models=models,
                ),
                complete_while_typing=False,
                auto_suggest=AutoSuggestFromHistory(),
                style=_PROMPT_STYLE,
            ).strip()

        marker = Text()
        marker.append(label, style=style)
        marker.append(" ❯ ", style=style)
        return self.console.input(marker).strip()

    def field_prompt(self, label: str) -> str:
        marker = Text(label, style="bold yellow")
        marker.append(" ❯ ", style="yellow")
        return self.console.input(marker).strip()

    def wait_for_return(self) -> None:
        prompt = Text("Press Enter to return", style="dim")
        prompt.append("  ↵ ", style="cyan")
        self.console.input(prompt)

    def render_chat_header(
        self,
        thread_id: str,
        project: str,
        *,
        model: str = "unknown",
        context_usage: ContextWindowUsage | None = None,
    ) -> None:
        self._render_header(
            brand="CLEO",
            breadcrumb=f"non-productivity / {project} / {self._short_id(thread_id)}",
            state="ready",
            accent="cyan",
        )
        self.render_runtime_status(model, context_usage, accent="cyan")
        self.console.print(
            Text.assemble(
                ("/productivity", "bold cyan"),
                (" workspace  ", "dim"),
                ("/resume", "bold cyan"),
                (" thread  ", "dim"),
                ("/sessions", "bold cyan"),
                (" history  ", "dim"),
                ("/new", "bold cyan"),
                (" thread  ", "dim"),
                ("/quit", "bold cyan"),
                (" exit", "dim"),
            )
        )
        self.console.print()

    def render_productivity_header(
        self,
        session: AgentSession,
        *,
        model: str = "unknown",
        context_usage: ContextWindowUsage | None = None,
        options: SessionOptions | None = None,
        git_status: GitStatus | None = None,
    ) -> None:
        self._render_header(
            brand=f"PRODUCTIVITY · {session.provider.upper()}",
            breadcrumb=f"productivity / {session.project} / {self._short_id(session.id)}",
            state="connected",
            accent="magenta",
        )
        self.render_runtime_status(model, context_usage, accent="magenta")
        self.render_productivity_controls(options, git_status)
        details = Table.grid(expand=True, padding=(0, 1))
        details.add_column(style="dim", no_wrap=True)
        details.add_column(ratio=1, overflow="fold")
        details.add_row("provider", session.provider)
        details.add_row("native", session.native_session_id or "pending")
        details.add_row("cwd", session.project_path)
        self.console.print(details)
        self.console.print(
            Text.assemble(
                ("/cd", "bold magenta"),
                (" cwd  ", "dim"),
                ("/model", "bold magenta"),
                (" model  ", "dim"),
                ("/effort", "bold magenta"),
                (" think  ", "dim"),
                ("/access", "bold magenta"),
                (" access  ", "dim"),
                ("/resume", "bold magenta"),
                (" session  ", "dim"),
                ("/new", "bold magenta"),
                (" session  ", "dim"),
                ("/sessions", "bold magenta"),
                (" history  ", "dim"),
                ("/back", "bold magenta"),
                (" chat  ", "dim"),
                ("/quit", "bold magenta"),
                (" leave", "dim"),
            )
        )
        self.console.print()

    def render_productivity_controls(
        self,
        options: SessionOptions | None,
        git_status: GitStatus | None,
    ) -> None:
        controls = Table.grid(expand=True)
        controls.add_column(ratio=1, overflow="ellipsis")
        controls.add_column(ratio=1, overflow="ellipsis")
        option_text = Text("CONTROL  ", style="dim")
        if options is None:
            option_text.append("provider defaults", style="dim")
        else:
            option_text.append(options.effort or "default effort", style="magenta")
            option_text.append(" · ", style="dim")
            option_text.append(options.sandbox or "default access", style="magenta")
            option_text.append(" · ", style="dim")
            option_text.append(options.approval_mode or "default approval", style="magenta")

        git_text = Text("GIT  ", style="dim")
        if git_status is None:
            git_text.append("not a repository", style="dim")
        else:
            git_text.append(git_status.branch, style="bold blue")
            if git_status.ahead:
                git_text.append(f" ↑{git_status.ahead}", style="green")
            if git_status.behind:
                git_text.append(f" ↓{git_status.behind}", style="yellow")
            git_text.append(
                f" · {git_status.dirty_count} change(s)",
                style="yellow" if git_status.dirty_count else "dim",
            )
        controls.add_row(option_text, git_text)
        self.console.print(Panel(controls, border_style="magenta", padding=(0, 1)))

    def render_session_hub(self, sessions: list[dict[str, Any]]) -> None:
        self._render_header(
            brand="SESSION HUB",
            breadcrumb="all spaces / all projects",
            state=f"{len(sessions)} indexed",
            accent="blue",
        )
        table = Table(box=box.SIMPLE_HEAVY, expand=True, show_edge=False)
        table.add_column("Session", ratio=2, overflow="ellipsis", no_wrap=True)
        table.add_column("Title", ratio=3, overflow="ellipsis")
        table.add_column("Origin", ratio=1, overflow="ellipsis")
        table.add_column("Space", ratio=2, overflow="ellipsis")
        table.add_column("Project", ratio=1, overflow="ellipsis")
        table.add_column("Provider", ratio=1, overflow="ellipsis")
        table.add_column("Status", ratio=1, overflow="ellipsis")
        table.add_column("Updated", justify="right", no_wrap=True)
        for session in sessions:
            space = str(session.get("space") or "unknown")
            space_style = "magenta" if space == "productivity" else "cyan"
            status = str(session.get("status") or "unknown")
            table.add_row(
                self._short_id(str(session.get("id") or "unknown"), width=22),
                str(session.get("title") or "—"),
                str(session.get("origin") or "cleo"),
                Text(space, style=space_style),
                str(session.get("project") or "general"),
                str(session.get("provider") or "unknown"),
                Text(status, style=self._status_style(status)),
                self._short_timestamp(str(session.get("updated_at") or "")),
            )
        if sessions:
            self.console.print(table)
        else:
            self.console.print(Panel("No sessions have been recorded yet.", border_style="dim"))

    def render_native_session(self, detail: NativeSessionDetail) -> None:
        session = detail.session
        self._render_header(
            brand="NATIVE THREAD",
            breadcrumb=session.name or self._short_id(session.id, width=32),
            state=session.status,
            accent="magenta",
        )
        metadata = Table.grid(expand=True, padding=(0, 1))
        metadata.add_column(style="dim", no_wrap=True)
        metadata.add_column(ratio=1, overflow="fold")
        metadata.add_row("id", session.id)
        metadata.add_row("source", session.source)
        metadata.add_row("cwd", session.cwd)
        metadata.add_row("preview", session.preview or "—")
        self.console.print(metadata)
        self.console.print()

        shown = 0
        for turn in detail.turns:
            for item in turn.get("items", []):
                if not isinstance(item, dict):
                    continue
                item = item.get("root") if isinstance(item.get("root"), dict) else item
                item_type = item.get("type")
                if item_type == "userMessage":
                    content = self._native_user_text(item.get("content"))
                    if content:
                        self.console.print(
                            Panel(Text(content), title="User", border_style="cyan")
                        )
                        shown += 1
                elif item_type == "agentMessage" and item.get("text"):
                    self.console.print(
                        Panel(
                            Text(str(item["text"])),
                            title="Codex",
                            border_style="green",
                        )
                    )
                    shown += 1
                elif item_type == "contextCompaction":
                    self.info("Codex compacted the native context here.")
                elif item_type == "commandExecution" and item.get("command"):
                    self.console.print(
                        Text.assemble(
                            ("TOOL    ", "bold yellow"),
                            (str(item["command"]), "dim"),
                        )
                    )
        if shown == 0:
            self.warning("No user/assistant messages were returned for this thread.")

    def render_models(
        self,
        models: tuple[HarnessModel, ...],
        *,
        active: str | None,
    ) -> None:
        table = Table(box=box.SIMPLE_HEAVY, expand=True, show_edge=False)
        table.add_column("Model", ratio=2)
        table.add_column("Default effort", ratio=1)
        table.add_column("Supported efforts", ratio=3)
        for model in models:
            marker = "● " if model.id == active else "  "
            table.add_row(
                Text(marker + model.id, style="bold magenta" if marker.strip() else None),
                model.default_effort or "—",
                ", ".join(model.supported_efforts),
            )
        self.console.print(table)

    def render_account(self, account: HarnessAccount) -> None:
        if not account.authenticated:
            self.warning("Codex is not authenticated.")
            return
        parts = [account.account_type or "authenticated"]
        if account.email:
            parts.append(account.email)
        if account.plan:
            parts.append(account.plan)
        self.info(" · ".join(parts))

    def render_git_status(self, status: GitStatus | None) -> None:
        if status is None:
            self.warning("The current working directory is not inside a Git repository.")
            return
        self.info(f"{status.repo_root} · {status.branch}")
        if not status.changes:
            self.success("Working tree clean.")
            return
        for change in status.changes:
            self.console.print(Text(change, style="yellow"))

    def render_restored_messages(
        self,
        thread_id: str,
        messages: list[tuple[str, str]],
    ) -> None:
        self.console.print(
            Text.assemble(
                ("RESTORED", "bold cyan"),
                (f"  {self._short_id(thread_id, width=24)}", "dim"),
                (f"  ·  {len(messages)} messages", "dim"),
            )
        )
        for role, content in messages:
            style = "cyan" if role == "User" else "green"
            self.console.print(Panel(Text(content), title=role, border_style=style))

    def render_attachments(self, names: list[str]) -> None:
        if not names:
            return
        line = Text("ATTACHMENTS  ", style="bold yellow")
        line.append(" · ".join(names), style="dim")
        self.console.print(line)

    def begin_assistant(self) -> None:
        self.console.print(Text("CLEO", style="bold green"), end=" ")

    def stream_assistant(self, text: str) -> None:
        self.console.print(Text(text), end="", soft_wrap=True)

    def end_assistant(self, *, received: bool = True) -> None:
        if not received:
            self.console.print(Text("(No assistant response returned.)", style="dim"), end="")
        self.console.print()

    def productivity_renderer(
        self,
        *,
        model: str = "unknown",
        context_usage: ContextWindowUsage | None = None,
    ) -> ProductivityEventRenderer:
        return ProductivityEventRenderer(
            self.console,
            model=model,
            context_usage=context_usage,
        )

    def render_runtime_status(
        self,
        model: str,
        context_usage: ContextWindowUsage | None,
        *,
        accent: str,
    ) -> None:
        _render_runtime_status(
            self.console,
            model=model,
            context_usage=context_usage,
            accent=accent,
        )

    def info(self, message: str) -> None:
        self._notice("INFO", message, "cyan")

    def success(self, message: str) -> None:
        self._notice("DONE", message, "green")

    def warning(self, message: str) -> None:
        self._notice("WARN", message, "yellow")

    def error(self, message: str) -> None:
        self._notice("ERROR", message, "bold red")

    def status(self, message: str) -> AbstractContextManager[Status]:
        return self.console.status(message, spinner="dots")

    def _render_header(
        self,
        *,
        brand: str,
        breadcrumb: str,
        state: str,
        accent: str,
    ) -> None:
        bar = Table.grid(expand=True)
        bar.add_column(no_wrap=True)
        bar.add_column(ratio=1, overflow="ellipsis")
        bar.add_column(justify="right", no_wrap=True)
        brand_text = Text(f" {brand} ", style=f"bold {accent}")
        crumb_text = Text(f"  {breadcrumb}", style="dim")
        state_text = Text.assemble(("● ", accent), (state, "dim"))
        bar.add_row(brand_text, crumb_text, state_text)
        self.console.print(Panel(bar, border_style=accent, padding=(0, 1)))

    def _notice(self, label: str, message: str, style: str) -> None:
        line = Text()
        line.append(f"{label:<7}", style=style)
        line.append(message)
        self.console.print(line)

    @staticmethod
    def _short_id(value: str, width: int = 18) -> str:
        return value if len(value) <= width else f"{value[: width - 1]}…"

    @staticmethod
    def _short_timestamp(value: str) -> str:
        if not value:
            return "—"
        return value.replace("T", " ")[:16]

    @staticmethod
    def _status_style(status: str) -> str:
        return {
            "active": "cyan",
            "running": "magenta",
            "completed": "green",
            "failed": "red",
            "cancelled": "yellow",
        }.get(status, "dim")

    @staticmethod
    def _native_user_text(content: Any) -> str:
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            item = item.get("root") if isinstance(item.get("root"), dict) else item
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
        return "\n".join(parts)


class ProductivityEventRenderer:
    """Render one normalized harness event stream without knowing provider SDK types."""

    def __init__(
        self,
        console: Console,
        *,
        model: str = "unknown",
        context_usage: ContextWindowUsage | None = None,
    ) -> None:
        self.console = console
        self.model = model
        self.context_usage = context_usage or ContextWindowUsage()
        self.assistant_streamed = False
        self.terminal_streamed = False

    def __call__(self, event: AgentEvent) -> None:
        self._capture_context_usage(event)
        if event.type == "assistant_message_chunk" and event.text:
            if not self.assistant_streamed:
                self._start_line("CODEX", "green")
            self.assistant_streamed = True
            self.terminal_streamed = False
            self.console.print(Text(event.text), end="", soft_wrap=True)
            return

        if event.type == "terminal_output" and event.text:
            if not self.terminal_streamed:
                self._ensure_newline()
                self._start_line("TERM", "yellow")
            self.terminal_streamed = True
            self.console.print(Text(event.text, style="dim"), end="", soft_wrap=True)
            return

        summary = self._event_summary(event)
        if summary is None:
            return
        self._ensure_newline()
        label, message, style = summary
        self._render_event(label, message, style)
        self.terminal_streamed = False

    def finish(self, result: AgentResult) -> None:
        if self.assistant_streamed or self.terminal_streamed:
            self.console.print()
        elif result.response:
            self._render_event("CODEX", result.response, "green")

        status_style = "green" if result.status == "completed" else "yellow"
        status = Text()
        status.append(f"{result.status.upper():<10}", style=f"bold {status_style}")
        status.append(f"turn {result.turn_id}", style="dim")
        if result.error:
            status.append(f"  ·  {result.error}", style="red")
        self.console.print(status)
        _render_runtime_status(
            self.console,
            model=self.model,
            context_usage=self.context_usage,
            accent="magenta",
        )

    def _capture_context_usage(self, event: AgentEvent) -> None:
        if event.data.get("provider_event_type") != "thread/tokenUsage/updated":
            return
        payload = self._payload(event)
        token_usage = payload.get("tokenUsage")
        if not isinstance(token_usage, dict):
            return
        total = token_usage.get("total")
        last = token_usage.get("last")
        total = total if isinstance(total, dict) else {}
        last = last if isinstance(last, dict) else {}
        self.context_usage.update(
            used_tokens=self._token_int(total, "totalTokens", "total_tokens"),
            window_tokens=self._token_int(
                token_usage,
                "modelContextWindow",
                "model_context_window",
            ),
            input_tokens=self._token_int(last, "inputTokens", "input_tokens"),
            output_tokens=self._token_int(last, "outputTokens", "output_tokens"),
            cached_input_tokens=self._token_int(
                last,
                "cachedInputTokens",
                "cached_input_tokens",
            ),
        )

    @staticmethod
    def _token_int(payload: dict[str, Any], *keys: str) -> int | None:
        for key in keys:
            value = payload.get(key)
            if isinstance(value, int):
                return value
        return None

    def _ensure_newline(self) -> None:
        if self.assistant_streamed or self.terminal_streamed:
            self.console.print()
        self.assistant_streamed = False

    def _start_line(self, label: str, style: str) -> None:
        self.console.print(Text(f"{label:<8}", style=f"bold {style}"), end="")

    def _render_event(self, label: str, message: str, style: str) -> None:
        line = Text()
        line.append(f"{label:<8}", style=f"bold {style}")
        line.append(message)
        self.console.print(line, soft_wrap=True)

    @classmethod
    def _event_summary(cls, event: AgentEvent) -> tuple[str, str, str] | None:
        payload = cls._payload(event)
        item = payload.get("item")
        item = item if isinstance(item, dict) else {}
        if event.type == "tool_call":
            command = item.get("command")
            if command:
                return "TOOL", str(command), "yellow"
            server = item.get("server")
            tool = item.get("tool")
            name = f"{server or 'tool'}/{tool or item.get('type', 'unknown')}"
            return "TOOL", name, "yellow"
        if event.type == "tool_result":
            return "RESULT", str(item.get("status") or "completed"), "yellow"
        if event.type == "plan_update":
            plan = payload.get("plan")
            if isinstance(plan, list):
                steps = [
                    str(step.get("step"))
                    for step in plan
                    if isinstance(step, dict) and step.get("step")
                ]
                if steps:
                    return "PLAN", " → ".join(steps), "blue"
            return "PLAN", "updated", "blue"
        if event.type == "file_change":
            message = event.text or cls._file_change_summary(item, payload)
            return "FILE", message, "magenta"
        if event.type == "error":
            return "ERROR", event.text or "Provider reported an error", "red"
        return None

    @staticmethod
    def _payload(event: AgentEvent) -> dict[str, Any]:
        payload = event.data.get("payload")
        return payload if isinstance(payload, dict) else event.data

    @staticmethod
    def _file_change_summary(item: dict[str, Any], payload: dict[str, Any]) -> str:
        changes = item.get("changes")
        if isinstance(changes, list):
            return f"{len(changes)} change(s)"
        diff = payload.get("diff")
        if isinstance(diff, str) and diff:
            first_line = diff.splitlines()[0]
            return first_line[:120]
        return "updated"


def _render_runtime_status(
    console: Console,
    *,
    model: str,
    context_usage: ContextWindowUsage | None,
    accent: str,
) -> None:
    usage = context_usage or ContextWindowUsage()
    status = Table.grid(expand=True)
    status.add_column(ratio=1, overflow="ellipsis")
    status.add_column(justify="right", no_wrap=True)

    model_text = Text("MODEL  ", style="dim")
    model_text.append(model or "unknown", style=f"bold {accent}")

    context_text = Text("CONTEXT  ", style="dim")
    if usage.used_tokens is None:
        context_text.append("waiting", style="dim")
        if usage.window_tokens:
            context_text.append(f" / {_format_tokens(usage.window_tokens)}", style="dim")
    elif usage.window_tokens:
        ratio = usage.ratio or 0.0
        filled = round(ratio * 10)
        context_text.append(
            f"{_format_tokens(usage.used_tokens)} / {_format_tokens(usage.window_tokens)} ",
            style=accent,
        )
        context_text.append("●" * filled, style=f"bold {accent}")
        context_text.append("·" * (10 - filled), style="dim")
        context_text.append(f" {ratio:.0%}", style="dim")
    else:
        context_text.append(f"{_format_tokens(usage.used_tokens)} used", style=accent)

    if usage.input_tokens is not None or usage.output_tokens is not None:
        context_text.append(
            f"  in {_format_tokens(usage.input_tokens or 0)}"
            f" · out {_format_tokens(usage.output_tokens or 0)}",
            style="dim",
        )
    status.add_row(model_text, context_text)
    console.print(Panel(status, border_style=accent, padding=(0, 1)))


def _format_tokens(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}m"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)
