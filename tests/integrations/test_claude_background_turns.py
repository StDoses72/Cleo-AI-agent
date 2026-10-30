"""A Claude turn outlives its first ResultMessage while native background tasks still run.

The frame sequences below mirror what Claude Code 2.1.310 / claude-agent-sdk 0.2.174 emitted
in a real run for ``Bash(run_in_background=True)``: a stage result, then ``task_updated`` /
``task_notification`` / ``background_tasks_changed`` frames, then a second ``init`` and the
wake-up turn whose result carries ``origin.kind == "task-notification"``.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from cleo.desktop.projection import timeline_from_events
from cleo.harnesses.control import SessionOptions
from cleo.harnesses.service import AgentService
from cleo.integrations.harnesses.claude import (
    BACKGROUND_WAIT_ENV,
    ClaudeProvider,
    _ClaudeRuntime,
)
from cleo.sessions.store import SessionStore

TASK = {"task_id": "bg-1", "run_id": "run-1", "task_type": "local_bash",
        "description": "Sleep then echo"}


def _result(text, **extra):
    return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                         num_turns=1, session_id="native", result=text, **extra)


def _system(subtype, **data):
    return SystemMessage(subtype=subtype, data={"type": "system", "subtype": subtype, **data})


def stage_one():
    return [
        AssistantMessage(content=[ToolUseBlock(id="tool-1", name="Bash", input={
            "command": "sleep 8 && echo BG_DONE", "run_in_background": True})], model="test"),
        _system("background_tasks_changed", tasks=[TASK]),
        _system("task_started", **TASK, tool_use_id="tool-1", is_backgrounded=True),
        UserMessage(content=[ToolResultBlock(
            tool_use_id="tool-1", content="Command running in background with ID: bg-1")]),
        AssistantMessage(content=[TextBlock(text="STAGE1: started")], model="test"),
        _result("STAGE1: started"),
    ]


def wake_up():
    return [
        _system("task_updated", task_id="bg-1", run_id="run-1", patch={"status": "completed"}),
        _system("task_notification", task_id="bg-1", run_id="run-1", tool_use_id="tool-1",
                status="completed", output_file="bg-1.output",
                summary='Background command "Sleep then echo" completed'),
        _system("background_tasks_changed", tasks=[]),
        _system("init", session_id="native"),
        AssistantMessage(content=[TextBlock(text="STAGE2: BG_DONE")], model="test"),
        _result("STAGE2: BG_DONE"),
    ]


class Client:
    """SDK client fake: sections of frames, optionally holding the stream open between them."""

    def __init__(self, *sections, hold_after_first=False):
        self.sections = sections
        self.hold_after_first = hold_after_first
        self.queries = []
        self.disconnected = 0
        self.interrupted = 0
        self.closed = asyncio.Event()
        self.holding = asyncio.Event()

    async def query(self, prompt):
        self.queries.append(prompt)

    async def interrupt(self):
        self.interrupted += 1

    async def disconnect(self):
        self.disconnected += 1
        self.closed.set()

    async def receive_messages(self):
        for index, section in enumerate(self.sections):
            for frame in section:
                if self.closed.is_set():
                    return
                yield frame
            if index == 0 and self.hold_after_first:
                self.holding.set()
                await self.closed.wait()
                return


def _provider(client, cwd="."):
    provider = ClaudeProvider()
    provider._sessions["s"] = _ClaudeRuntime(client, SessionOptions(), cwd)
    return provider, provider._sessions["s"]


def test_background_wake_up_turn_belongs_to_the_same_prompt():
    client = Client(stage_one(), wake_up())
    provider, runtime = _provider(client)
    received = []

    turn = asyncio.run(provider.prompt("s", "run it", received.append))

    assert client.queries == ["run it"], "the wake-up turn needs no second user prompt"
    assert turn.status == "completed"
    assert turn.response == "STAGE2: BG_DONE"
    assert [event.type for event in received] == [
        "tool_call", "tool_call", "tool_result", "agent_message",
        "status", "tool_result", "agent_message",
    ]
    assert [event.text for event in received if event.type == "agent_message"] == [
        "STAGE1: started", "STAGE2: BG_DONE",
    ]
    background_call = received[1].data
    assert background_call["id"] == "bg-1"
    assert background_call["input"] == "Sleep then echo"
    assert background_call["provider_event_type"] == "task_started"
    stage = received[4].data
    assert stage["provider_event_type"] == "claude/stage_completed"
    assert stage["payload"]["stage"] == 1
    assert stage["payload"]["result"] == "STAGE1: started"
    assert stage["payload"]["tasks"][0]["id"] == "bg-1"
    finished = received[5].data
    assert finished["tool_use_id"] == "bg-1"
    assert finished["status"] == "completed"
    assert "completed" in finished["output"]
    assert turn.events == tuple(received)
    assert client.disconnected == 0
    assert not runtime.needs_reconnect
    assert not runtime.background and not runtime.waiting


def test_plain_turn_still_ends_at_its_first_result():
    client = Client([AssistantMessage(content=[TextBlock(text="done")], model="test"),
                     _result("done")])
    provider, runtime = _provider(client)

    turn = asyncio.run(provider.prompt("s", "hello"))

    assert turn.status == "completed" and turn.response == "done"
    assert client.disconnected == 0 and not runtime.needs_reconnect


def test_cancel_while_waiting_ends_the_turn_and_drops_the_stream():
    async def scenario():
        client = Client(stage_one(), hold_after_first=True)
        provider, runtime = _provider(client)
        received = []
        task = asyncio.create_task(provider.prompt("s", "run it", received.append))
        await asyncio.wait_for(client.holding.wait(), 1)
        assert runtime.waiting and runtime.background

        await provider.cancel("s")
        turn = await asyncio.wait_for(task, 1)

        assert turn.status == "cancelled" and turn.response is None
        assert client.interrupted == 0, "nothing was running; only the idle stream was dropped"
        assert client.disconnected == 1
        assert runtime.needs_reconnect, "a later prompt must not read the pending wake-up"
        assert [event.type for event in received[-2:]] == ["tool_result", "status"]
        assert received[-2].data["tool_use_id"] == "bg-1"
        assert received[-2].data["status"] == "failed"
        assert received[-1].data["provider_event_type"] == "claude/background_abandoned"
        assert not runtime.active

    asyncio.run(scenario())


def test_cancel_during_the_wake_up_turn_still_interrupts(monkeypatch):
    async def scenario():
        started = asyncio.Event()

        class Live(Client):
            async def receive_messages(self):
                for frame in stage_one():
                    yield frame
                yield _system("task_notification", task_id="bg-1", run_id="run-1",
                              status="completed", output_file="f", summary="done")
                yield _system("init", session_id="native")
                yield AssistantMessage(content=[TextBlock(text="working...")], model="test")
                started.set()
                await self.closed.wait()
                yield _result("Stopped", stop_reason="cancelled")

        client = Live()
        provider, runtime = _provider(client)

        async def interrupt():
            client.interrupted += 1
            client.closed.set()

        client.interrupt = interrupt
        task = asyncio.create_task(provider.prompt("s", "run it"))
        await asyncio.wait_for(started.wait(), 1)
        assert not runtime.waiting
        await provider.cancel("s")
        turn = await asyncio.wait_for(task, 1)
        assert turn.status == "cancelled"
        assert client.interrupted == 1

    asyncio.run(scenario())


@pytest.mark.parametrize("ceiling", ["0.2", "0"])
def test_wait_ceiling_ends_the_turn_and_disconnects_leftover_tasks(monkeypatch, ceiling):
    monkeypatch.setenv(BACKGROUND_WAIT_ENV, ceiling)
    client = Client(stage_one(), hold_after_first=True)
    provider, runtime = _provider(client)
    received = []

    turn = asyncio.run(asyncio.wait_for(provider.prompt("s", "run it", received.append), 3))

    assert turn.status == "completed"
    assert turn.response == "STAGE1: started", "the stage reply is the final reply"
    assert client.disconnected == 1 and runtime.needs_reconnect
    assert [event.type for event in received[-2:]] == ["tool_result", "status"]
    assert received[-2].data["tool_use_id"] == "bg-1" and received[-2].data["status"] == "failed"
    assert received[-1].data["provider_event_type"] == "claude/background_abandoned"


def test_questions_stay_answerable_in_the_wake_up_turn(tmp_path, monkeypatch):
    clients = []
    question = {"questions": [{"question": "Deploy where?", "options": [{"label": "staging"}]}]}

    class SdkClient(Client):
        def __init__(self, options):
            super().__init__()
            self.options = options
            self.answer = None
            clients.append(self)

        async def connect(self):
            pass

        async def receive_messages(self):
            for frame in stage_one():
                yield frame
            yield _system("task_notification", task_id="bg-1", run_id="run-1",
                          status="completed", output_file="f", summary="done")
            yield _system("init", session_id="native")
            yield AssistantMessage(content=[ToolUseBlock(
                id="ask", name="AskUserQuestion", input=question)], model="test")
            self.answer = await self.options.can_use_tool(
                "AskUserQuestion", question, SimpleNamespace(tool_use_id="ask"),
            )
            yield AssistantMessage(content=[TextBlock(text="FINAL: staging")], model="test")
            yield _result("FINAL: staging")

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", SdkClient)

    async def scenario():
        provider = ClaudeProvider()
        session = await provider.create_session(str(tmp_path))
        await provider.enable_questions(session.id)
        events = asyncio.Queue()
        task = asyncio.create_task(provider.prompt(session.id, "deploy", events.put))
        request = None
        while request is None:
            event = await asyncio.wait_for(events.get(), 2)
            if event.type == "question_request":
                request = event
        assert not task.done(), "a question after a stage result must not end the turn"
        assert provider.pending_questions(session.id)[0]["id"] == request.data["id"]
        await provider.resolve_question(session.id, request.data["id"], {"0": ["staging"]})
        turn = await asyncio.wait_for(task, 2)
        assert turn.response == "FINAL: staging"
        assert isinstance(clients[0].answer, PermissionResultAllow)
        assert clients[0].answer.updated_input["answers"] == {"Deploy where?": "staging"}
        await provider.close(session.id)

    asyncio.run(scenario())


def test_service_persists_every_stage_once_in_arrival_order(tmp_path, monkeypatch):
    store = SessionStore(tmp_path / "memory")
    service = AgentService(tmp_path, session_store=store)
    provider = ClaudeProvider()
    client = Client(stage_one(), wake_up())
    monkeypatch.setattr(provider, "_connect", AsyncMock(
        return_value=_ClaudeRuntime(client, SessionOptions(), str(tmp_path)),
    ))
    service.register(provider)

    async def scenario():
        session = await service.create_session("claude", str(tmp_path))
        live = []
        result = await service.prompt(session.id, "run it", on_event=live.append)
        assert result.status == "completed" and result.response == "STAGE2: BG_DONE"
        events = store.read_events(session.id)
        # The final answer is re-recorded under the live message's timeline id (an upsert);
        # distinct timeline ids therefore tell stage replies apart.
        replies = {}
        for event in events:
            if event["type"] == "assistant_message":
                key = (event.get("data") or {}).get("timeline_id") or event["id"]
                replies.setdefault(key, event["content"])
        assert list(replies.values()) == [
            "STAGE1: started", "STAGE2: BG_DONE",
        ], "both stage replies are stored once each, in arrival order"
        assert [e["type"] for e in events if e["type"].startswith("session_")] == [
            "session_created", "session_running", "session_completed",
        ], "the stage boundary is not a session end"
        assert [e["type"] for e in events if e["type"] == "status"], "stage boundary persisted"
        turn_ids = {(e.get("data") or {}).get("turn_id") for e in events
                    if e["type"] in {"assistant_message", "tool_call", "tool_result", "status"}}
        turn_ids.discard(None)
        assert len(turn_ids) == 1, "the wake-up reply is attributed to the original prompt"
        items = timeline_from_events(events)
        assistant = [i["content"] for i in items if i["type"] == "message"
                     and i.get("role") == "assistant"]
        assert assistant == ["STAGE1: started", "STAGE2: BG_DONE"]
        background = [i for i in items if i["type"] == "tool" and i["name"] != "Bash"]
        assert len(background) == 1
        assert background[0]["status"] == "done"
        assert background[0]["command"] == "Sleep then echo"
        assert "completed" in background[0]["output"]
        assert store.load_manifest(session.id)["status"] == "completed"

    asyncio.run(scenario())
