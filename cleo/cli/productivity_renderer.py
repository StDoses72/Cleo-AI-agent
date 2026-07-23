"""Rendering for normalized productivity harness events and token usage."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.harnesses import AgentEvent, AgentResult


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
