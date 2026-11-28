"""The orchestrator: code that pushes a task along a workflow's edges (ADR 0021).

It decides what runs next from the definition the run started with and from what each node
handed back; the agent inside a node never sees the graph. How a node's session is actually
run is the caller's: the engine is given a ``Runner`` and knows nothing of harnesses.

A run is a plain dict in the shape the desktop UI draws (``WorkflowRun`` in
``ui/src/workflow-types.ts``), plus ``progress``: what has finished and what it produced, so a
run that failed or was left by a quit goes on from there.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Any

from cleo.workflows.models import END, START, Definition, Node
from cleo.workflows.validation import loop_body

# A node that fails is tried again this many times before the run gives up on it.
RETRIES = 3
# Node sessions that run at the same time.
CONCURRENCY = 4


class NodeFailed(Exception):
    """A node's session did not produce what the workflow needs from it."""


@dataclass(frozen=True, slots=True)
class Handoff:
    """What a node hands back: its reply, and what the edges out of it are decided by."""

    text: str
    verdict: str | None = None  # "pass" or "revise", from a node that judges a loop.
    items: tuple[str, ...] = ()  # From a node whose successor runs once per item.
    tokens: int | None = None


@dataclass(frozen=True, slots=True)
class NodeTask:
    """One session's worth of work for a node."""

    node: Node
    task: str
    # The session's record in the run; the runner may add ``threadId`` and ``executor`` to it.
    session: dict[str, Any]
    # What the nodes before it produced, as (role, text), and on a later round the verdict.
    inputs: tuple[tuple[str, str], ...] = ()
    round: int | None = None
    item: str | None = None
    judge: bool = False
    lists: bool = False
    changed: Callable[[], Awaitable[None]] | None = field(default=None, compare=False)


Runner = Callable[[NodeTask], Awaitable[Handoff]]
Changed = Callable[[dict[str, Any]], Awaitable[None]]


def now_ms() -> int:
    return int(time.time() * 1000)


def new_run(definition: Definition, task: str, *, workflow_id: str | None,
            project_id: str) -> dict[str, Any]:
    """Output: A run that has not started, holding the definition as it is now."""
    return {
        "id": secrets.token_hex(8), "workflowId": workflow_id,
        "definition": definition.model_dump(by_alias=True), "task": task,
        "projectId": project_id, "status": "running", "sessions": [], "rounds": {},
        "startedAt": now_ms(),
        "progress": {"done": [], "outputs": {}},
    }


def leave(run: dict[str, Any]) -> bool:
    """Purpose: Mark a run that no process is carrying any more: the app quit under it.

    Output: True when it was running and is now paused, with its open sessions closed.
    """
    if run.get("status") != "running":
        return False
    for session in run["sessions"]:
        if session["status"] == "running":
            _close(session, "cancelled")
    run["status"] = "paused"
    return True


def _close(session: dict[str, Any], status: str) -> None:
    session["status"] = status
    session["elapsedMs"] = max(0, now_ms() - session.get("startedAt", now_ms()))


