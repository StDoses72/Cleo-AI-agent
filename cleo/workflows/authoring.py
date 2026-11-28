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

GUIDE = f"""The user owns the graph from "start" (their task) to "end" (their deliverable).
A node sees the original task and the outputs of its immediate predecessors. Give it an input
and an output. Write its instructions in three short lines:
1. What to do with the input.
2. What to hand back so the next step can act, such as a file location and a test result.
3. Its scope and permissions. Use read access by default and write access for steps that edit.

Choose the simplest graph that can deliver the result. One node is often enough. Split off a
step when it needs an independent judgment, different permissions, or work that can run in
parallel. If two adjacent roles would hand each other the same thing, combine them.

Choose edges to match the work:
- In sequence, the next node uses the previous output. Independent branches can run in parallel.
  A join waits for every incoming branch.
- For a review loop, enter at the first node and exit through the judge. Point the return edge
  at the step that can make the correction. Set "maxRounds" from 1 to {MAX_ROUNDS}.
- Use "each" when every item from one predecessor can be processed independently under the same
  criteria. Set its limit from 2 to {MAX_ITEMS}. The predecessor submits an ordered list via MCP.

Give a judge a few observable checks. For pass, ask for the evidence that each check was met.
For revise, ask which check failed or still lacks evidence, what was observed, and what needs
to change or be verified on the next round. The judge submits its verdict and feedback via MCP.
Ordinary handoffs can be plain text."""


EXAMPLE = {
    "name": "Keep edits made during save",
    "description": "One step fixes the editor and a second checks the result.",
    "nodes": [
        {
            "key": "fix", "role": "Fixer", "access": "write",
            "instructions": (
                "Fix the loss of edits made while a save is pending.\n"
                "Hand back the changed files and steps to repeat the edit.\n"
                "Keep changes within the editor save flow."
            ),
        },
        {
            "key": "verify", "role": "Reviewer", "access": "read",
            "instructions": (
                "Save A and type B before it finishes. Check that B stays editable and that "
                "saving again keeps B after reopening.\n"
                "Report what name you observed at each check and give your verdict.\n"
                "Verify the behavior in the editor and send corrections to the fixer."
            ),
        },
    ],
    "edges": [
        {"from": "start", "to": "fix"}, {"from": "fix", "to": "verify"},
        {"from": "verify", "to": "fix", "maxRounds": 2}, {"from": "verify", "to": "end"},
    ],
}


def workflow_request(needs: str, harnesses: list[str]) -> str:
    """The message that asks the conversation's agent for a workflow."""
    return "\n\n".join([
        "Design a Cleo workflow for the user's request. Use the conversation and, when helpful, "
        "read the project. Identify the deliverable and how the user can tell it is complete. "
        "If you can infer a useful outcome, draft it now. Choose sensible defaults for missing "
        "details and briefly mention any assumption that affects the design. Ask one short "
        "question only if the request is so vague that even with context you cannot infer "
        "a useful outcome. In that case, wait for the answer before drafting.",
        GUIDE,
        ('A node may name a "harness" from this list when the user asks for a particular one; '
         f"otherwise leave it out and the node follows the conversation: {', '.join(harnesses)}."),
        "When drafting, explain the design in a few sentences and return exactly one "
        "cleo-workflow JSON block. Use role names in the user's language. Here is one example. "
        "Choose the nodes and checks that fit the actual request.\n"
        f"```cleo-workflow\n{json.dumps(EXAMPLE, indent=2)}\n```",
        f"What the user needs:\n{needs or '(no additional description)'}",
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
