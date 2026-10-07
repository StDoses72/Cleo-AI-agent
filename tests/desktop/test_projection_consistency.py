"""The live stream and a reloaded thread show the same tools and plans (Q2, Q3)."""

from __future__ import annotations

import asyncio

import pytest

from cleo.desktop.projection import finalize_stream_tools, stream_event_item, timeline_from_events
from cleo.harnesses.models import AgentEvent
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.harnesses.service import AgentService
from cleo.sessions.store import SessionStore

ACP_EVENTS = (
    AgentEvent(provider="acp", type="plan_update", data={"payload": {
        "sessionUpdate": "plan", "entries": [
            {"content": "Read the notes", "priority": "medium", "status": "completed"},
            {"content": "Write the summary", "priority": "medium", "status": "in_progress"},
        ]}}),
    AgentEvent(provider="acp", type="tool_call", data={"payload": {
        "sessionUpdate": "tool_call", "toolCallId": "read-1", "title": "Read README.md",
        "kind": "read", "status": "in_progress", "rawInput": {"path": "README.md"}}}),
    AgentEvent(provider="acp", type="tool_result", data={"payload": {
        "sessionUpdate": "tool_call_update", "toolCallId": "read-1", "status": "completed"}}),
    AgentEvent(provider="acp", type="tool_call", data={"payload": {
        "sessionUpdate": "tool_call", "toolCallId": "write-1", "title": "Write notes.txt",
        "kind": "edit", "status": "in_progress", "rawInput": {"path": "notes.txt"}}}),
    AgentEvent(provider="acp", type="tool_result", data={"payload": {
        "sessionUpdate": "tool_call_update", "toolCallId": "write-1", "status": "failed"}}),
)
CODEX_EVENTS = (
    AgentEvent(provider="codex", type="plan_update", data={"payload": {
        "plan": [{"step": "Inspect", "status": "completed"},
                 {"step": "Fix", "status": "pending"}]}}),
    AgentEvent(provider="codex", type="tool_call", data={"payload": {
        "item": {"id": "cmd-1", "tool": "shell", "command": "pytest -q"}}}),
    AgentEvent(provider="codex", type="tool_result", data={"payload": {
        "item": {"id": "cmd-1", "status": "completed", "output": "3 passed"}}}),
)


class ScriptedProvider:
    def __init__(self, name: str, events: tuple[AgentEvent, ...]) -> None:
        self.name = name
        self._events = events

    async def create_session(self, project_path: str, model: str | None = None):
        return ProviderSession(id="session", native_id="native")

    async def prompt(self, session_id, prompt, on_event=None):
        for event in self._events:
            await on_event(event)
        return ProviderTurn(native_session_id="native", turn_id="turn", status="completed",
                            response="done", events=self._events)


def _shown(items):
    tools = {item["id"]: (item["name"], item["command"], item["status"])
             for item in items if item["type"] == "tool"}
    plans = {item["id"]: item["steps"] for item in items if item["type"] == "plan"}
    return tools, plans


@pytest.mark.parametrize("provider", ["acp", "codex"])
def test_live_stream_and_reload_show_the_same_tools_and_plans(tmp_path, provider) -> None:
    events = ACP_EVENTS if provider == "acp" else CODEX_EVENTS
    store = SessionStore(tmp_path / "memory")
    service = AgentService(tmp_path, session_store=store)
    service.register(ScriptedProvider(provider, events))
    live: dict[str, dict] = {}
    state: dict = {}

    async def on_event(event):
        for projected in stream_event_item(event, state):
            if projected["type"] == "upsert-item":
                live[projected["item"]["id"]] = dict(projected["item"])

    async def scenario():
        session = await service.create_session(provider, project_path=str(tmp_path))
        await service.prompt(session.id, "go", on_event)
        return session.id

    session_id = asyncio.run(scenario())
    for projected in finalize_stream_tools(state):
        live[projected["item"]["id"]] = dict(projected["item"])
    reloaded = timeline_from_events(store.read_events(session_id))

    live_tools, live_plans = _shown(live.values())
    assert live_tools and live_plans
    assert _shown(reloaded) == (live_tools, live_plans)
    assert not [item for item in reloaded if item["id"].startswith("tool-result-")]
