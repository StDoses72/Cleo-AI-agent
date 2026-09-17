import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from acp.schema import PermissionOption, ToolCallUpdate
from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    ToolPermissionContext,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from cleo.desktop.projection import stream_event_item, timeline_from_events
from cleo.harnesses.approvals import PermissionBroker
from cleo.harnesses.control import SessionOptions
from cleo.harnesses.service import AgentService
from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider, _AcpClientHost, _AcpRuntime
from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime


@pytest.mark.parametrize("decision", ["accept", "decline", "cancel"])
def test_claude_uses_native_callback_without_changing_inputs(tmp_path, monkeypatch, decision):
    connections = []

    class Client:
        def __init__(self, options):
            self.options = options
            connections.append(self)

        async def connect(self):
            pass

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)

    async def scenario():
        provider = ClaudeProvider(permission_mode="default")
        session = await provider.create_session(str(tmp_path))
        await provider.enable_user_approvals(session.id)
        runtime = provider._sessions[session.id]
        ready = asyncio.Event()
        events = []

        async def emit(event):
            events.append(event)
            if event.type == "permission_request":
                ready.set()

        runtime.approvals.callback = emit
        input_data = {"command": "test-command", "description": "isolated"}
        callback = connections[0].options.can_use_tool
        result_task = asyncio.create_task(callback(
            "Bash", input_data, ToolPermissionContext(tool_use_id="tool"),
        ))
        await asyncio.wait_for(ready.wait(), 1)
        request = events[0].data
        assert request["permissions"] == input_data
        assert request["availableDecisions"] == ["accept", "decline", "cancel"]
        await provider.resolve_approval(session.id, request["id"], decision)
        result = await asyncio.wait_for(result_task, 1)
        if decision == "accept":
            assert isinstance(result, PermissionResultAllow)
            assert result.updated_input == input_data
            assert result.updated_permissions is None
        else:
            assert isinstance(result, PermissionResultDeny)
            assert result.interrupt is (decision == "cancel")
        assert events[-1].data["source"] == "user"
        assert events[-1].data["request"]["command"] == "test-command"
        assert not runtime.approvals.pending
        assert runtime.options.approval_mode == "default"

    asyncio.run(scenario())


@pytest.mark.parametrize("mode,decision,option_id", [
    ("auto_allow", None, "allow"), ("deny_all", None, "reject"),
    ("user", "accept", "allow"), ("user", "acceptForSession", "always"),
    ("user", "decline", "reject"), ("user", "cancel", None),
])
def test_acp_resolves_native_options_and_records_decisions(tmp_path, mode, decision, option_id):
    async def scenario():
        provider = AcpProvider("acp", AcpAgentSpec(command="not-launched"))
        host = _AcpClientHost("acp", str(tmp_path), False)
        runtime = _AcpRuntime(SimpleNamespace(), SimpleNamespace(), host)
        provider._sessions["native"] = runtime
        await provider.enable_user_approvals("native")
        await provider.update_session_options("native", approval_mode=mode)
        assert provider.session_options("native").approval_mode == mode
        events = []
        ready = asyncio.Event()

        async def emit(event):
            events.append(event)
            if event.type == "permission_request":
                ready.set()

        host.begin_turn(emit)
        options = [
            PermissionOption(option_id="allow", name="Allow once", kind="allow_once"),
            PermissionOption(option_id="always", name="Always allow", kind="allow_always"),
            PermissionOption(option_id="reject", name="Reject once", kind="reject_once"),
        ]
        task = asyncio.create_task(host.request_permission(
            "native", ToolCallUpdate(tool_call_id="tool", title="test-command"), options,
        ))
        if decision:
            await asyncio.wait_for(ready.wait(), 1)
            request = events[0].data
            assert request["decisionLabels"]["acceptForSession"] == "Always allow"
            await provider.resolve_approval("native", request["id"], decision)
        result = await asyncio.wait_for(task, 1)
        if option_id:
            assert result.outcome.option_id == option_id
        else:
            assert result.outcome.outcome == "cancelled"
        assert events[-1].type == "permission_response"
        assert events[-1].data["source"] == ("user" if decision else "policy")
        assert events[-1].data["request"]["itemId"] == "tool"
        if not decision:
            assert [e.type for e in events] == ["permission_response"]
        await host.end_turn()
        late = await host.request_permission("native", None, options)
        assert late.outcome.outcome == "cancelled"

    asyncio.run(scenario())


