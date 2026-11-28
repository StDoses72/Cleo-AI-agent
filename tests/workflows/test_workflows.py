import json

import pytest
from pydantic import ValidationError

from cleo.workflows.models import Definition, Harness, NodeFields
from cleo.workflows.store import WorkflowStore
from cleo.workflows.validation import loop_body, workflow_issues

HARNESSES = [
    Harness(id="codex", models=frozenset({"deep", "fast"})),
    Harness(id="claude", available=False, models=frozenset({"b"})),
    Harness(id="acp", models=frozenset({"c"}), read_only=False),
    Harness(id="bare", models=frozenset({"d"}), tools=False),
]


def agent(role: str, **extra) -> dict:
    return {"id": role, "role": role, "instructions": f"{role} instructions", **extra}


def graph(nodes: list[dict], links: list[str], name: str = "w") -> Definition:
    """A workflow from nodes and "from>to" pairs; a pair that ends in "*n" is a loop of n rounds."""
    edges = []
    for index, link in enumerate(links):
        pair, _, rounds = link.partition("*")
        source, target = pair.split(">")
        edge = {"id": f"e{index}", "from": source, "to": target}
        if rounds:
            edge["loop"] = {"maxRounds": int(rounds), "onExhausted": "stop"}
        edges.append(edge)
    return Definition.model_validate({"id": "wf", "name": name, "nodes": nodes, "edges": edges,
                                      "start": {"x": 0, "y": 0}, "end": {"x": 0, "y": 300}})


def codes(definition: Definition) -> list[str]:
    return [issue.code for issue in workflow_issues(definition, HARNESSES)]


def test_a_chain_a_fork_and_a_bounded_loop_can_run() -> None:
    chain = graph([agent("a"), agent("b")], ["start>a", "a>b", "b>end"])
    fork = graph([agent("a"), agent("b"), agent("c")],
                 ["start>a", "start>b", "a>c", "b>c", "c>end"])
    loop = graph([agent("plan"), agent("judge"), agent("do")],
                 ["start>plan", "plan>judge", "judge>do", "do>end", "judge>plan*3"])
    assert [codes(chain), codes(fork), codes(loop)] == [[], [], []]
    assert loop_body(loop, loop.edges[-1]) == ["plan", "judge"]


def test_what_is_missing_is_reported_in_reading_order() -> None:
    assert codes(graph([], [], name=" ")) == ["name_missing", "no_nodes"]
    loose = graph([agent("a"), {"id": "blank"}, agent("quiet", instructions="")], ["start>a"])
    assert codes(loose) == ["end_unconnected", "node_no_output", "role_missing",
                            "instructions_missing", "node_no_input", "node_no_output"]


def test_a_node_is_bound_to_a_harness_and_model_that_exist() -> None:
    definition = graph(
        [agent("gone", harness="codex", model="removed"),
         agent("offline", harness="claude", model="b"),
         agent("unlisted", harness="other", model="x"),
         agent("set", harness="codex", model="deep")],
        ["start>gone", "gone>offline", "offline>unlisted", "unlisted>set", "set>end"])
    assert codes(definition) == ["runtime_unknown", "runtime_unavailable", "runtime_unknown"]


def test_a_node_that_returns_a_verdict_or_a_list_needs_tools() -> None:
    bare = {"harness": "bare", "model": "d"}
    loop = graph([agent("plan"), agent("judge", **bare)],
                 ["start>plan", "plan>judge", "judge>plan*2", "judge>end"])
    assert codes(loop) == ["tools_missing"]
    each = graph([agent("list", **bare), agent("item", each=3), agent("last", **bare)],
                 ["start>list", "list>item", "item>last", "last>end"])
    found = [(issue.code, issue.subject) for issue in workflow_issues(each, HARNESSES)]
    assert found == [("tools_missing", "list")]


def test_loops_are_bounded_closed_and_apart() -> None:
    forward = ["start>a", "a>b", "b>c", "c>end"]
    nodes = [agent("a"), agent("b"), agent("c")]
    assert codes(graph(nodes, [*forward, "b>a*9"])) == ["loop_rounds"]
    assert codes(graph(nodes, [*forward, "a>b*2"])) == ["loop_target"]
    aside = [*nodes, agent("d")]
    assert codes(graph(aside, [*forward, "c>a*2", "a>d", "d>end"])) == ["loop_leak"]
    assert codes(graph(nodes, [*forward, "b>a*2", "c>b*2"])) == ["loop_overlap"]
    assert codes(graph(nodes, [*forward, "c>a"])) == ["cycle"]


