"""Q11: provider callbacks that run concurrently are still logged and shown in order."""

from __future__ import annotations

import asyncio
import time

from cleo.harnesses.models import AgentEvent
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.harnesses.service import AgentService
from cleo.sessions.store import SessionStore

TOOL_EVENTS = ("tool_call", "tool_result")


class ConcurrentProvider:
    """Calls back from one task per update, as the ACP client does for notifications."""

    name = "concurrent"

    async def create_session(self, project_path: str, model: str | None = None):
        return ProviderSession(id="provider-session", native_id="native")

    async def prompt(self, session_id, prompt, on_event=None):
        events = (
            AgentEvent(provider=self.name, type="tool_call",
                       data={"payload": {"toolCallId": "t1", "status": "in_progress"}}),
            AgentEvent(provider=self.name, type="tool_result",
                       data={"payload": {"toolCallId": "t1", "status": "completed"}}),
        )
        await asyncio.gather(*(on_event(event) for event in events))
        return ProviderTurn(native_session_id="native", turn_id="turn", status="completed",
                            response="done", events=events)


def test_concurrent_callbacks_keep_their_arrival_order(tmp_path) -> None:
    store = SessionStore(tmp_path / "memory")
    append = store.append_events

    def slow_first_write(**kwargs):
        # The "running" update takes longer to persist than the "completed" one behind it.
        if any(event.get("type") == "tool_call" for event in kwargs["events"]):
            time.sleep(0.2)
        return append(**kwargs)

    store.append_events = slow_first_write
    service = AgentService(tmp_path, session_store=store)
    service.register(ConcurrentProvider())
    shown: list[str] = []

    async def on_event(event):
        shown.append(event.type)

    async def scenario():
        session = await service.create_session("concurrent", project_path=str(tmp_path))
        result = await service.prompt(session.id, "go", on_event)
        return session.id, result

    session_id, result = asyncio.run(scenario())
    logged = [event["type"] for event in store.read_events(session_id)]

    assert result.status == "completed"
    assert [kind for kind in logged if kind in TOOL_EVENTS] == list(TOOL_EVENTS)
    assert [kind for kind in shown if kind in TOOL_EVENTS] == list(TOOL_EVENTS)
    # The terminal event follows every live event.
    assert logged.index("session_completed") > logged.index("tool_result")
