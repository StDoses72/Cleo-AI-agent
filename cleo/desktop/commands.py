"""Slash commands typed into a chat or development-task composer.

Each space has a ``CommandRegistry``: one ``Command`` per command name (aliases share an
entry), so adding a command is one table row instead of another ``elif``. Handlers receive
a ``CommandContext`` and use the desktop service's public behaviour (creating threads,
emitting notices, updating runtime options) through it.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from cleo.desktop.projection import changes_from_diff, path_name, project_id
from cleo.integrations.git import inspect_git_status, read_git_diff
from cleo.integrations.workspace import resolve_productivity_cwd

Emit = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class CommandContext:
    service: Any
    manifest: dict[str, Any]
    command: str
    argument: str
    emit: Emit
    # Development tasks only: the live harness session and the adapter that owns it.
    session: Any = None
    adapter: Any = None


Handler = Callable[[CommandContext], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class Command:
    names: tuple[str, ...]
    handler: Handler
    # Without an argument the command is treated as unknown, as before.
    needs_argument: bool = False


class CommandRegistry:
    def __init__(self, commands: Iterable[Command], *, unknown: str) -> None:
        self._commands: dict[str, Command] = {}
        for command in commands:
            for name in command.names:
                if name in self._commands:
                    raise ValueError(f"duplicate command: {name}")
                self._commands[name] = command
        self._unknown = unknown

    def names(self) -> tuple[str, ...]:
        return tuple(self._commands)

    def resolve(self, name: str, argument: str) -> Command:
        """Purpose: Find the command. Raises ValueError for unknown or incomplete commands."""
        command = self._commands.get(name)
        if command is None or (command.needs_argument and not argument):
            raise ValueError(self._unknown.format(command=name))
        return command

    async def run(self, context: CommandContext) -> None:
        await self.resolve(context.command, context.argument).handler(context)


def _refresh(context: CommandContext, thread_id: str, space: str) -> Awaitable[None]:
    return context.emit({"type": "refresh", "activeThreadId": thread_id, "space": space})


# Chat ------------------------------------------------------------------------------------

async def _chat_help(context: CommandContext) -> None:
    await context.service._notice(
        context.emit,
        "Cleo 对话命令",
        "/new · /project [name] · /project move <name> · /sessions · "
        "/resume <id> · /rename <title> · /attach · /computeruse <操作需求> · "
        "/productivity · /quit",
    )


async def _chat_new(context: CommandContext) -> None:
    thread = await context.service.create_thread(
        space="chat", project_id_value=project_id("non_productivity", context.manifest["project"])
    )
    await _refresh(context, thread["id"], "chat")


async def _chat_project(context: CommandContext) -> None:
    service, manifest, argument, emit = (
        context.service, context.manifest, context.argument, context.emit,
    )
    if argument.startswith("move "):
        target = argument.removeprefix("move ").strip()
        moved = service.store.move_session(manifest["id"], target)
        await service._notice(
            emit, "项目已迁移", f"当前对话已移动到 {moved['project']}。", "success"
        )
        await _refresh(context, manifest["id"], "chat")
    elif argument:
        thread = await service.create_thread(
            space="chat", project_id_value=project_id("non_productivity", argument)
        )
        await _refresh(context, thread["id"], "chat")
    else:
        await service._notice(
            emit, "记忆项目", " · ".join(service.runtime.projects_for("non_productivity"))
        )


async def _chat_sessions(context: CommandContext) -> None:
    await context.service._session_list("non_productivity", context.emit)


async def _chat_resume(context: CommandContext) -> None:
    target = context.service.store.load_manifest(context.argument)
    if target["space"] != "non_productivity":
        raise ValueError("目标不是 Cleo 对话 session。")
    await _refresh(context, context.argument, "chat")


async def _chat_rename(context: CommandContext) -> None:
    context.service.store.rename_session(context.manifest["id"], context.argument)
    await context.service._notice(context.emit, "已重命名", context.argument, "success")
    await _refresh(context, context.manifest["id"], "chat")


async def _chat_attach(context: CommandContext) -> None:
    await context.emit({"type": "request-attachment"})


async def _chat_productivity(context: CommandContext) -> None:
    await context.emit({"type": "navigate-space", "space": "productivity"})


async def _chat_quit(context: CommandContext) -> None:
    await context.service._notice(
        context.emit, "桌面应用保持运行", "可以直接关闭窗口，Cleo 会在退出时整理记忆。"
    )


CHAT = CommandRegistry([
    Command(("/help",), _chat_help),
    Command(("/new",), _chat_new),
    Command(("/project",), _chat_project),
    Command(("/sessions",), _chat_sessions),
    Command(("/resume",), _chat_resume, needs_argument=True),
    Command(("/rename",), _chat_rename, needs_argument=True),
    Command(("/attach",), _chat_attach),
    Command(("/productivity",), _chat_productivity),
    Command(("/quit", "/exit"), _chat_quit),
], unknown="未知对话命令：{command}。输入 /help 查看命令。")


# Development tasks -----------------------------------------------------------------------

async def _task_help(context: CommandContext) -> None:
    await context.service._notice(
        context.emit,
        "开发任务命令",
        "/new · /cwd · /project · /git · /diff · /model · /effort · "
        "/access · /approval · /cd · /resume · /resume-native · /native · "
        "/sessions · /account · /fork · /rename · /compact · /archive · /back · /quit",
    )


async def _task_new(context: CommandContext) -> None:
    thread = await context.service.create_thread(
        space="productivity",
        project_id_value=project_id("productivity", context.manifest["project"]),
        provider=context.manifest["provider"],
    )
    await _refresh(context, thread["id"], "productivity")


async def _task_cwd(context: CommandContext) -> None:
    await context.service._notice(
        context.emit, "工作目录",
        str(context.manifest.get("cwd") or context.session.project_path),
    )


async def _task_project(context: CommandContext) -> None:
    await context.service._notice(context.emit, "项目", str(context.manifest["project"]))


async def _task_git(context: CommandContext) -> None:
    status = await asyncio.to_thread(inspect_git_status, context.session.project_path)
    detail = (
        "当前目录不是 Git 仓库。"
        if status is None
        else f"{status.branch} · {status.dirty_count} 个变更\n" + "\n".join(status.changes)
    )
    await context.service._notice(context.emit, "Git 状态", detail)


async def _task_diff(context: CommandContext) -> None:
    diff = await asyncio.to_thread(read_git_diff, context.session.project_path)
    await context.emit({"type": "changes", "changes": changes_from_diff(diff)})
    await context.service._notice(context.emit, "工作区差异", "已刷新右侧变更面板。", "success")


async def _task_model(context: CommandContext) -> None:
    service, manifest, argument, emit = (
        context.service, context.manifest, context.argument, context.emit,
    )
    if argument:
        async with service._runtime_lock(manifest["id"]):
            runtime = await service._update_runtime(
                thread_id=manifest["id"], update={"model": argument}, command=True,
            )
        await emit({"type": "runtime", "runtime": runtime})
        await service._notice(emit, "模型已更新", argument, "success")
    else:
        models = await context.adapter.list_models(
            manifest["provider"], context.session.project_path,
        )
        await service._notice(
            emit,
            "可用模型",
            "\n".join(f"{model.id} — {model.display_name}" for model in models),
        )


_OPTION_FIELDS = {"/effort": "effort", "/access": "sandbox", "/approval": "approval_mode"}


async def _task_option(context: CommandContext) -> None:
    service, manifest, argument, emit = (
        context.service, context.manifest, context.argument, context.emit,
    )
    field = _OPTION_FIELDS[context.command]
    if not argument:
        options = context.adapter.session_options(manifest["id"])
        await service._notice(
            emit,
            context.command.removeprefix("/").title(),
            str(getattr(options, field) or "default"),
        )
    else:
        ui_field = {"sandbox": "access", "approval_mode": "approval"}.get(field, field)
        async with service._runtime_lock(manifest["id"]):
            runtime = await service._update_runtime(
                thread_id=manifest["id"], update={ui_field: argument}, command=True,
            )
        await emit({"type": "runtime", "runtime": runtime})
        await service._notice(emit, "运行参数已更新", f"{field} = {argument}", "success")


async def _task_cd(context: CommandContext) -> None:
    manifest = context.manifest
    target = resolve_productivity_cwd(context.argument, context.session.project_path)
    next_session = await context.adapter.create_session(
        manifest["provider"],
        project_path=target,
        project=path_name(target, manifest["project"]),
    )
    context.service._productivity_sessions[next_session.id] = next_session
    await _refresh(context, next_session.id, "productivity")


async def _task_resume(context: CommandContext) -> None:
    target = context.service.store.load_manifest(context.argument)
    await context.service._ensure_productivity_session(target)
    await _refresh(context, context.argument, "productivity")


async def _task_resume_native(context: CommandContext) -> None:
    resumed = await context.adapter.resume_session(
        context.manifest["provider"],
        context.argument,
        project_path=context.session.project_path,
        project=context.manifest["project"],
    )
    context.service._productivity_sessions[resumed.id] = resumed
    await _refresh(context, resumed.id, "productivity")


async def _task_native(context: CommandContext) -> None:
    detail = await context.adapter.read_native_session(
        context.manifest["provider"], context.argument,
    )
    await context.service._notice(
        context.emit,
        detail.session.name or detail.session.id,
        json.dumps(list(detail.turns), ensure_ascii=False, indent=2)[:12_000],
    )


async def _task_sessions(context: CommandContext) -> None:
    await context.service._session_list("productivity", context.emit)


async def _task_account(context: CommandContext) -> None:
    provider = context.manifest["provider"]
    account = await context.adapter.account_status(provider)
    await context.service._notice(
        context.emit,
        f"{provider} 账号",
        f"authenticated: {account.authenticated}\n"
        f"type: {account.account_type or '—'}\n"
        f"email: {account.email or '—'}\n"
        f"plan: {account.plan or '—'}",
    )


async def _task_fork(context: CommandContext) -> None:
    forked = await context.adapter.fork_session(context.manifest["id"])
    context.service._productivity_sessions[forked.id] = forked
    await _refresh(context, forked.id, "productivity")


async def _task_rename(context: CommandContext) -> None:
    await context.adapter.rename_session(context.manifest["id"], context.argument)
    await context.service._notice(context.emit, "已重命名", context.argument, "success")
    await _refresh(context, context.manifest["id"], "productivity")


async def _task_compact(context: CommandContext) -> None:
    await context.adapter.compact_session(context.manifest["id"])
    await context.service._notice(
        context.emit, "上下文整理已启动", "Provider 原生上下文正在压缩。", "success",
    )


async def _task_archive(context: CommandContext) -> None:
    await context.adapter.archive_session(context.manifest["id"])
    await _task_new(context)


async def _task_back(context: CommandContext) -> None:
    await context.emit({"type": "navigate-space", "space": "chat"})


async def _task_quit(context: CommandContext) -> None:
    await context.service._notice(context.emit, "桌面应用保持运行", "可以切换空间或直接关闭窗口。")


PRODUCTIVITY = CommandRegistry([
    Command(("/help",), _task_help),
    Command(("/new",), _task_new),
    Command(("/cwd",), _task_cwd),
    Command(("/project",), _task_project),
    Command(("/git",), _task_git),
    Command(("/diff",), _task_diff),
    Command(("/model",), _task_model),
    Command(("/effort", "/access", "/approval"), _task_option),
    Command(("/cd",), _task_cd),
    Command(("/resume",), _task_resume, needs_argument=True),
    Command(("/resume-native",), _task_resume_native, needs_argument=True),
    Command(("/native",), _task_native, needs_argument=True),
    Command(("/sessions",), _task_sessions),
    Command(("/account",), _task_account),
    Command(("/fork",), _task_fork),
    Command(("/rename",), _task_rename, needs_argument=True),
    Command(("/compact",), _task_compact),
    Command(("/archive",), _task_archive),
    Command(("/back",), _task_back),
    Command(("/quit", "/exit"), _task_quit),
], unknown="未知开发命令：{command}。输入 /help 查看命令。")
