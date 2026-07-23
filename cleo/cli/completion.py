"""Mode-aware slash-command, path, project, model, and session completion."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from prompt_toolkit.completion import Completer, Completion, PathCompleter
from prompt_toolkit.document import Document

if TYPE_CHECKING:
    from cleo.harnesses import HarnessModel, NativeSession

CLIMode = Literal["chat", "productivity"]

CHAT_COMMANDS = {
    "/productivity": "open the productivity workspace",
    "/project": "show or create/switch a Cleo project",
    "/rename": "rename the current Cleo thread",
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
        projects: tuple[str, ...] = (),
    ) -> None:
        self.mode = mode
        self.commands = (
            PRODUCTIVITY_COMMANDS if mode == "productivity" else CHAT_COMMANDS
        )
        self.sessions = sessions or []
        self.native_sessions = native_sessions
        self.models = models
        self.projects = projects
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
                                str(session.get("title") or ""),
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

        if command == "/project":
            if argument.startswith("move "):
                project_prefix = argument.removeprefix("move ")
                for project in self.projects:
                    if project.startswith(project_prefix):
                        yield Completion(
                            project,
                            start_position=-len(project_prefix),
                            display_meta="move current thread",
                        )
                return
            if "move".startswith(argument):
                yield Completion(
                    "move ",
                    start_position=-len(argument),
                    display_meta="move current thread to a project",
                )

        choices = {
            "/project": self.projects,
            "/model": tuple(model.id for model in self.models),
            "/effort": ("none", "minimal", "low", "medium", "high", "xhigh"),
            "/access": ("read-only", "workspace-write", "full-access"),
            "/approval": ("deny_all", "auto_review"),
        }.get(command, ())
        for choice in choices:
            if choice.startswith(argument):
                yield Completion(choice, start_position=-len(argument))
