"""Rendering for normalized productivity harness events and token usage."""

from __future__ import annotations

import time
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
        """初始化 renderer 状态。

        参数:
            console: rich Console, 由 CleoCLI.productivity_renderer() (console.py:549) 传入
                共享的终端 console。
            model: 当前模型名, 由调用方(CleoCLI.productivity_renderer 的调用方,
                即 productivity.py 的 _prompt_productivity_session)传入的 active model。
            context_usage: 可选的共享 ContextWindowUsage; 若提供则与原对象共享,
                token 统计会回写到该对象供 productivity loop 的 header 复用。
        """
        self.console = console
        self.model = model
        self.context_usage = context_usage or ContextWindowUsage()
        self.assistant_streamed = False
        self.terminal_streamed = False

    def __call__(self, event: AgentEvent) -> None:
        """渲染单个归一化 harness event(作为 EventCallback 被 adapter 调用)。

        本方法使实例满足 EventCallback 协议: 由
        cleo/harnesses/adapter.py 的 AgentAdapter.prompt 在流式收到
        provider 事件时逐个调用(经 productivity.py:35 的 on_event=renderer 传入)。

        参数:
            event: AgentAdapter 归一化后的 AgentEvent; 先交给
                _capture_context_usage 统计 token, 再按 event.type 分流为
                流式输出(assistant/terminal chunk)或单行摘要(_event_summary)。

        返回:
            None; 输出直接写入 self.console(rich), 不向上游返回值。
        """
        self._capture_context_usage(event)
        if event.type == "file_change" and event.data.get("provider_event_type") in {
            "item/fileChange/outputDelta",
            "item/fileChange/patchUpdated",
        }:
            return
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
        """turn 结束后收尾: 补换行、渲染最终状态与 runtime status 面板。

        参数:
            result: AgentAdapter.prompt 返回的 AgentResult, 由
                productivity.py 的 _prompt_productivity_session 在 await 完成后传入
                (productivity.py:36)。

        返回:
            None; 输出(状态行 + _render_runtime_status 面板)直接写入 console,
            供终端用户阅读。
        """
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
        """从 tokenUsage 事件 payload 中提取 token 统计并写入 self.context_usage。

        参数:
            event: 由 __call__ 传入的归一化 AgentEvent; 仅当
                data["provider_event_type"] == "thread/tokenUsage/updated" 时处理。

        返回:
            None; 结果写入 self.context_usage(可能是与 productivity loop 共享的
            ContextWindowUsage 实例), 供 finish()/header 渲染 context 占用。
        """
        capture_context_usage(event, self.context_usage)

    @staticmethod
    def _token_int(payload: dict[str, Any], *keys: str) -> int | None:
        """在 payload 中按候选 key 顺序取第一个 int 类型的 token 数值。

        参数:
            payload: tokenUsage 的子字典(total/last/顶层), 来自 _capture_context_usage。
            keys: 兼容 camelCase 与 snake_case 的候选字段名。

        返回:
            int | None: 匹配到的 token 数; 全部缺失时返回 None,
            由 _capture_context_usage 传给 ContextWindowUsage.update 表示该字段未知。
        """
        for key in keys:
            value = payload.get(key)
            if isinstance(value, int):
                return value
        return None

    def _ensure_newline(self) -> None:
        """若上一次输出是未换行的流式 chunk, 先补一个换行, 并重置 assistant 流状态。

        无参数, 无返回值; 仅被 __call__ 内部在输出非流式摘要前调用。
        """
        if self.assistant_streamed or self.terminal_streamed:
            self.console.print()
        self.assistant_streamed = False

    def _start_line(self, label: str, style: str) -> None:
        """在行首打印固定宽度的标签前缀(不换行), 供后续流式文本衔接。

        参数:
            label: 标签文本(如 "CODEX"/"TERM"), 由 __call__ 内部传入。
            style: rich style 名称("green"/"yellow"), 由 __call__ 内部传入。

        返回:
            None; 输出写入 console, 后续 chunk 以 end="" 续接在同一行。
        """
        self.console.print(Text(f"{label:<8}", style=f"bold {style}"), end="")

    def _render_event(self, label: str, message: str, style: str) -> None:
        """以 "LABEL   message" 形式渲染一整行事件摘要并换行。

        参数:
            label/message/style: 由 __call__ 从 _event_summary 的返回元组解包传入。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
        line = Text()
        line.append(f"{label:<8}", style=f"bold {style}")
        line.append(message)
        self.console.print(line, soft_wrap=True)

    @classmethod
    def _event_summary(cls, event: AgentEvent) -> tuple[str, str, str] | None:
        """把非流式 AgentEvent 归约为 (label, message, style) 单行摘要。

        参数:
            event: 由 __call__ 传入的归一化 AgentEvent; 覆盖 tool_call /
                tool_result / plan_update / file_change / error 等类型。

        返回:
            tuple[str, str, str] | None: (标签, 消息, rich style); 无需展示的
            事件返回 None, 由 __call__ 解包后交给 _render_event 渲染。
        """
        payload = cls._payload(event)
        item = payload.get("item")
        item = item if isinstance(item, dict) else {}
        if event.type == "tool_call":
            source = item or payload
            command = source.get("command")
            if command:
                return "TOOL", str(command), "yellow"
            server = source.get("server")
            tool = source.get("tool") or source.get("name")
            name = f"{server or 'tool'}/{tool or source.get('type', 'unknown')}"
            return "TOOL", name, "yellow"
        if event.type == "tool_result":
            source = item or payload
            return "RESULT", str(source.get("status") or "completed"), "yellow"
        if event.type == "thought" and event.text:
            return "THOUGHT", event.text, "blue"
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
            if event.data.get("provider_event_type") == "turn/diff/updated":
                diff = event.text or payload.get("diff")
                return "DIFF", cls._diff_summary(diff), "magenta"
            return "FILE", cls._file_change_summary(item, payload), "magenta"
        if event.type == "error":
            return "ERROR", event.text or "Provider reported an error", "red"
        return None

    @staticmethod
    def _payload(event: AgentEvent) -> dict[str, Any]:
        """取出事件的 payload 字典(data["payload"] 缺失时退回 data 本身)。

        参数:
            event: 归一化 AgentEvent, 由 _capture_context_usage / _event_summary 传入。

        返回:
            dict[str, Any]: 事件 payload; 被 _event_summary / _capture_context_usage
            用于读取 item、tokenUsage、diff 等字段。
        """
        payload = event.data.get("payload")
        return payload if isinstance(payload, dict) else event.data

    @staticmethod
    def _file_change_summary(item: dict[str, Any], payload: dict[str, Any]) -> str:
        """为 file_change 事件生成简短描述(变更数或 diff 首行)。

        参数:
            item: 事件 item 字典, 由 _event_summary 从 payload 提取后传入。
            payload: 事件 payload 字典, 由 _event_summary 传入, 用于兜底读取 diff。

        返回:
            str: 摘要文本, 作为 _event_summary 返回元组的 message 字段被渲染。
        """
        changes = item.get("changes")
        if isinstance(changes, list):
            return f"{len(changes)} change(s)"
        diff = payload.get("diff")
        if isinstance(diff, str) and diff:
            first_line = diff.splitlines()[0]
            return first_line[:120]
        return "updated"

    @staticmethod
    def _diff_summary(diff: Any) -> str:
        """Collapse a unified diff into file and line counts for scrollback."""
        if not isinstance(diff, str) or not diff:
            return "updated · /diff to expand"
        lines = diff.splitlines()
        files = sum(line.startswith("diff --git ") for line in lines)
        additions = sum(
            line.startswith("+") and not line.startswith("+++") for line in lines
        )
        deletions = sum(
            line.startswith("-") and not line.startswith("---") for line in lines
        )
        file_label = f"{files} file(s)" if files else "working tree"
        return f"{file_label} · +{additions} -{deletions} · /diff to expand"


def capture_context_usage(event: AgentEvent, usage: ContextWindowUsage) -> None:
    """Project a token-usage event into shared runtime usage state."""
    if event.data.get("provider_event_type") != "thread/tokenUsage/updated":
        return
    payload = ProductivityEventRenderer._payload(event)
    token_usage = payload.get("tokenUsage")
    if not isinstance(token_usage, dict):
        return
    total = token_usage.get("total")
    last = token_usage.get("last")
    total = total if isinstance(total, dict) else {}
    last = last if isinstance(last, dict) else {}
    token_int = ProductivityEventRenderer._token_int
    usage.update(
        used_tokens=token_int(total, "totalTokens", "total_tokens"),
        window_tokens=token_int(
            token_usage,
            "modelContextWindow",
            "model_context_window",
        ),
        input_tokens=token_int(last, "inputTokens", "input_tokens"),
        output_tokens=token_int(last, "outputTokens", "output_tokens"),
        cached_input_tokens=token_int(
            last,
            "cachedInputTokens",
            "cached_input_tokens",
        ),
    )


def event_payload(event: AgentEvent) -> dict[str, Any]:
    """Return the normalized payload carried by a harness event."""
    return ProductivityEventRenderer._payload(event)


def summarize_productivity_event(
    event: AgentEvent,
) -> tuple[str, str, str] | None:
    """Return the canonical label, message, and color for a harness event."""
    return ProductivityEventRenderer._event_summary(event)


def summarize_diff(diff: Any) -> str:
    """Return compact file/addition/deletion counts for a unified diff."""
    return ProductivityEventRenderer._diff_summary(diff)


def _render_runtime_status(
    console: Console,
    *,
    model: str,
    context_usage: ContextWindowUsage | None,
    accent: str,
) -> None:
    """渲染一行 model + context 占用的状态面板(Panel 内含进度点与百分比)。

    参数:
        console: rich Console; 由 ProductivityEventRenderer.finish 传入自身 console,
            或由 CleoCLI.render_runtime_status (console.py:562) 传入共享 console。
        model: 当前模型名; 来自 finish 的 self.model 或 console.py 调用方的
            active_model。
        context_usage: token 统计; 为 None 时以空 ContextWindowUsage 兜底,
            显示 "waiting"。
        accent: rich 强调色("cyan"/"magenta"), 由调用方按 chat/productivity
            上下文传入。

    返回:
        None; 输出直接写入 console, 供终端用户阅读。
    """
    usage = context_usage or ContextWindowUsage()
    status = Table.grid(expand=True)
    status.add_column(ratio=1, overflow="ellipsis")
    status.add_column(justify="right", no_wrap=True)

    model_text = Text("MODEL  ", style="dim")
    model_text.append(model or "unknown", style=f"bold {accent}")

    if usage.rate_limits_loaded:
        context_text = _rate_limit_text(usage, accent)
    else:
        context_text = Text("CONTEXT  ", style="dim")
        if usage.used_tokens is None:
            context_text.append("waiting", style="dim")
            if usage.window_tokens:
                context_text.append(
                    f" / {_format_tokens(usage.window_tokens)}", style="dim"
                )
        elif usage.window_tokens:
            ratio = usage.ratio or 0.0
            filled = round(ratio * 10)
            context_text.append(
                f"{_format_tokens(usage.used_tokens)} / "
                f"{_format_tokens(usage.window_tokens)} ",
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


def _rate_limit_text(usage: ContextWindowUsage, accent: str) -> Text:
    """Render remaining five-hour and weekly account limits."""
    output = Text("LIMITS  ", style="dim")
    windows = {
        window.window_minutes: window
        for window in usage.rate_limit_windows
        if window.window_minutes is not None
    }
    for index, (minutes, label) in enumerate(((300, "5H"), (10_080, "WEEK"))):
        if index:
            output.append("  ·  ", style="dim")
        output.append(f"{label} ", style="dim")
        window = windows.get(minutes)
        if window is None:
            output.append("n/a", style="dim")
            continue
        remaining = max(0, min(100 - window.used_percent, 100))
        output.append(f"{remaining}% left", style=f"bold {accent}")
        if window.resets_at is not None:
            output.append(f" · resets {_format_reset(window.resets_at)}", style="dim")
    return output


def _format_reset(resets_at: int) -> str:
    """Format a Unix reset timestamp as a compact relative duration."""
    remaining = max(0, resets_at - int(time.time()))
    days, remainder = divmod(remaining, 86_400)
    hours, remainder = divmod(remainder, 3_600)
    minutes = remainder // 60
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{max(1, minutes)}m"


def format_reset(resets_at: int) -> str:
    """Public reset-time formatter shared by Rich and Textual views."""
    return _format_reset(resets_at)


def _format_tokens(value: int) -> str:
    """把 token 数格式化为紧凑字符串(如 12.3k / 1.2m)。

    参数:
        value: token 数量, 来自 _render_runtime_status 读取的
            ContextWindowUsage 各字段。

    返回:
        str: 格式化文本, 由 _render_runtime_status 拼入状态面板。
    """
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}m"
    if value >= 1_000:
        return f"{value / 1_000:.1f}k"
    return str(value)
