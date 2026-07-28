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
        """初始化共享终端上下文。

        参数:
            console: 可选 rich Console; 由 cleo/cli/context.py:5 以默认值创建
                全局单例 cli = CleoCLI() 时为 None, 内部自建 highlight 关闭的
                Console; 测试可注入自定义 Console。

        返回:
            None; 实例经 context.py 的模块级单例被 chat.py / productivity.py /
            application.py / lifecycle.py 共享使用。
        """
        self.console = console or Console(highlight=False)
        self._prompt_session: PromptSession[str] | None = None
        self._startup_rendered = False

    def clear(self) -> None:
        """清空终端屏幕。

        无参数, 无返回值; 由 cleo/cli/context.py 的 clear_screen() 代理,
        被 chat.py / productivity.py 在切换视图前调用。
        """
        self.console.clear()

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
        """读取一行用户输入; TTY 下走 prompt-toolkit(补全+历史+建议), 否则退回 console.input。

        参数:
            mode: "chat" 或 "productivity"; 由 chat.py:105 / productivity.py:186
                的 asyncio.to_thread 调用传入, 决定提示符颜色与补全命令集。
            cwd: 当前工作目录, 供 SlashCommandCompleter 补全 /cd 路径;
                productivity loop 传 session.project_path。
            sessions: 会话列表(补全 /resume 等); productivity loop 传
                store.list_sessions(space="productivity") 的结果。
            native_sessions / models: native 线程与模型列表, 来自
                _load_productivity_catalog, 供 /resume-native、/model 补全。
            projects: 已知项目名元组, 供 /project 补全。

        返回:
            str: 用户输入(已 strip); 由 chat.py / productivity loop 的调用方
            分发为 slash command 或发送给 agent。
        """
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
        """带黄色标签的单行输入(用于确认/表单式询问)。

        参数:
            label: 提示标签; 由 application.py:213 ("resume [y/n]") 与
                chat.py:427 ("file") 等调用点传入。

        返回:
            str: 用户输入(已 strip); 由调用方继续解析(如 lower() 后判断 y/n)。
        """
        marker = Text(label, style="bold yellow")
        marker.append(" ❯ ", style="yellow")
        return self.console.input(marker).strip()

    def wait_for_return(self) -> None:
        """阻塞等待用户按 Enter(查看只读视图后返回)。

        无参数, 无返回值; 由 chat.py:376 与 productivity.py:423/442 经
        asyncio.to_thread 在展示 session hub / native thread 后调用。
        """
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
            session: 当前 AgentSession; 由 productivity.py 的
                render_active_header 闭包或 _run_productivity_mode 单条消息分支传入。
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
        """渲染 controls 面板: 左侧 effort/access/approval, 右侧 git 分支与变更数。

        参数:
            options: SessionOptions 或 None(provider defaults); 来自
                productivity.py 的 _productivity_options。
            git_status: GitStatus 或 None(非 git 仓库); 来自
                cleo/integrations/git.py 的 inspect_git_status。

        返回:
            None; 输出写入 console。被 render_productivity_header 及
            productivity loop 的 render_active_controls 调用。
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

    def render_session_hub(self, sessions: list[dict[str, Any]]) -> None:
        """渲染跨 space 的会话总表(SESSION HUB)。

        参数:
            sessions: 会话行字典列表; 由 chat.py:375 传 store.list_sessions(),
                或 productivity.py:435 传 merge_session_rows(store + native) 的结果。

        返回:
            None; 输出写入 console, 之后调用方用 wait_for_return 暂停查看。
        """
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
        """渲染单个项目下的 chat 线程列表(带当前线程标记与项目导航)。

        参数:
            project: 项目名; 由 chat.py:212 的 /project 分支传入。
            sessions: 该项目的会话字典列表(store.list_sessions 过滤结果)。
            current_thread_id: 当前线程 id, 用于打 ● 标记。
            known_projects: 全部已知项目名, 用于底部导航提示。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        """渲染 native 线程的只读视图(元数据 + 按时间顺序的消息/工具调用)。

        参数:
            detail: NativeSessionDetail; 由 productivity.py:422 的 /native 分支
                经 adapter.read_native_session 获取后传入。

        返回:
            None; 输出写入 console, 之后调用方用 wait_for_return 暂停查看。
        """
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
        """渲染 provider 支持的模型表(含默认/支持的 effort 档位)。

        参数:
            models: HarnessModel 元组; 由 productivity.py:237 的 /model 分支传
                _load_productivity_catalog 加载的 available_models。
            active: 当前激活的模型 id(active_model), 用于打 ● 标记。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        """渲染 harness 账号信息(类型/邮箱/套餐), 未认证时显示警告。

        参数:
            account: HarnessAccount; 由 productivity.py:452 的 /account 分支
                经 adapter.account_status 获取后传入。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        """渲染 git 仓库状态(根目录/分支/变更列表), 非仓库时显示警告。

        参数:
            status: GitStatus 或 None; 由 productivity.py 的 /project、/git 分支
                经 inspect_git_status(session.project_path) 获取后传入。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        """渲染恢复线程时回放的历史消息(User/Assistant 分 Panel 展示)。

        参数:
            thread_id: 恢复的线程 id; 由 chat.py:513 在 /resume 成功后传入。
            messages: (role, content) 列表, 由 chat.py 从消息记录构建。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
        """渲染本轮消息附带的附件文件名列表(空列表时不输出)。

        参数:
            names: 附件名列表; 由 chat.py:103 从用户输入解析出的
                attachment_list 构建后传入。

        返回:
            None; 输出写入 console, 供终端用户阅读。
        """
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
