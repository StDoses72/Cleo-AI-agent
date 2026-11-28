"""Compose the input of a workflow node (ADR 0021)."""

from cleo.workflows.engine import NodeTask


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
        parts.append("Call submit_workflow_verdict with your pass or revise decision and feedback.")
    if task.lists:
        parts.append("Call submit_workflow_items with the ordered work items for the next step.")
    return "\n\n".join(part for part in parts if part)
