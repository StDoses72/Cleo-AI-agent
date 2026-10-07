"""Steps around a turn that are not part of running the agent itself.

``stream_turn`` runs every ``TurnHook`` in two phases:

- ``check`` before the run is reserved; a hook rejects a turn by raising (evolution policy);
- ``prepare`` after the thread is activated; a hook may rewrite the prompt (``/computeruse``,
  local skills) or report that it handled the turn by returning False.

``timed_reply`` wraps each agent run with the reply timing record and observes its events.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

Emit = Callable[[dict[str, Any]], Awaitable[None]]

# Evolution tasks run in a managed workspace with fixed permissions; only commands that
# cannot change the directory, the task or the permissions are allowed there.
EVOLUTION_COMMANDS = frozenset({
    "/help", "/cwd", "/git", "/diff", "/model", "/effort", "/rename", "/compact",
    "/computeruse",
})


@dataclass(slots=True)
class TurnRequest:
    manifest: dict[str, Any]
    prompt: str
    emit: Emit
    # What the timeline shows when the prompt sent to the agent is generated.
    display_prompt: str | None = None


class TurnHook:
    def check(self, request: TurnRequest) -> None:
        """Purpose: Reject a turn before it starts by raising. Output: None."""

    async def prepare(self, request: TurnRequest) -> bool:
        """Purpose: Adjust the turn. Output: False when the hook handled the turn itself."""
        return True


class EvolutionPolicy(TurnHook):
    def __init__(self, is_evolution: Callable[[dict[str, Any]], bool]) -> None:
        self._is_evolution = is_evolution

    def check(self, request: TurnRequest) -> None:
        if self._is_evolution(request.manifest) and request.prompt.startswith("/"):
            if request.prompt.split(" ", 1)[0] not in EVOLUTION_COMMANDS:
                raise ValueError("进化任务不能切换工作目录、任务或放宽权限，请使用进化页面操作。")


class ComputerUseHook(TurnHook):
    """Turn ``/computeruse <task>`` into instructions for the computer tools."""

    def __init__(
        self, expand: Callable[[dict[str, Any], str, Emit], Awaitable[str | None]],
    ) -> None:
        self._expand = expand

    async def prepare(self, request: TurnRequest) -> bool:
        if request.prompt.split(maxsplit=1)[0] != "/computeruse":
            return True
        request.display_prompt = (
            "Computer use：" + request.prompt.removeprefix("/computeruse").strip()
        )
        prompt = await self._expand(request.manifest, request.prompt, request.emit)
        if prompt is None:
            return False
        request.prompt = prompt
        return True


class SkillExpander(TurnHook):
    """Replace ``/<skill>`` with the instructions of a local skill of the task's harness."""

    def __init__(self, skills: Callable[[dict[str, Any]], Any]) -> None:
        self._skills = skills

    async def prepare(self, request: TurnRequest) -> bool:
        if request.prompt.startswith("/"):
            command = request.prompt.split()[0]
            skill = next((skill for skill in self._skills(request.manifest)
                          if skill.command == command), None)
            if skill is not None:
                request.prompt = skill.expand(request.prompt)
        return True


@asynccontextmanager
async def timed_reply(
    memory_dir: Path | str, manifest: dict[str, Any], emit: Emit, forward: Emit,
) -> AsyncIterator[Emit]:
    """Purpose: Record one agent run as a ``reply`` timing and observe its events.

    Input: Memory directory, session manifest, the client sink (for ``timing`` events) and
    where to forward the run's events. Output: The event sink to give the agent run; it
    tracks tool, approval and question phases before forwarding each event.
    """
    from cleo.runtime.timing import measure

    async def timing_event(summary):
        await emit({"type": "timing", "timing": summary})

    async with measure(
        memory_dir, session_id=manifest["id"], space=manifest["space"],
        project=manifest["project"], kind="reply", emit=timing_event,
    ) as timing:
        timing.phase("准备上下文与任务")
        timing.summary["unavailable"] = ["模型服务内部阶段"]
        observed: dict[str, Any] = {}

        async def timed_event(event):
            if event["type"] == "turn-started":
                timing.summary["turnId"] = event["item"]["id"]
            elif event["type"] == "error":
                timing.summary["status"] = "failed"
            elif event["type"] == "upsert-item" and event["item"]["type"] == "tool":
                item = event["item"]
                key = item["id"]
                if item["status"] == "running" and key not in observed:
                    observed[key] = timing.start(item["name"], category="tool")
                elif item["status"] in {"done", "error"}:
                    timing.end(observed.get(key),
                               "failed" if item["status"] == "error" else "completed")
            elif event["type"] in {"approval-request", "question-request"}:
                request = event["request"]
                key = event["type"].split("-")[0] + request["id"]
                if key not in observed:
                    observed[key] = timing.start(
                        "等待审批" if event["type"] == "approval-request"
                        else "等待回答",
                        category="wait",
                    )
            elif event["type"] in {"approval-resolved", "question-resolved"}:
                result = event.get("response") or event["request"]
                timing.end(observed.get(event["type"].split("-")[0] + result["id"]))
            await forward(event)

        yield timed_event