def test_acp_unmatched_options_cancel_without_reporting_approval(tmp_path):
    async def scenario():
        host = _AcpClientHost("acp", str(tmp_path), True)
        events = []
        host.begin_turn(events.append)
        result = await host.request_permission("native", None, [
            PermissionOption(option_id="reject", name="Reject", kind="reject_once"),
        ])
        assert result.outcome.outcome == "cancelled"
        assert events[-1].data["decision"] == "cancel"
        await host.end_turn()
    asyncio.run(scenario())


def test_async_broker_duplicate_cancel_and_unavailable_paths():
    async def scenario():
        broker = PermissionBroker("test")
        events = []
        broker.callback = events.append
        request = broker.request(command="test-command")
        assert await broker.ask(request) == "cancel"
        assert events[-1].data["source"] == "unavailable"
        broker.enabled = True
        task = asyncio.create_task(broker.ask(request))
        await asyncio.sleep(0)
        await broker.cancel_all()
        assert await task == "cancel"
        assert events[-1].data["source"] == "lifecycle"
        with pytest.raises(ValueError, match="no longer pending"):
            await broker.resolve(request["id"], "accept")
        assert not broker.pending
    asyncio.run(scenario())


def test_async_broker_first_response_wins_while_recording():
    async def scenario():
        broker = PermissionBroker("test")
        broker.enabled = True
        recording = asyncio.Event()
        release = asyncio.Event()

        async def emit(event):
            if event.type == "permission_response":
                recording.set()
                await release.wait()

        broker.callback = emit
        request = broker.request()
        ask = asyncio.create_task(broker.ask(request))
        await asyncio.sleep(0)
        first = asyncio.create_task(broker.resolve(request["id"], "accept"))
        try:
            await asyncio.wait_for(recording.wait(), 1)
            with pytest.raises(ValueError, match="no longer pending"):
                await broker.resolve(request["id"], "decline")
            await broker.cancel_all()
        finally:
            release.set()
            await first
        assert await asyncio.wait_for(ask, 1) == "accept"
    asyncio.run(scenario())


def test_async_broker_keeps_a_decision_when_the_ui_stream_closes():
    async def scenario():
        broker = PermissionBroker("test")
        broker.enabled = True

        async def emit(event):
            if event.type == "permission_request":
                await broker.resolve(event.data["id"], "accept")
                raise ConnectionError("UI disconnected after deciding")

        broker.callback = emit
        assert await broker.ask(broker.request()) == "accept"
        assert not broker.pending
    asyncio.run(scenario())


@pytest.mark.parametrize("failed", [False, True])
def test_claude_result_and_policy_are_truthful_live_and_after_reload(tmp_path, failed):
    class Client:
        query = AsyncMock()

        async def receive_response(self):
            yield AssistantMessage(content=[ToolUseBlock(id="tool", name="Read", input={})],
                                   model="test")
            yield UserMessage(content=[ToolResultBlock(
                tool_use_id="tool", content="native tool output", is_error=failed,
            )])
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1, session_id="native", result="done")

    async def scenario():
        provider = ClaudeProvider()
        provider._sessions["session"] = _ClaudeRuntime(
            Client(), SessionOptions(approval_mode="auto"), str(tmp_path),
        )
        turn = await provider.prompt("session", "test")
        state = {}
        for event in turn.events:
            stream_event_item(event, state)
        tools = [value for key, value in state.items() if key.startswith("tool:")]
        assert len(tools) == 1
        stored = timeline_from_events([AgentService._stored_provider_event(e) for e in turn.events])
        for item in (tools[0], stored[0]):
            assert item["output"] == "native tool output"
            assert item["status"] == ("error" if failed else "done")
            if failed:
                assert "permission" not in item
            else:
                assert item["permission"] == {
                    "source": "Claude 后端", "policy": "auto", "decision": "accept",
                }
    asyncio.run(scenario())