async def execute(run: dict[str, Any], runner: Runner, changed: Changed) -> dict[str, Any]:
    """Purpose: Carry a run to its end, or on from where it failed or was left.

    A node starts once every node before it has finished, and nodes that are ready together
    run together. A judge that does not pass sends the stretch it judges round again. After a
    failure nothing new starts and what is running finishes. Cancelling this coroutine stops
    every session and leaves the run cancelled.

    Input: The run, how to run one session, and a callback after every change (the caller
    saves and shows the run there). Output: The same run, ended.
    """
    definition = Definition.model_validate(run["definition"])
    nodes = {node.id: node for node in definition.nodes}
    forward = [edge for edge in definition.edges if edge.loop is None]
    loops = [edge for edge in definition.edges if edge.loop is not None]
    bodies = {edge.id: loop_body(definition, edge) for edge in loops}
    progress = run["progress"]
    done: set[str] = set(progress["done"])
    outputs: dict[str, dict[str, Any]] = progress["outputs"]
    partial = progress.setdefault("partial", {})
    slots = asyncio.Semaphore(CONCURRENCY)

    async def note() -> None:
        progress["done"] = sorted(done)
        await changed(run)

    for edge_id in progress.pop("exhausted", []):
        run["rounds"].pop(edge_id, None)
    run.update(status="running")
    for key in ("error", "finishedAt", "result"):
        run.pop(key, None)
    await note()

    def sources(node_id: str) -> list[str]:
        return [edge.from_ for edge in forward if edge.to == node_id]

    def finished(node_id: str) -> bool:
        return node_id == START or node_id in done

    async def session(node: Node, *, round_: int | None, item: str | None, judge: bool,
                      lists: bool, index: int = 0) -> Handoff:
        # A successful item and its receipt are checkpointed together, including the
        # interval before its siblings (or the scheduler) finish.
        receipts = partial.setdefault(node.id, {})
        if saved := receipts.get(str(index)):
            return Handoff(**{**saved, "items": tuple(saved["items"])})
        back = next((edge for edge in loops if edge.to == node.id
                     and outputs.get(edge.from_, {}).get("verdict") == "revise"), None)
        given = [*(source for source in sources(node.id) if source != START),
                 *([back.from_] if back else [])]
        inputs = tuple((nodes[source].role, outputs[source]["text"])
                       for source in given if source in outputs)
        for attempt in range(RETRIES + 1):
            record: dict[str, Any] = {
                "id": secrets.token_hex(8), "nodeId": node.id, "role": node.role, "executor": "",
                "access": node.access, "workspace": node.workspace, "status": "running",
                **({"round": round_} if round_ else {}), **({"item": item} if item else {}),
            }
            async with slots:
                record["startedAt"] = now_ms()
                run["sessions"].append(record)
                await note()
                try:
                    handoff = await runner(NodeTask(
                        node=node, task=run["task"], session=record, inputs=inputs,
                        round=round_, item=item, judge=judge, lists=lists, changed=note))
                    if judge and handoff.verdict not in {"pass", "revise"}:
                        raise NodeFailed(f"{node.role} did not return a verdict.")
                    if lists and not handoff.items:
                        raise NodeFailed(f"{node.role} did not return a list.")
                except asyncio.CancelledError:
                    _close(record, "cancelled")
                    raise
                except Exception as error:  # Whatever went wrong in a session fails the node.
                    record["error"] = str(error) or type(error).__name__
                    _close(record, "failed")
                    await note()
                    if node.access == "write" or attempt >= RETRIES:
                        raise NodeFailed(f"{node.role}: {record['error']}") from error
                    continue
                record["output"] = handoff.text
                if handoff.verdict:
                    record["verdict"] = handoff.verdict
                if handoff.tokens is not None:
                    record["tokens"] = handoff.tokens
                receipts[str(index)] = asdict(handoff)
                _close(record, "done")
                await note()
                return handoff
        raise AssertionError("unreachable")

    async def run_node(node: Node) -> None:
        loop = next((edge for edge in loops if node.id in bodies[edge.id]), None)
        round_ = None
        if loop is not None:
            round_ = run["rounds"].setdefault(loop.id, 1)
        judge = any(edge.from_ == node.id for edge in loops)
        lists = any(edge.from_ == node.id and nodes[edge.to].each is not None
                    for edge in forward if edge.to in nodes)
        if node.each is None:
            handoff = await session(node, round_=round_, item=None, judge=judge, lists=lists)
            outputs[node.id] = {"text": handoff.text, "verdict": handoff.verdict,
                                "items": list(handoff.items)}
            return
        before = sources(node.id)
        listed = (outputs.get(before[0]) or {}).get("items") if before else None
        items = list(listed or [])[:node.each]
        if not items:
            raise NodeFailed(f"{node.role}: the node before it returned no list.")
        results = await asyncio.gather(
            *(session(node, round_=round_, item=item, judge=judge, lists=lists, index=index)
              for index, item in enumerate(items)),
            return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        outputs[node.id] = {
            "text": "\n\n".join(f"【{item}】\n{result.text}"
                                for item, result in zip(items, results, strict=True)),
            "verdict": ("pass" if all(r.verdict == "pass" for r in results) else "revise")
            if judge else None,
            "items": [entry for result in results for entry in result.items],
        }

    running: dict[str, asyncio.Task[None]] = {}
    failure: str | None = None
    try:
        while True:
            if failure is None:
                for node in definition.nodes:
                    if node.id in done or node.id in running:
                        continue
                    before = sources(node.id)
                    if before and all(finished(source) for source in before):
                        running[node.id] = asyncio.create_task(run_node(node))
            if not running:
                break
            await asyncio.wait(running.values(), return_when=asyncio.FIRST_COMPLETED)
            for node_id in [key for key, task in running.items() if task.done()]:
                task = running.pop(node_id)
                error = task.exception()
                if error is not None:
                    failure = failure or str(error)
                    continue
                partial.pop(node_id, None)
                done.add(node_id)
                back = next((edge for edge in loops if edge.from_ == node_id), None)
                if back is None or outputs[node_id].get("verdict") == "pass":
                    continue
                round_ = run["rounds"].get(back.id, 1)
                if round_ < back.loop.max_rounds:
                    run["rounds"][back.id] = round_ + 1
                    done.difference_update(bodies[back.id])
                elif back.loop.on_exhausted == "stop":
                    progress.setdefault("exhausted", []).append(back.id)
                    # Nothing after the loop may start: the work was never passed.
                    done.difference_update(bodies[back.id])
                    failure = failure or (
                        f"{nodes[node_id].role}: not passed after {back.loop.max_rounds} rounds.")
            await note()
    except asyncio.CancelledError:
        for task in running.values():
            task.cancel()
        await asyncio.gather(*running.values(), return_exceptions=True)
        run.update(status="cancelled", finishedAt=now_ms())
        await asyncio.shield(note())
        raise
    last = sources(END)
    if failure is not None:
        run.update(status="failed", error=failure)
    elif not last or not all(finished(source) for source in last):
        run.update(status="failed", error="The flow did not reach the result.")
    else:
        texts = [(nodes[source].role, outputs[source]["text"])
                 for source in last if source != START]
        run.update(status="completed", result=texts[0][1] if len(texts) == 1 else "\n\n".join(
            f"【{role}】\n{text}" for role, text in texts))
    run["finishedAt"] = now_ms()
    await note()
    return run
