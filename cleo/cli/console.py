"""Compact Rich presentation for one-shot Cleo and productivity commands."""

from __future__ import annotations

from contextlib import AbstractContextManager
from typing import TYPE_CHECKING

from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.status import Status
from rich.table import Table
from rich.text import Text

from cleo.cli.productivity_renderer import ProductivityEventRenderer, _render_runtime_status
from cleo.images.portrait import render_startup_art
from cleo.images.startup import build_startup_image, startup_image_height
from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.harnesses import (
        AgentSession,
        SessionOptions,
    )
    from cleo.integrations.git import GitStatus

class CleoCLI:
    """Shared Rich output used outside the full-screen Textual interfaces."""

    def __init__(self, console: Console | None = None) -> None:
        """初始化共享终端上下文。

        参数:
            console: 可选 rich Console; 由 cleo/cli/context.py:5 以默认值创建
                全局单例 cli = CleoCLI() 时为 None, 内部自建 highlight 关闭的
                Console; 测试可注入自定义 Console。

        返回:
            None; 实例经 context.py 的模块级单例被 one-shot chat、one-shot
            productivity、application 与 lifecycle 共享使用。
        """
        self.console = console or Console(highlight=False)
        self._startup_rendered = False

    def render_startup_splash(
        self,
        thread_id: str,
        project: str,
        *,
        model: str = "unknown",
    ) -> None:
        """Show Cleo's terminal portrait once per interactive process.

        每个交互进程只渲染一次启动画面; 非 TTY 或终端太窄/无色彩时静默跳过。
        优先使用 iTerm2/kitty 内联图片, 不支持时退回 ASCII art 布局。

        参数:
            thread_id: 当前线程 id; 由 cleo/cli/chat.py:91 在启动时传入。
            project: 当前项目名; 同上, 来自 chat 入口的运行时状态。
            model: 当前模型名; 同上, 缺省 "unknown"。

        返回:
            None; 输出直接写入 console, 供终端用户阅读。
        """

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
        """构建启动画面内嵌的状态 grid(memory/project/thread/model 四格)。

        参数:
            thread_id / project / model: 由 render_startup_splash 透传,
                源自 chat.py 启动入口的运行时状态。

        返回:
            Table: rich grid; 仅被 render_startup_splash 放入 Panel 渲染。
        """
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

    def render_chat_header(
        self,
        thread_id: str,
        project: str,
        *,
        model: str = "unknown",
        context_usage: ContextWindowUsage | None = None,
    ) -> None:
        """渲染 chat 模式头部(品牌行 + runtime status + 可用 slash command 提示)。

        参数:
            thread_id / project / model / context_usage: 由 chat.py:34 在启动与
                /new 等场景传入, 源自 runtime 当前线程与 token 统计。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        """渲染 productivity 模式头部(品牌行 + runtime status + controls + 会话明细)。

        参数:
            session: 当前 AgentSession; 由 one-shot productivity 分支传入。
            model / context_usage: active_model 与共享 token 统计, 由调用方传入。
            options: _productivity_options 的结果(SessionOptions 或 None)。
            git_status: inspect_git_status(session.project_path) 的结果。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        self.console.print()

    def render_productivity_controls(
        self,
        options: SessionOptions | None,
        git_status: GitStatus | None,
    ) -> None:
        """渲染 controls 面板: 左侧 effort/access/approval, 右侧 git 分支与变更数。

        参数:
            options: SessionOptions 或 None(provider defaults); 来自
                productivity.py 的 _productivity_options。
            git_status: GitStatus 或 None(非 git 仓库); 来自
                cleo/integrations/git.py 的 inspect_git_status。

        返回:
            None; 输出写入 console。仅供 non-interactive productivity header 使用。
        """
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
