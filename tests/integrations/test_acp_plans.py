import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from acp import plan_entry, start_tool_call, update_plan, update_tool_call

from cleo.desktop.projection import stream_event_item, timeline_from_events
from cleo.harnesses import AgentAdapter
from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider, _AcpClientHost


@pytest.mark.parametrize("live", [True, False])
@pytest.mark.parametrize("source", ["native", "todowrite"])
def test_acp_plans_preserve_native_events_and_update_one_card_per_turn(
    tmp_path, monkeypatch, live, source,
):
    first = [
        {"content": "Inspect", "status": "in_progress", "priority": "high"},
        {"content": "Implement", "status": "pending", "priority": "medium"},
        {"content": "Unneeded step", "status": "pending", "priority": "low"},
    ]
    second = [
        {"content": "Inspect", "status": "completed", "priority": "high"},
        {"content": "Implement", "status": "in_progress", "priority": "medium"},
    ]
    if source == "native":
        updates = [update_plan([plan_entry(**entry) for entry in entries])
                   for entries in (first, second)]
    else:
        updates = [
            start_tool_call("todo-1", "todowrite", status="pending", raw_input={}),
            update_tool_call("todo-1", status="in_progress", raw_input={"todos": first}),
            update_tool_call("todo-1", status="completed"),
            start_tool_call("read-1", "read", status="completed", raw_input={"todos": first}),
            start_tool_call("todo-2", "TodoWrite", status="in_progress",
                            raw_input={"todos": second}),
            update_tool_call("todo-2", status="completed", title="Updated 2 todos"),
        ]

    async def scenario():
        provider = AcpProvider("opencode", AcpAgentSpec(command="opencode", args=("acp",)))
        host = _AcpClientHost("opencode", str(tmp_path), auto_approve=False)

        async def prompt(session_id, blocks):
            for update in updates:
                await host.session_update(session_id, update)
            return SimpleNamespace(stop_reason="end_turn")

        connection = SimpleNamespace(
            new_session=AsyncMock(return_value=SimpleNamespace(
                session_id="native-opencode", config_options=[],
            )),
            prompt=prompt,
        )
        monkeypatch.setattr(provider, "_connect", AsyncMock(return_value=(
            connection, SimpleNamespace(__aexit__=AsyncMock()), host, None,
        )))
        adapter = AgentAdapter(tmp_path)
        adapter.register(provider)
        try:
            session = await adapter.create_session("opencode")
            for turn in range(2):
                received = []
                result = await adapter.prompt(session.id, f"Implement turn {turn}",
                                              on_event=received.append if live else None)
                plans = [event for event in result.events if event.type == "plan_update"]
                assert len(plans) == 2
                if source == "native":
                    assert [event.data for event in plans] == [
                        {"provider_event_type": "plan", "schema_version": 1,
                         "payload": update.model_dump(by_alias=True, exclude_none=True)}
                        for update in updates
                    ]
                else:
                    tools = [event for event in result.events if event.type != "plan_update"]
                    assert [event.type for event in tools] == [
                        "tool_call", "tool_result", "tool_result", "tool_call", "tool_call",
                        "tool_result",
                    ]
                    assert [event.data for event in tools] == [
                        {"provider_event_type": update.session_update, "schema_version": 1,
                         "payload": update.model_dump(by_alias=True, exclude_none=True)}
                        for update in updates
                    ]
                    assert [event.data for event in plans] == [
                        {"plan": [{"step": entry["content"], "status": entry["status"]}
                                  for entry in entries]}
                        for entries in (first, second)
                    ]
                stored = adapter._store.read_events(session.id)
                assert sum(event["type"] == "plan_update" for event in stored) == 2 * (turn + 1)
                cards = [item for item in timeline_from_events(stored) if item["type"] == "plan"]
                assert len(cards) == turn + 1
                assert len({card["id"] for card in cards}) == len(cards)
                assert cards[-1]["steps"] == [
                    {"label": "Inspect", "status": "done"},
                    {"label": "Implement", "status": "running"},
                ]
                if live:
                    live_plans = [event for event in received if event.type == "plan_update"]
                    assert len(live_plans) == 2
                    assert {event.data["timeline_id"] for event in live_plans} == {cards[-1]["id"]}
                    state = {}
                    projected = [stream_event_item(event, state)[0]["item"]
                                 for event in live_plans]
                    assert projected[0]["steps"] == [
                        {"label": "Inspect", "status": "running"},
                        {"label": "Implement", "status": "pending"},
                        {"label": "Unneeded step", "status": "pending"},
                    ]
                    assert projected[0]["id"] == projected[1]["id"] == cards[-1]["id"]
                    assert projected[1]["steps"] == cards[-1]["steps"]
        finally:
            await adapter.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize("notification", ["tool_call", "tool_call_update"])
