"""Exercise the harness use case through its ports without local persistence."""

import asyncio
import inspect
import os
from unittest.mock import create_autospec

import pytest

from cleo.harnesses.adapter import AgentAdapter
from cleo.harnesses.models import AgentEvent
from cleo.harnesses.provider import AgentProvider, ProviderSession, ProviderTurn
from cleo.harnesses.service import AgentService
from cleo.sessions.ports import SessionRepository
from cleo.sessions.store import SessionStore


@pytest.mark.parametrize("service_type", [AgentService, AgentAdapter])
def test_harness_turn_uses_injected_ports(tmp_path, service_type) -> None:
    repository = create_autospec(SessionRepository, instance=True, spec_set=True)
    repository.load_manifest.side_effect = FileNotFoundError("new session")
    provider = create_autospec(AgentProvider, instance=True)
    provider.name = "test-provider"
    provider.create_session.return_value = ProviderSession("provider-session", "native-session")
    event = AgentEvent(provider=provider.name, type="tool_call", text="read README")
    provider.prompt.return_value = ProviderTurn(
        native_session_id="native-session",
        turn_id="turn-1",
        status="completed",
        response="done",
        events=(event,),
    )
    service = service_type(tmp_path, session_store=repository)
    service.register(provider)

    result = asyncio.run(service.run(provider.name, "hello", model="test-model"))

    assert result.response == "done"
    assert result.native_session_id == "native-session"
    provider.prompt.assert_awaited_once_with("provider-session", "hello", None)
    repository.create_session.assert_called_once_with(
        session_id=result.session_id,
        space="productivity",
        project=tmp_path.name,
        provider=provider.name,
        owner_type="agent",
        native_session_id="native-session",
        cwd=os.path.normcase(str(tmp_path.resolve())),
        parent_session_id=None,
    )
    batches = repository.append_events.call_args_list
    assert [item["type"] for item in batches[0].kwargs["events"]] == [
        "user_message", "session_running",
    ]
    assert [item["type"] for item in batches[1].kwargs["events"]] == [
        "tool_call", "assistant_message", "session_completed",
    ]
    assert batches[1].kwargs["manifest_updates"] == {
        "status": "completed", "native_session_id": "native-session", "error": None,
    }
    repository.refresh_compact.assert_called_once_with(result.session_id)
    assert list(tmp_path.iterdir()) == []


def test_local_store_matches_repository_signatures() -> None:
    """Keep the concrete adapter compatible when either side of the port changes."""
    for name, method in vars(SessionRepository).items():
        if name.startswith("_") or not callable(method):
            continue
        assert inspect.signature(getattr(SessionStore, name)) == inspect.signature(method), name