def test_a_node_per_item_takes_its_list_from_one_node() -> None:
    first = graph([agent("item", each=3)], ["start>item", "item>end"])
    assert codes(first) == ["each_predecessor"]
    many = graph([agent("list"), agent("item", each=20)], ["start>list", "list>item", "item>end"])
    assert codes(many) == ["each_range"]


def test_a_definition_of_another_shape_is_refused() -> None:
    with pytest.raises(ValidationError):
        graph([agent("a", access="admin")], ["start>a", "a>end"])
    with pytest.raises(ValidationError):
        graph([agent("../a")], [])


def test_a_workflow_is_one_file_and_reads_back_as_it_was(tmp_path) -> None:
    store = WorkflowStore(tmp_path / "workflows")
    assert store.workflows() == []
    saved = store.save(graph([agent("a")], ["start>a", "a>end"], name="  Review  "))
    assert saved.name == "Review" and saved.updated_at
    on_disk = json.loads((tmp_path / "workflows" / "wf.json").read_text(encoding="utf-8"))
    assert on_disk["edges"][0] == {"id": "e0", "from": "start", "to": "a", "loop": None}
    assert on_disk["nodes"][0]["harness"] is None and on_disk["updatedAt"] == saved.updated_at
    assert store.workflows() == [saved] and store.get("wf") == saved
    (tmp_path / "workflows" / "broken.json").write_text("{", encoding="utf-8")
    assert store.workflows() == [saved]
    store.remove("wf")
    assert store.get("wf") is None
    with pytest.raises(ValueError):
        store.save(graph([], [], name=" "))
    with pytest.raises(ValueError):
        store.get("../secret")


def test_a_kept_node_replaces_the_one_of_the_same_name(tmp_path) -> None:
    store = WorkflowStore(tmp_path)
    store.save_role("r1", NodeFields(role="Reviewer", instructions="first"))
    store.save_role("r2", NodeFields(role="Reviewer", instructions="second"))
    assert [(role.id, role.fields.instructions) for role in store.roles()] == [("r2", "second")]
    assert store.workflows() == []
    store.remove_role("r2")
    assert store.roles() == []
    with pytest.raises(ValueError):
        store.save_role("r3", NodeFields())


def test_the_desktop_serves_the_library_and_what_each_harness_can_be_held_to(tmp_path) -> None:
    import asyncio
    from types import SimpleNamespace

    from cleo.config.settings import ProductivitySettings
    from cleo.desktop.service import DesktopService

    settings = SimpleNamespace(DATA_DIR=tmp_path, productivity=ProductivitySettings())
    service = DesktopService(settings_model=settings, store=SimpleNamespace(),
                             runtime=SimpleNamespace(), adapter=SimpleNamespace())
    definition = graph([agent("a")], ["start>a", "a>end"]).model_dump(by_alias=True)

    async def scenario() -> dict:
        saved = await service.save_workflow(definition=definition)
        role = await service.save_workflow_role(fields={"role": "Reviewer", "instructions": "x"})
        library = await service.get_workflow_library()
        assert library["workflows"] == [saved] and library["roles"] == [role]
        assert saved["nodes"][0]["harness"] is None and saved["edges"][0]["from"] == "start"
        await service.remove_workflow(workflow_id=saved["id"])
        await service.remove_workflow_role(role_id=role["id"])
        return library

    library = asyncio.run(scenario())
    harnesses = {item["id"]: item for item in library["harnesses"]}
    assert (harnesses["claude"]["readOnly"], harnesses["claude"]["tools"]) == (True, True)
    assert harnesses["antigravity"]["readOnly"] is False
    assert harnesses["antigravity-sdk"]["tools"] is False
    assert asyncio.run(service.get_workflow_library())["workflows"] == []
    with pytest.raises(ValidationError):
        asyncio.run(service.save_workflow(definition={**definition, "nodes": "none"}))
