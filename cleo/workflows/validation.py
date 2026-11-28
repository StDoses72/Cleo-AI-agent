"""Everything that keeps a workflow from running, found before any agent starts.

The same checks, in the same order, as `workflowIssues` in
`ui/src/components/workflows/workflow-model.ts`: the canvas reports them while the user draws,
and the backend decides with them whether a run may start.
"""

from collections.abc import Iterable

from cleo.workflows.models import (
    END,
    MAX_ITEMS,
    MAX_ROUNDS,
    START,
    Definition,
    Edge,
    Harness,
    Issue,
)


def _successors(definition: Definition) -> dict[str, list[str]]:
    following: dict[str, list[str]] = {}
    for edge in definition.edges:
        if edge.loop is None:
            following.setdefault(edge.from_, []).append(edge.to)
    return following


def _reachable(following: dict[str, list[str]], origin: str) -> set[str]:
    seen = {origin}
    queue = [origin]
    while queue:
        for target in following.get(queue.pop(), []):
            if target not in seen:
                seen.add(target)
                queue.append(target)
    return seen


def loop_body(definition: Definition, edge: Edge) -> list[str]:
    """Purpose: The stretch a loop repeats.

    Input: An edge back from a judge to an earlier node. Output: Every node on a path from that
    node to the judge, both included, in the definition's order; empty when the edge does not
    point backwards.
    """
    following = _successors(definition)
    after = _reachable(following, edge.to)
    if edge.from_ not in after:
        return []
    return [node.id for node in definition.nodes
            if node.id in after and edge.from_ in _reachable(following, node.id)]


def _has_cycle(definition: Definition) -> bool:
    following = _successors(definition)
    state: dict[str, bool] = {}  # False while being walked, True once left.

    def visit(node: str) -> bool:
        if node in state:
            return not state[node]
        state[node] = False
        found = any(visit(target) for target in following.get(node, []))
        state[node] = True
        return found

    return any(visit(node) for node in [START, *(item.id for item in definition.nodes)])


def workflow_issues(definition: Definition, harnesses: Iterable[Harness]) -> list[Issue]:
    """Input: A definition and the harnesses that exist now. Output: Issues in reading order;
    an empty list means the workflow can run."""
    issues: list[Issue] = []
    if not definition.name.strip():
        issues.append(Issue(code="name_missing"))
    if not definition.nodes:
        issues.append(Issue(code="no_nodes"))
        return issues
    forward = [edge for edge in definition.edges if edge.loop is None]
    if not any(edge.from_ == START for edge in forward):
        issues.append(Issue(code="start_unconnected"))
    if not any(edge.to == END for edge in forward):
        issues.append(Issue(code="end_unconnected"))
    if _has_cycle(definition):
        issues.append(Issue(code="cycle"))
    known = {harness.id: harness for harness in harnesses}
    roles = {node.id: node.role.strip() for node in definition.nodes}
    lists = {node.id for node in definition.nodes if node.each is not None}
    for node in definition.nodes:
        subject = roles[node.id]
        # A node without a name is reported once; its other gaps show when it can be named.
        if not subject:
            issues.append(Issue(code="role_missing", node_id=node.id))
            continue

        def report(code: str, node_id: str = node.id, subject: str = subject) -> None:
            issues.append(Issue(code=code, node_id=node_id, subject=subject))

        if not node.instructions.strip():
            report("instructions_missing")
        harness = known.get(node.harness) if node.harness is not None else None
        if node.harness is not None:
            if harness is None or node.model not in harness.models:
                report("runtime_unknown")
            elif not harness.available:
                report("runtime_unavailable")
        # A verdict or a list comes back through a tool; a node that follows the conversation
        # is checked when it starts.
        returns = any(edge.from_ == node.id and (edge.loop is not None or edge.to in lists)
                      for edge in definition.edges)
        if returns and harness is not None and not harness.tools:
            report("tools_missing")
        sources = [edge for edge in forward if edge.to == node.id]
        if not sources:
            report("node_no_input")
        if not any(edge.from_ == node.id for edge in forward):
            report("node_no_output")
        if node.each is not None:
            # The list comes from one node; the task is not a list, and a join has no single list.
            if len(sources) != 1 or sources[0].from_ == START:
                report("each_predecessor")
            if not 2 <= node.each <= MAX_ITEMS:
                report("each_range")
    bodies: list[set[str]] = []
    for edge in definition.edges:
        if edge.loop is None:
            continue
        subject = f"{roles.get(edge.to, '')} ⇄ {roles.get(edge.from_, '')}"

        def flag(code: str, edge_id: str = edge.id, subject: str = subject) -> None:
            issues.append(Issue(code=code, edge_id=edge_id, subject=subject))

        if not 1 <= edge.loop.max_rounds <= MAX_ROUNDS:
            flag("loop_rounds")
        inside = set(loop_body(definition, edge))
        if not inside:
            flag("loop_target")
            continue
        # What repeats must be closed: work leaves it only through the judge and enters only
        # at its first node.
        if any((link.from_ in inside and link.from_ != edge.from_ and link.to not in inside)
               or (link.to in inside and link.to != edge.to and link.from_ not in inside)
               for link in forward):
            flag("loop_leak")
        if any(inside & other for other in bodies):
            flag("loop_overlap")
        bodies.append(inside)
    return issues