@pytest.mark.parametrize("raw_input,status,expected", [
    ({}, "in_progress", None),
    ({"todos": None}, "in_progress", None),
    ({"todos": "Inspect"}, "in_progress", None),
    ("invalid", "in_progress", None),
    ({"todos": [{"content": "Inspect", "status": "pending"}]}, "failed", None),
    ({"todos": []}, "in_progress", []),
    ({"todos": [None, "invalid", {"content": "Inspect", "status": "pending"}]},
     "in_progress", [{"step": "Inspect", "status": "pending"}]),
])
def test_acp_todowrite_handles_failed_empty_and_malformed_inputs(
    tmp_path, notification, raw_input, status, expected,
):
    host = _AcpClientHost("opencode", str(tmp_path), auto_approve=False)
    received = []
    if notification == "tool_call":
        update = start_tool_call("todo-1", "todowrite", status=status, raw_input=raw_input)
        event_type = "tool_call"
    else:
        update = update_tool_call("todo-1", status=status, raw_input=raw_input)
        event_type = "tool_result"

    async def scenario():
        host.begin_turn(received.append)
        try:
            if notification == "tool_call_update":
                await host.session_update("native", start_tool_call("todo-1", "todowrite"))
                received.clear()
            await host.session_update("native", update)
        finally:
            await host.end_turn()

    asyncio.run(scenario())
    assert [event.type for event in received] == (
        [event_type] if expected is None else [event_type, "plan_update"]
    )
    assert received[0].data["payload"] == update.model_dump(by_alias=True, exclude_none=True)
    if expected is not None:
        assert received[1].data == {"plan": expected}


def test_acp_todowrite_tracking_does_not_leak_into_the_next_turn(tmp_path):
    host = _AcpClientHost("opencode", str(tmp_path), auto_approve=False)
    todos = {"todos": [{"content": "Inspect", "status": "in_progress"}]}
    received = []

    async def scenario():
        host.begin_turn(None)
        await host.session_update("native", start_tool_call("reused-id", "todowrite"))
        await host.end_turn()
        host.begin_turn(received.append)
        try:
            await host.session_update("native", update_tool_call(
                "reused-id", status="in_progress", raw_input=todos,
            ))
            await host.session_update("native", start_tool_call(
                "read-id", "read", status="in_progress", raw_input=todos,
            ))
            await host.session_update("native", update_tool_call(
                "read-id", status="completed", raw_input=todos,
            ))
        finally:
            await host.end_turn()

    asyncio.run(scenario())
    assert [event.type for event in received] == ["tool_result", "tool_call", "tool_result"]


def test_acp_todowrite_callback_suspension_does_not_leak_plan_into_next_turn(tmp_path):
    host = _AcpClientHost("opencode", str(tmp_path), auto_approve=False)
    original_received = []
    next_received = []

    async def scenario():
        callback_started = asyncio.Event()
        release_callback = asyncio.Event()

        async def original_callback(event):
            original_received.append(event)
            if event.type == "tool_call":
                callback_started.set()
                await release_callback.wait()

        host.begin_turn(original_callback)
        pending = asyncio.create_task(host.session_update("native", start_tool_call(
            "todo-1", "todowrite", status="in_progress",
            raw_input={"todos": [{"content": "Inspect", "status": "in_progress"}]},
        )))
        try:
            await asyncio.wait_for(callback_started.wait(), timeout=1)
            await host.end_turn()
            host.begin_turn(next_received.append)
            release_callback.set()
            await pending
            assert next_received == []
            assert host.events == []
            assert [event.type for event in original_received] == ["tool_call", "plan_update"]
        finally:
            release_callback.set()
            pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)
            await host.end_turn()

    asyncio.run(scenario())
