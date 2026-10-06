from __future__ import annotations

import asyncio

import pytest

from cleo.desktop.commands import CHAT, PRODUCTIVITY, Command, CommandContext, CommandRegistry
from cleo.desktop.service import CHAT_COMMANDS, PRODUCTIVITY_COMMANDS


@pytest.mark.parametrize(("registry", "listed"), [(CHAT, CHAT_COMMANDS),
                                                  (PRODUCTIVITY, PRODUCTIVITY_COMMANDS)])
def test_every_advertised_command_is_registered(registry, listed) -> None:
    advertised = {entry.split()[0] for entry in listed} - {"/computeruse"}
    # /computeruse is expanded before commands run; /exit is a hidden alias of /quit.
    assert set(registry.names()) == advertised | {"/exit"}


def test_commands_that_need_an_argument_are_unknown_without_one() -> None:
    with pytest.raises(ValueError, match="^未知对话命令：/resume。输入 /help 查看命令。$"):
        CHAT.resolve("/resume", "")
    with pytest.raises(ValueError, match="^未知开发命令：/nope。"):
        PRODUCTIVITY.resolve("/nope", "x")
    assert PRODUCTIVITY.resolve("/exit", "") is PRODUCTIVITY.resolve("/quit", "")
    assert PRODUCTIVITY.resolve("/access", "") is PRODUCTIVITY.resolve("/effort", "")


def test_registry_runs_the_handler_with_the_context_and_rejects_duplicates() -> None:
    seen = []

    async def handler(context):
        seen.append((context.command, context.argument))

    registry = CommandRegistry([Command(("/a", "/b"), handler)], unknown="? {command}")
    asyncio.run(registry.run(CommandContext(None, {}, "/b", "x", None)))
    assert seen == [("/b", "x")]
    with pytest.raises(ValueError, match="duplicate command: /a"):
        CommandRegistry([Command(("/a",), handler), Command(("/a",), handler)], unknown="")
