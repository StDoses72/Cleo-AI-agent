import pytest

from cleo.workflows.authoring import node_request, read_node, read_workflow, workflow_request
from cleo.workflows.validation import workflow_issues
from tests.workflows.test_workflows import HARNESSES, agent, graph

REPLY = """Plan first, have it refuted, then build.

```cleo-workflow
{"name": "Plan, refute, build", "description": "A change worth thinking through first.",
 "nodes": [{"key": "plan", "role": "Planner", "instructions": "Split the task into steps."},
           {"key": "refute", "role": "Refuter", "instructions": "Find what fails.",
            "harness": "codex"},
           {"key": "fix", "role": "Fixer", "instructions": "Fix one item.", "access": "write",
            "each": 3}],
 "edges": [{"from": "start", "to": "plan"}, {"from": "plan", "to": "refute"},
           {"from": "refute", "to": "plan", "maxRounds": 2},
           {"from": "refute", "to": "fix"}, {"from": "fix", "to": "end"}]}
```
"""


def test_a_workflow_an_agent_wrote_opens_as_a_laid_out_definition() -> None:
    definition = read_workflow(REPLY)
    assert (definition.name, definition.origin) == ("Plan, refute, build", "drafted")
    plan, refute, fix = definition.nodes
    assert (refute.harness, fix.access, fix.each, plan.drafted) == ("codex", "write", 3, True)
    assert len({node.id for node in definition.nodes}) == 3 and plan.id != "plan"
    loop = next(edge for edge in definition.edges if edge.loop)
    assert (loop.from_, loop.to, loop.loop.max_rounds) == (refute.id, plan.id, 2)
    # Top to bottom on one axis, the ends in line with it.
    assert plan.y < refute.y < fix.y < definition.end.y and plan.x == refute.x == fix.x
    assert definition.start.x + 32 == plan.x + 104
    # It is checked like any other: the codex node has no model yet.
    codes = [issue.code for issue in workflow_issues(definition, HARNESSES)]
    assert codes == ["runtime_unknown"]


def test_a_reply_without_a_workflow_is_only_a_reply() -> None:
    assert read_workflow("What is the workflow for?") is None
    fence = "```cleo-workflow\n%s\n```"
    for broken in ("{not json}",
                   '{"nodes": [{"key": "a"}], "edges": [{"from": "a", "to": "b"}]}',
                   '{"nodes": [{"key": "a", "access": "root"}], "edges": []}'):
        broken = fence % broken
        with pytest.raises(ValueError):
            read_workflow(broken)


def test_the_requests_say_what_a_workflow_is_and_where_a_node_sits() -> None:
    request = workflow_request("review every PR twice", ["codex", "claude"])
    assert "review every PR twice" in request and "codex, claude" in request
    assert "cleo-workflow" in request and "maxRounds" in request
    definition = graph([agent("Planner"), agent("blank"), agent("Tester")],
                       ["start>Planner", "Planner>blank", "blank>Tester", "Tester>end"])
    asked = node_request("check the plan for gaps", definition, "blank")
    assert "receives from: Planner" in asked and "hands on to: Tester" in asked
    assert "check the plan for gaps" in asked


def test_a_node_an_agent_wrote_is_its_three_fields() -> None:
    fields = '{"role": "Reviewer", "instructions": "Find gaps.", "access": "read", "x": 1}'
    reply = f"Here.\n```cleo-node\n{fields}\n```"
    assert read_node(reply) == {"role": "Reviewer", "instructions": "Find gaps.", "access": "read"}
    for broken in ("no block", '```cleo-node\n{"access": "all"}\n```'):
        with pytest.raises(ValueError):
            read_node(broken)
