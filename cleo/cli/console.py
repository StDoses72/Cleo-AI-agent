"""Rich terminal presentation for Cleo chat, productivity, and session views."""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Any

from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.styles import Style
from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.status import Status
from rich.table import Table
from rich.text import Text

from cleo.cli.completion import CLIMode, SlashCommandCompleter
from cleo.cli.productivity_renderer import ProductivityEventRenderer, _render_runtime_status
from cleo.images.portrait import render_startup_art
from cleo.images.startup import build_startup_image, startup_image_height
from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.harnesses import (
        AgentSession,
        HarnessAccount,
        HarnessModel,
        NativeSession,
        NativeSessionDetail,
        SessionOptions,
    )
    from cleo.integrations.git import GitStatus

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


class CleoCLI:
    """Terminal input and rendering for chat, productivity, and session views."""

    def __init__(self, console: Console | None = None) -> None:
        self.console = console or Console(highlight=False)
        self._prompt_session: PromptSession[str] | None = None
        self._startup_rendered = False

    def clear(self) -> None:
        self.console.clear()

    def render_startup_splash(
        self,
        thread_id: str,
        project: str,
        *,
        model: str = "unknown",
    ) -> None:
        """Show Cleo's terminal portrait once per interactive process."""

        if self._startup_rendered or not self.console.is_terminal:
            return
        self._startup_rendered = True

        terminal_width = self.console.size.width
        if self.console.color_system is None or terminal_width < 52:
            return

        terminal_image = build_startup_image(
            height=startup_image_height(self.console.size.height)
        )
        if terminal_image is not None:
            self.console.print(
                Rule(
                    Text(" CLEO // COLD START ", style="bold #43dff5"),
                    style="#1689a8",
                )
            )
            self.console.print(terminal_image)
            self.console.print(
                Panel(
                    self._startup_status(thread_id, project, model),
                    subtitle=Text(
                        " cognition online · memory linked ",
                        style="#6372a4",
                    ),
                    border_style="#1689a8",
                    padding=(0, 1),
                )
            )
            self.console.print()
            return

        show_details = terminal_width >= 88
        compact = terminal_width < 116
        portrait = render_startup_art(compact=compact)
        content: Text | Table = portrait

        if show_details:
            details = Text()
            details.append("C L E O\n", style="bold #43dff5")
            details.append("LOCAL-FIRST PERSONAL AGENT\n", style="bold white")
            details.append("cold start / cognition online", style="dim")
            details.append("\n\n")
            details.append("●  memory      ", style="bold #43dff5")
            details.append("linked\n", style="green")
            details.append("●  project     ", style="bold #43dff5")
            details.append(f"{project}\n", style="white")
            details.append("●  thread      ", style="bold #43dff5")
            details.append(f"{self._short_id(thread_id, width=20)}\n", style="white")
            details.append("●  model       ", style="bold #43dff5")
            details.append(self._short_id(model, width=24), style="white")
            details.append("\n\n")
            details.append("Ready before you asked.", style="italic #8796b5")

            layout = Table.grid(expand=True, padding=(0, 1))
            layout.add_column(width=48 if compact else 74, no_wrap=True)
            layout.add_column(ratio=1, overflow="fold")
            layout.add_row(portrait, details)
            content = layout

        title = Text(" CLEO // COLD START ", style="bold #43dff5")
        subtitle = Text(" cognition online · memory linked ", style="#6372a4")
        self.console.print(
            Panel(
                content,
                title=title,
                subtitle=subtitle,
                border_style="#1689a8",
                padding=(0, 1),
            )
        )
        self.console.print()

    def _startup_status(self, thread_id: str, project: str, model: str) -> Table:
        status = Table.grid(expand=True, padding=(0, 2))
        memory = Text.assemble(
            ("●  MEMORY  ", "bold #43dff5"),
            ("linked", "green"),
        )
        project_status = Text.assemble(
            ("●  PROJECT  ", "bold #43dff5"),
            (project, "white"),
        )
        thread = Text.assemble(
            ("●  THREAD  ", "bold #43dff5"),
            (self._short_id(thread_id, width=18), "white"),
        )
        model_status = Text.assemble(
            ("●  MODEL  ", "bold #43dff5"),
            (self._short_id(model, width=24), "white"),
        )
        if self.console.size.width < 88:
            status.add_column(ratio=1, overflow="ellipsis", no_wrap=True)
            status.add_column(ratio=1, overflow="ellipsis", no_wrap=True)
            status.add_row(memory, project_status)
            status.add_row(thread, model_status)
        else:
            status.add_column(ratio=2, overflow="ellipsis", no_wrap=True)
            status.add_column(ratio=2, overflow="ellipsis", no_wrap=True)
            status.add_column(ratio=3, overflow="ellipsis", no_wrap=True)
            status.add_column(ratio=2, overflow="ellipsis", no_wrap=True)
            status.add_row(memory, project_status, thread, model_status)
        return status

    def prompt(
        self,
        mode: CLIMode = "chat",
        *,
        cwd: str | None = None,
        sessions: list[dict[str, Any]] | None = None,
        native_sessions: tuple[NativeSession, ...] = (),
        models: tuple[HarnessModel, ...] = (),
        projects: tuple[str, ...] = (),
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
                    projects=projects,
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
                ("/project", "bold cyan"),
                (" memory  ", "dim"),
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

    def render_project_sessions(
        self,
        project: str,
        sessions: list[dict[str, Any]],
        *,
        current_thread_id: str,
        known_projects: tuple[str, ...] = (),
    ) -> None:
        self._render_header(
            brand="CLEO PROJECT",
            breadcrumb=f"non-productivity / {project}",
            state=f"{len(sessions)} thread(s)",
            accent="cyan",
        )
        table = Table(box=box.SIMPLE_HEAVY, expand=True, show_edge=False)
        table.add_column("", width=1, no_wrap=True)
        table.add_column("Thread", ratio=2, overflow="ellipsis", no_wrap=True)
        table.add_column("Title", ratio=4, overflow="ellipsis")
        table.add_column("Status", ratio=1, overflow="ellipsis")
        table.add_column("Updated", justify="right", no_wrap=True)
        for session in sessions:
            session_id = str(session.get("id") or "unknown")
            status = str(session.get("status") or "unknown")
            table.add_row(
                Text("●", style="cyan") if session_id == current_thread_id else "",
                self._short_id(session_id, width=24),
                str(session.get("title") or "Untitled"),
                Text(status, style=self._status_style(status)),
                self._short_timestamp(str(session.get("updated_at") or "")),
            )
        self.console.print(table)
        if known_projects:
            self.console.print(
                Text.assemble(
                    ("Projects  ", "dim"),
                    (" · ".join(known_projects), "cyan"),
                )
            )

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
