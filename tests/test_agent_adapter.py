from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from acp import update_agent_message_text

from core.integrations.agent_adapter import (
    AgentAdapter,
    AgentEvent,
    ProviderSession,
    ProviderTurn,
)
from core.integrations.agent_adapter.acp import _AcpClientHost
from core.integrations.agent_adapter.codex import CodexProvider, _CodexRuntime
from core.memory.compaction import load_validated_compact


class FakeProvider:
    name = "fake"

    def __init__(self) -> None:
        self.cancelled: list[str] = []
        self.closed: list[str] = []

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        assert model == "test-model"
        return ProviderSession(id="provider-session", native_id="native-session")

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        return ProviderSession(id="provider-resumed", native_id=native_session_id)

    async def prompt(self, session_id, prompt, on_event=None) -> ProviderTurn:
        event = AgentEvent(provider=self.name, type="agent_message", text=prompt)
        tool_event = AgentEvent(
            provider=self.name,
            type="tool_call",
            data={"name": "read_file", "path": "README.md"},
        )
        future_event = AgentEvent(
            provider=self.name,
            type="future_protocol_event",
            data={"new_field": True},
        )
        if on_event is not None:
            result = on_event(event)
            if asyncio.iscoroutine(result):
                await result
        return ProviderTurn(
            native_session_id="native-session",
            turn_id="turn-1",
            status="completed",
            response=f"done:{prompt}",
            events=(event, tool_event, future_event),
        )

    async def cancel(self, session_id: str) -> None:
        self.cancelled.append(session_id)

    async def close(self, session_id: str) -> None:
        self.closed.append(session_id)


def test_agent_adapter_routes_provider_sessions(tmp_path) -> None:
    provider = FakeProvider()
    adapter = AgentAdapter(tmp_path)
    adapter.register(provider)
    received: list[AgentEvent] = []

    async def exercise() -> None:
        result = await adapter.run(
            "fake",
            "hello",
            project_path=".",
            model="test-model",
            on_event=received.append,
        )
        assert result.session_id.startswith("agent_")
        assert result.native_session_id == "native-session"
        assert result.response == "done:hello"
        assert received[0].text == "hello"
        payload = load_validated_compact(
            memory_root=tmp_path / "memory",
            space="productivity",
            project=tmp_path.name,
            session_id=result.session_id,
        )
        assert any(event["type"] == "tool_call" for event in payload["events"])
        fallback = next(
            event for event in payload["events"] if event["type"] == "provider_event"
        )
        assert fallback["data"]["provider_event_type"] == "future_protocol_event"
        assert fallback["data"]["payload"] == {"new_field": True}

        await adapter.cancel(result.session_id)
        await adapter.close(result.session_id)

    asyncio.run(exercise())
    assert provider.cancelled == ["provider-session"]
    assert provider.closed == ["provider-session"]


def test_agent_adapter_can_resume_native_session(tmp_path) -> None:
    adapter = AgentAdapter(tmp_path)
    adapter.register(FakeProvider())

    async def exercise() -> None:
        session = await adapter.resume_session("fake", "saved-session")
        assert session.native_session_id == "saved-session"
        result = await adapter.prompt(session.id, "continue")
        assert result.response == "done:continue"

    asyncio.run(exercise())


def test_acp_host_streams_events_and_scopes_file_access(tmp_path) -> None:
    host = _AcpClientHost("native-acp", str(tmp_path), auto_approve=False)
    received: list[AgentEvent] = []

    async def exercise() -> None:
        host.begin_turn(received.append)
        await host.session_update("session-1", update_agent_message_text("hello"))
        target = tmp_path / "notes.txt"
        await host.write_text_file("session-1", str(target), "one\ntwo\n")
        content = await host.read_text_file("session-1", str(target), line=2, limit=1)
        assert content.content == "two\n"

        with pytest.raises(PermissionError):
            await host.write_text_file(
                "session-1",
                str(tmp_path.parent / "outside.txt"),
                "blocked",
            )

    asyncio.run(exercise())
    assert host.response_parts == ["hello"]
    assert received[0].provider == "native-acp"
    assert received[0].type == "assistant_message_chunk"
    assert received[0].data["provider_event_type"] == "agent_message_chunk"


def test_codex_provider_streams_new_sdk_notifications() -> None:
    class Payload:
        def __init__(self, data):
            self.data = data

        def model_dump(self, **_kwargs):
            return self.data

    class FakeTurn:
        id = "turn-1"

        async def stream(self):
            yield SimpleNamespace(
                method="item/agentMessage/delta",
                payload=Payload({"delta": "hello", "turnId": self.id}),
            )
            yield SimpleNamespace(
                method="item/started",
                payload=Payload(
                    {
                        "turnId": self.id,
                        "item": {
                            "type": "commandExecution",
                            "id": "tool-1",
                            "command": "git status",
                        },
                    }
                ),
            )
            yield SimpleNamespace(
                method="thread/tokenUsage/updated",
                payload=Payload(
                    {
                        "threadId": "codex-thread-1",
                        "turnId": self.id,
                        "tokenUsage": {
                            "total": {
                                "cachedInputTokens": 0,
                                "inputTokens": 800,
                                "outputTokens": 200,
                                "reasoningOutputTokens": 0,
                                "totalTokens": 1000,
                            },
                            "last": {
                                "cachedInputTokens": 0,
                                "inputTokens": 800,
                                "outputTokens": 200,
                                "reasoningOutputTokens": 0,
                                "totalTokens": 1000,
                            },
                            "modelContextWindow": 200000,
                        },
                    }
                ),
            )
            yield SimpleNamespace(
                method="item/completed",
                payload=Payload(
                    {
                        "turnId": self.id,
                        "item": {
                            "type": "agentMessage",
                            "id": "message-1",
                            "phase": "final_answer",
                            "text": "hello world",
                        },
                    }
                ),
            )
            yield SimpleNamespace(
                method="turn/completed",
                payload=Payload({"turn": {"id": self.id, "status": "completed"}}),
            )

        async def interrupt(self):
            return None

    class FakeThread:
        id = "codex-thread-1"

        async def turn(self, *_args, **_kwargs):
            return FakeTurn()

    provider = CodexProvider(default_model="test-model")
    provider._sessions["session-1"] = _CodexRuntime(
        client=SimpleNamespace(),
        thread=FakeThread(),
    )
    received: list[AgentEvent] = []

    result = asyncio.run(provider.prompt("session-1", "hello", received.append))

    assert result.status == "completed"
    assert result.response == "hello world"
    assert received[0].type == "assistant_message_chunk"
    assert received[0].text == "hello"
    assert received[1].type == "tool_call"
    assert received[1].data["provider_event_type"] == "item/started"
    assert received[2].type == "status"
    assert received[2].data["provider_event_type"] == "thread/tokenUsage/updated"
