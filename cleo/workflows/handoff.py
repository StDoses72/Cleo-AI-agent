"""What a node is told and how its reply is read (ADR 0020).

A node that judges a loop, or whose successor runs once per item, ends its reply with a short
marked block. The orchestrator reads that block and nothing else of the reply decides an edge;
the block is not part of what the next node or the user is shown.
"""

from __future__ import annotations

import re

from cleo.workflows.engine import Handoff, NodeFailed, NodeTask

VERDICT = re.compile(r"^\s*CLEO_VERDICT:\s*(pass|revise)\s*$", re.I | re.M)
ITEMS = re.compile(r"^\s*CLEO_ITEMS_BEGIN\s*$(.*?)^\s*CLEO_ITEMS_END\s*$", re.S | re.M)
_BULLET = re.compile(r"^\s*(?:[-*•·]|\d+[.)、])\s*")

VERDICT_RULE = (
    "You judge whether the work passes. End your reply with one line on its own, exactly "
    "`CLEO_VERDICT: pass` or `CLEO_VERDICT: revise`. With `revise`, say above it what must change."
)
ITEMS_RULE = (
    "The next step runs once for each item you list. End your reply with the list between two "
    "lines, one item per line and each item complete in itself:\n"
    "CLEO_ITEMS_BEGIN\n<item>\n<item>\nCLEO_ITEMS_END"
)


def node_prompt(task: NodeTask) -> str:
    """Purpose: The one message a node's session is given.

    Output: Its responsibility, the task, its item or round when it has one, what the nodes
    before it produced, and how to hand back a verdict or a list when an edge depends on it.
    """
    parts = [task.node.instructions.strip(), f"Task:\n{task.task}"]
    if task.item:
        parts.append(f"The one item assigned to you:\n{task.item}")
    if task.round and task.round > 1:
        parts.append(f"This is round {task.round}. Address what the review below asks for.")
    for role, text in task.inputs:
        parts.append(f"From {role}:\n{text}")
    if task.judge:
        parts.append(VERDICT_RULE)
    if task.lists:
        parts.append(ITEMS_RULE)
    return "\n\n".join(part for part in parts if part)


def read_reply(task: NodeTask, reply: str, *, tokens: int | None = None) -> Handoff:
    """Input: The node's task and its final reply. Output: The handoff, without the marked
    blocks. Raises NodeFailed when a block an edge depends on is missing."""
    verdict = None
    items: tuple[str, ...] = ()
    text = reply
    if task.judge:
        found = VERDICT.findall(reply)
        if not found:
            raise NodeFailed(f"{task.node.role} did not return a verdict.")
        verdict = found[-1].lower()
        text = VERDICT.sub("", text)
    if task.lists:
        block = ITEMS.search(reply)
        listed = block.group(1) if block else ""
        lines = [_BULLET.sub("", line).strip() for line in listed.splitlines()]
        items = tuple(line for line in lines if line)
        if not items:
            raise NodeFailed(f"{task.node.role} did not return a list.")
        text = ITEMS.sub("", text)
    return Handoff(text=text.strip(), verdict=verdict, items=items, tokens=tokens)
