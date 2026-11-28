"""Having an agent write a workflow, or one node of it (ADR 0021).

The agent is told what a workflow is made of and hands back one marked JSON block in a small
shape: no canvas positions and no ids of its own choosing beyond short node keys. What it hands
back is checked like anything else; the user sees it on the canvas and saving is theirs.
"""

from __future__ import annotations

import json
import re
import secrets
from typing import Any

from pydantic import ValidationError

from cleo.workflows.models import END, MAX_ITEMS, MAX_ROUNDS, START, Definition, NodeFields

BLOCK = re.compile(r"```cleo-workflow\s*\n(.*?)\n```", re.S)
NODE_BLOCK = re.compile(r"```cleo-node\s*\n(.*?)\n```", re.S)
NODE_WIDTH, NODE_HEIGHT, TERMINAL_WIDTH, TERMINAL_HEIGHT = 208, 64, 64, 30

GUIDE = f"""A Cleo workflow is a graph of agent nodes between two fixed ends, "start" (the task \
going in) and "end" (the result coming out). The user owns the graph: an agent inside a node \
cannot skip or add a step, and sees only the task and what the nodes before it produced.

Edges are the only control there is:
- an edge from one node to the next runs them in sequence;
- several edges out of one node (or out of "start") run side by side, and a node with several \
edges in waits for all of them;
- an edge back to an earlier node is a loop: the node it leaves judges the work, and the stretch \
between the two repeats until the judge passes it, at most "maxRounds" times (1 to {MAX_ROUNDS});
- a node with "each" set runs one copy per item of the list the single node before it returns, \
up to that many (2 to {MAX_ITEMS}).

Write each node's "instructions" as that node's whole responsibility in three short lines: what \
it does, what it hands back, what it must not do. A node reads files only, unless "access" is \
"write". Give every node an input and an output, keep a loop closed (work enters it at its \
first node and leaves it through the judge), and use as few nodes as the job needs."""

SHAPE = """```cleo-workflow
{"name": "...", "description": "one sentence on why this shape fits",
 "nodes": [{"key": "plan", "role": "Planner", "instructions": "...", "access": "read"},
           {"key": "review", "role": "Reviewer", "instructions": "..."},
           {"key": "do", "role": "Executor", "instructions": "...", "access": "write"}],
 "edges": [{"from": "start", "to": "plan"}, {"from": "plan", "to": "review"},
           {"from": "review", "to": "plan", "maxRounds": 3},
           {"from": "review", "to": "do"}, {"from": "do", "to": "end"}]}
```"""


def workflow_request(needs: str, harnesses: list[str]) -> str:
    """The message that asks the conversation's agent for a workflow."""
    return "\n\n".join([
        "Design a Cleo workflow for what the user needs. You may read the project to fit it.",
        GUIDE,
        ('A node may name a "harness" from this list when the user asks for a particular one; '
         f"otherwise leave it out and the node follows the conversation: {', '.join(harnesses)}."),
        "Reply with a few sentences on the design, then exactly one block in this shape "
        "(role names in the user's language):\n" + SHAPE,
        f"What the user needs:\n{needs or '(not said yet: ask what the workflow is for)'}",
    ])


def node_request(intent: str, definition: Definition, node_id: str) -> str:
    """The message that asks for one node's definition, given where the node sits."""
    roles = {node.id: node.role or "(unnamed)" for node in definition.nodes}
    roles.update({START: "the task", END: "the result"})
    forward = [edge for edge in definition.edges if edge.loop is None]
    before = [roles.get(edge.from_, "") for edge in forward if edge.to == node_id]
    after = [roles.get(edge.to, "") for edge in forward if edge.from_ == node_id]
    return "\n\n".join([
        "Write the definition of one node of a Cleo workflow. Do not use any tools.",
        GUIDE,
        f"The workflow is “{definition.name or 'untitled'}”. This node receives from: "
        f"{', '.join(before) or 'nothing yet'}. "
        f"It hands on to: {', '.join(after) or 'nothing yet'}.",
        'Reply with exactly one block: ```cleo-node\n{"role": "short name", "instructions": '
        '"three short lines", "access": "read" or "write"}\n``` Use the language of the sentence.',
        f"What the node should do:\n{intent}",
    ])


