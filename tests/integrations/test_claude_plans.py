import asyncio
from dataclasses import asdict
from unittest.mock import AsyncMock

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, ToolUseBlock

from cleo.desktop.projection import stream_event_item, timeline_from_events
from cleo.harnesses import AgentAdapter, SessionOptions
from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime


@pytest.mark.parametrize("live", [True, False])
def test_todowrite_preserves_tool_calls_and_updates_one_plan(tmp_path, monkeypatch, live):
    blocks = [
        ToolUseBlock(id="todo-1", name="TodoWrite", input={"todos": [
            {"content": "Inspect", "status": "in_progress", "activeForm": "Inspecting"},
            {"content": "Implement", "status": "pending", "activeForm": "Implementing"},
        ]}),
        ToolUseBlock(id="read-1", name="Read", input={"file_path": "README.md"}),
        ToolUseBlock(id="todo-2", name="TodoWrite", input={"todos": [
            {"content": "Inspect", "status": "completed", "activeForm": "Inspecting"},
            {"content": "Implement", "status": "in_progress", "activeForm": "Implementing"},
        ]}),
    ]

    class Client:
        query = AsyncMock()
        disconnect = AsyncMock()

        async def receive_response(self):
            for block in blocks:
                yield AssistantMessage(content=[block], model="test")
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1, session_id="native", result="done")

    async def scenario():
        provider = ClaudeProvider()
        monkeypatch.setattr(provider, "_connect", AsyncMock(return_value=_ClaudeRuntime(
            Client(), SessionOptions(), str(tmp_path),
        )))
        adapter = AgentAdapter(tmp_path)
        adapter.register(provider)
        received = []
        try:
            result = await adapter.run("claude", "Implement the change",
                                       on_event=received.append if live else None)
            assert [event.type for event in result.events] == [
                "tool_call", "plan_update", "tool_call", "tool_call", "plan_update",
            ]
            tool_calls = [event for event in result.events if event.type == "tool_call"]
            assert [event.data for event in tool_calls] == [asdict(block) for block in blocks]
            plans = [event for event in result.events if event.type == "plan_update"]
            assert [event.data for event in plans] == [
                {"plan": [{"step": "Inspect", "status": "in_progress"},
                          {"step": "Implement", "status": "pending"}]},
                {"plan": [{"step": "Inspect", "status": "completed"},
                          {"step": "Implement", "status": "in_progress"}]},
            ]
            stored = adapter._store.read_events(result.session_id)
            assert sum(event["type"] == "plan_update" for event in stored) == 2
            cards = [item for item in timeline_from_events(stored) if item["type"] == "plan"]
            assert len(cards) == 1
            assert cards[0]["steps"] == [
                {"label": "Inspect", "status": "done"},
                {"label": "Implement", "status": "running"},
            ]
            if live:
                updates = [event for event in received if event.type == "plan_update"]
                assert len(updates) == 2
                assert updates[0].data["timeline_id"] == updates[1].data["timeline_id"]
                assert updates[0].data["timeline_id"] == cards[0]["id"]
                state = {}
                first = stream_event_item(updates[0], state)
                second = stream_event_item(updates[1], state)
                assert first[0]["item"]["id"] == second[0]["item"]["id"]
                assert second[0]["item"]["steps"] == cards[0]["steps"]
        finally:
            await adapter.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize("tool_input,expected_plan", [
    ({}, None),
    ({"todos": None}, None),
    ({"todos": "Inspect"}, None),
    ({"todos": []}, []),
    ({"todos": [None, "invalid", {"content": "Inspect", "status": "pending"}]},
     [{"step": "Inspect", "status": "pending"}]),
])
def test_todowrite_handles_empty_and_malformed_todos(tool_input, expected_plan):
    block = ToolUseBlock(id="todo-1", name="TodoWrite", input=tool_input)

    class Client:
        query = AsyncMock()

        async def receive_response(self):
            yield AssistantMessage(content=[block], model="test")
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1, session_id="native", result="done")

    provider = ClaudeProvider()
    provider._sessions["session"] = _ClaudeRuntime(Client(), SessionOptions(), ".")
    received = []
    turn = asyncio.run(provider.prompt("session", "test", received.append))
    assert [event.type for event in turn.events] == (
        ["tool_call"] if expected_plan is None else ["tool_call", "plan_update"]
    )
    assert received[0].data == asdict(block)
    if expected_plan is not None:
        assert received[1].data == {"plan": expected_plan}
    assert turn.events == tuple(received)
