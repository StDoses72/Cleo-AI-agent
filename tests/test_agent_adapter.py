from __future__ import annotations

import asyncio

import pytest
from acp import update_agent_message_text

from core.integrations.agent_adapter import (
    AgentAdapter,
    AgentEvent,
    ProviderSession,
    ProviderTurn,
)
from core.integrations.agent_adapter.acp import _AcpClientHost


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
        if on_event is not None:
            result = on_event(event)
            if asyncio.iscoroutine(result):
                await result
        return ProviderTurn(
            native_session_id="native-session",
            turn_id="turn-1",
            status="completed",
            response=f"done:{prompt}",
            events=(event,),
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
