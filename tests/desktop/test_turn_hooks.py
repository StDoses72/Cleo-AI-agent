from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from cleo.desktop.turn_hooks import (
    ComputerUseHook,
    EvolutionPolicy,
    SkillExpander,
    TurnRequest,
    timed_reply,
)

MANIFEST = {"id": "t", "space": "productivity", "project": "p"}


async def _emit(_event):
    return None


def test_evolution_tasks_only_accept_commands_that_keep_the_managed_session() -> None:
    policy = EvolutionPolicy(lambda manifest: manifest.get("evolution", False))
    evolution = {**MANIFEST, "evolution": True}
    policy.check(TurnRequest(evolution, "/model gpt", _emit))
    policy.check(TurnRequest(evolution, "plain request", _emit))
    policy.check(TurnRequest(MANIFEST, "/cd ..", _emit))
    with pytest.raises(ValueError, match="进化任务不能切换"):
        policy.check(TurnRequest(evolution, "/cd ..", _emit))


def test_computer_use_rewrites_the_prompt_or_handles_the_turn() -> None:
    async def expand(_manifest, prompt, _emit):
        return None if prompt == "/computeruse" else "use the computer tools: " + prompt

    hook = ComputerUseHook(expand)
    plain = TurnRequest(MANIFEST, "hello", _emit)
    assert asyncio.run(hook.prepare(plain)) and plain.prompt == "hello"
    assert plain.display_prompt is None

    task = TurnRequest(MANIFEST, "/computeruse  open the browser", _emit)
    assert asyncio.run(hook.prepare(task))
    assert task.display_prompt == "Computer use：open the browser"
    assert task.prompt == "use the computer tools: /computeruse  open the browser"

    empty = TurnRequest(MANIFEST, "/computeruse", _emit)
    assert asyncio.run(hook.prepare(empty)) is False


def test_skills_expand_only_their_own_command() -> None:
    skill = SimpleNamespace(command="/review", expand=lambda prompt: "Review: " + prompt)
    hook = SkillExpander(lambda _manifest: [skill])
    matched = TurnRequest(MANIFEST, "/review src", _emit)
    other = TurnRequest(MANIFEST, "/help", _emit)
    asyncio.run(hook.prepare(matched))
    asyncio.run(hook.prepare(other))
    assert matched.prompt == "Review: /review src" and other.prompt == "/help"


def test_timed_reply_records_phases_and_forwards_every_event(monkeypatch) -> None:
    calls = []

    class Timing:
        summary: dict = {}

        def phase(self, name):
            calls.append(("phase", name))

        def start(self, name, *, category):
            calls.append(("start", name, category))
            return name

        def end(self, token, status="completed"):
            calls.append(("end", token, status))

    @asynccontextmanager
    async def measure(memory_dir, **kwargs):
        calls.append(("measure", memory_dir, kwargs["session_id"], kwargs["kind"]))
        yield Timing()

    monkeypatch.setattr("cleo.runtime.timing.measure", measure)
    forwarded = []

    async def forward(event):
        forwarded.append(event["type"])

    events = [
        {"type": "turn-started", "item": {"id": "turn-1"}},
        {"type": "upsert-item", "item": {"id": "tool-1", "type": "tool", "name": "read",
                                         "status": "running"}},
        {"type": "upsert-item", "item": {"id": "tool-1", "type": "tool", "name": "read",
                                         "status": "error"}},
        {"type": "approval-request", "request": {"id": "a1"}},
        {"type": "approval-resolved", "response": {"id": "a1"}},
        {"type": "done"},
    ]

    async def scenario():
        async with timed_reply("memory", MANIFEST, _emit, forward) as timed_event:
            for event in events:
                await timed_event(event)

    asyncio.run(scenario())
    assert forwarded == [event["type"] for event in events]
    assert calls == [
        ("measure", "memory", "t", "reply"),
        ("phase", "准备上下文与任务"),
        ("start", "read", "tool"),
        ("end", "read", "failed"),
        ("start", "等待审批", "wait"),
        ("end", "等待审批", "completed"),
    ]
