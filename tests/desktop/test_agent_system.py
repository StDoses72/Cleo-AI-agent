from __future__ import annotations

import asyncio
import copy
from pathlib import Path

import pytest

from cleo.desktop.agent_system import (
    CallableRuntime,
    SingleAgentSystem,
    TurnInput,
    agent_system_spec,
)
from cleo.desktop.projection import timeline_from_events
from cleo.memory.compaction import compact_events, load_events

LEGACY = (Path(__file__).resolve().parents[1] / "characterization" / "fixtures"
          / "legacy_home_v0_7_1" / "memory")


def test_sessions_without_a_spec_are_single_and_later_specs_are_reported() -> None:
    assert agent_system_spec({}) == {"mode": "single"}
    assert agent_system_spec({"agent_system": "router"}) == {"mode": "single"}
    router = {"mode": "router", "main": "codex", "members": ["claude"]}
    assert agent_system_spec({"agent_system": router}) == router


def test_single_system_runs_the_space_member_with_only_the_given_options() -> None:
    calls = []

    def runtime(name):
        async def stream(manifest, prompt, attachments, emit, **options):
            calls.append((name, manifest["id"], prompt, attachments, options))
            await emit({"type": "done"})
        return CallableRuntime(stream)

    events = []

    async def emit(event):
        events.append(event)

    system = SingleAgentSystem({"non_productivity": runtime("chat"),
                                "productivity": runtime("harness")})
    asyncio.run(system.run_turn(TurnInput({"id": "c", "space": "non_productivity"}, "hi"), emit))
    asyncio.run(system.run_turn(TurnInput(
        {"id": "t", "space": "productivity"}, "fix", [{"path": "a.txt"}],
        steer_ids=["s1"], display_prompt="Fix it",
    ), emit))

    assert calls == [
        ("chat", "c", "hi", [], {}),
        ("harness", "t", "fix", [{"path": "a.txt"}],
         {"display_prompt": "Fix it", "steer_ids": ["s1"]}),
    ]
    assert events == [{"type": "done"}, {"type": "done"}]
    with pytest.raises(KeyError):
        asyncio.run(system.run_turn(TurnInput({"id": "x", "space": "elsewhere"}, "hi"), emit))


def _without_agent_id(records):
    for record in records:
        data = record.get("data")
        if isinstance(data, dict):
            data.pop("agent_id", None)
    return records


@pytest.mark.parametrize("path", sorted(LEGACY.glob("*/projects/*/sessions/*/events.jsonl")),
                         ids=lambda path: path.parent.name)
def test_optional_agent_id_does_not_change_v071_projections(path: Path) -> None:
    events = load_events(path)
    tagged = copy.deepcopy(events)
    for event in tagged:
        event.setdefault("data", {})["agent_id"] = "main"
    scope = {"space": events[0]["space"], "project": events[0]["project"],
             "session_id": events[0]["session_id"]}

    assert timeline_from_events(tagged) == timeline_from_events(events)
    assert (_without_agent_id(compact_events(events=tagged, **scope)["events"])
            == compact_events(events=events, **scope)["events"])