def read_node(reply: str) -> dict[str, Any]:
    """Output: The fields the agent wrote for a node. Raises ValueError when there are none."""
    block = NODE_BLOCK.findall(reply)
    try:
        raw = json.loads(block[-1])
        fields = NodeFields.model_validate({key: raw[key] for key in
                                            ("role", "instructions", "access") if key in raw})
    except (IndexError, ValueError, TypeError, ValidationError) as error:
        raise ValueError("The reply held no node definition.") from error
    return fields.model_dump(by_alias=True, include={"role", "instructions", "access"})


def read_workflow(reply: str) -> Definition | None:
    """Purpose: The workflow an agent handed back, as a definition the canvas can open.

    Output: The definition with fresh ids and a top-to-bottom layout, or None when the reply
    holds no block. Raises ValueError for a block that is not a workflow.
    """
    block = BLOCK.findall(reply)
    if not block:
        return None
    try:
        raw = json.loads(block[-1])
        prefix = secrets.token_hex(4)
        ids = {str(node["key"]): f"{prefix}-{index}" for index, node in enumerate(raw["nodes"])}
        ends = {START: START, END: END, **ids}
        nodes = [{
            "id": ids[str(node["key"])], "role": str(node.get("role") or "")[:24],
            "instructions": str(node.get("instructions") or "")[:2000],
            "harness": node.get("harness"), "access": node.get("access") or "read",
            "each": node.get("each"), "drafted": True,
        } for node in raw["nodes"]]
        edges = [{
            "id": f"{prefix}-e{index}",
            "from": ends[str(edge["from"])], "to": ends[str(edge["to"])],
            **({"loop": {"maxRounds": int(edge["maxRounds"]), "onExhausted": "stop"}}
               if edge.get("maxRounds") else {}),
        } for index, edge in enumerate(raw["edges"])]
        definition = Definition.model_validate({
            "id": f"{prefix}-{secrets.token_hex(4)}", "name": str(raw.get("name") or "")[:60],
            "description": str(raw.get("description") or "")[:400], "nodes": nodes,
            "edges": edges, "start": {"x": 0, "y": 0}, "end": {"x": 0, "y": 0},
            "origin": "drafted",
        })
    except (KeyError, ValueError, TypeError, ValidationError) as error:
        raise ValueError("The reply's workflow block could not be read.") from error
    return lay_out(definition)


def lay_out(definition: Definition) -> Definition:
    """Purpose: Place the graph top to bottom, a row per step away from the task, as the
    canvas's own tidy does. Only positions change."""
    following: dict[str, list[str]] = {}
    for edge in definition.edges:
        if edge.loop is None:
            following.setdefault(edge.from_, []).append(edge.to)
    depth: dict[str, int] = {}

    def walk(node: str, level: int, trail: frozenset[str]) -> None:
        if node in trail or depth.get(node, -1) >= level:
            return
        depth[node] = level
        for target in following.get(node, []):
            if target != END:
                walk(target, level + 1, trail | {node})

    walk(START, 0, frozenset())
    for node in definition.nodes:
        if node.id not in depth:
            walk(node.id, 1, frozenset())
    rows: dict[int, list] = {}
    for node in definition.nodes:
        rows.setdefault(depth[node.id], []).append(node)
    ordered = [rows[level] for level in sorted(rows)]
    pitch, drop = NODE_WIDTH + 32, NODE_HEIGHT + 40
    widest = max([1, *(len(row) for row in ordered)])
    middle = 48 + (widest * pitch - 32) / 2
    top = 48 + TERMINAL_HEIGHT + 40
    for index, row in enumerate(ordered):
        for column, node in enumerate(row):
            node.x = round((middle - (len(row) * pitch - 32) / 2 + column * pitch) / 8) * 8
            node.y = round((top + index * drop) / 8) * 8
    definition.start.x = definition.end.x = round((middle - TERMINAL_WIDTH / 2) / 8) * 8
    definition.start.y = 48
    definition.end.y = round((top + max(1, len(ordered)) * drop) / 8) * 8
    return definition
