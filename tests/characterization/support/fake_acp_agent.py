"""Scripted ACP agent process for characterization tests.

Cleo starts this file through an ordinary ``type: acp`` harness entry, so the real ACP
provider, desktop approvals, timeline projection, Git change tracking and persistence all
run unchanged. Behaviour is selected by markers in the user's request:

- default         thought + ``ACP reply: <request>``
- ``[[tool]]``     one read tool call that completes with text output
- ``[[write]]``    writes ``notes.txt`` through ``fs/write_text_file`` and reports a diff
- ``[[plan]]``     publishes a two-step plan
- ``[[permission]]`` asks for permission and reports the selected outcome
- ``[[slow]]``     streams one chunk and waits until the client cancels
- ``[[delay]]``    waits ~1.5 s, then answers normally
- ``[[refuse]]``   ends the turn with ``stopReason: refusal``

When ``CHAR_ACP_LOG`` is set, every session and prompt request is appended to that file as
JSON lines, so tests can pin exactly what Cleo hands to a harness.

Notifications are paced (``CHAR_ACP_PACE`` seconds, default 0.1) like a model-backed agent.
Cleo v0.7.1 handles each ACP ``session/update`` in its own task, so a burst of updates has
no ordering guarantee (docs/refactor/CHARACTERIZATION_TESTS.md, Q11). Pacing keeps the
snapshots clear of that window without changing the backend.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
from typing import Any

from acp import (
    PROTOCOL_VERSION,
    InitializeResponse,
    LoadSessionResponse,
    NewSessionResponse,
    PromptResponse,
    SetSessionConfigOptionResponse,
    plan_entry,
    run_agent,
    start_tool_call,
    text_block,
    tool_content,
    tool_diff_content,
    update_agent_message_text,
    update_agent_thought_text,
    update_plan,
    update_tool_call,
)
from acp.schema import (
    AgentCapabilities,
    PermissionOption,
    SessionConfigOptionSelect,
    SessionConfigSelectOption,
    ToolCallUpdate,
)

REQUEST_MARKER = "Current user request:\n"
PACE = float(os.environ.get("CHAR_ACP_PACE", "0.1"))


def _log(entry: dict[str, Any]) -> None:
    path = os.environ.get("CHAR_ACP_LOG")
    if path:
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")


def _servers(mcp_servers: Any) -> list[Any]:
    return [server.model_dump(mode="json", by_alias=True, exclude_none=True)
            if hasattr(server, "model_dump") else server for server in mcp_servers or []]


def _request_text(prompt: list[Any]) -> str:
    text = "".join(getattr(block, "text", "") or "" for block in prompt)
    return text.rsplit(REQUEST_MARKER, 1)[-1].strip()


class ScriptedAgent:
    def __init__(self) -> None:
        self._conn: Any = None
        self._ids = itertools.count(1)
        self._options = {"model": "fake-model-a", "effort": "high"}
        self._cancelled: dict[str, asyncio.Event] = {}

    def on_connect(self, conn: Any) -> None:
        self._conn = conn

    def _config(self) -> list[SessionConfigOptionSelect]:
        return [
            SessionConfigOptionSelect(
                id="model", name="Model", category="model", type="select",
                current_value=self._options["model"],
                options=[
                    SessionConfigSelectOption(value="fake-model-a", name="Fake Model A",
                                              description="Default scripted model"),
                    SessionConfigSelectOption(value="fake-model-b", name="Fake Model B",
                                              description="Alternate scripted model"),
                ],
            ),
            SessionConfigOptionSelect(
                id="effort", name="Effort", category="thought_level", type="select",
                current_value=self._options["effort"],
                options=[
                    SessionConfigSelectOption(value="low", name="Low"),
                    SessionConfigSelectOption(value="high", name="High"),
                ],
            ),
        ]

    async def initialize(self, protocol_version: int, **_kwargs: Any) -> InitializeResponse:
        return InitializeResponse(
            protocol_version=PROTOCOL_VERSION,
            agent_capabilities=AgentCapabilities(load_session=True),
        )

    async def authenticate(self, method_id: str, **_kwargs: Any) -> None:
        return None

    async def new_session(self, cwd: str, mcp_servers: Any = None,
                          **_kwargs: Any) -> NewSessionResponse:
        _log({"method": "session/new", "cwd": cwd, "mcp_servers": _servers(mcp_servers)})
        return NewSessionResponse(session_id=f"acp-session-{next(self._ids)}",
                                  config_options=self._config())

    async def load_session(self, cwd: str, session_id: str, mcp_servers: Any = None,
                           **_kwargs: Any) -> LoadSessionResponse:
        _log({"method": "session/load", "cwd": cwd, "session_id": session_id,
              "mcp_servers": _servers(mcp_servers)})
        return LoadSessionResponse(config_options=self._config())

    async def set_config_option(self, config_id: str, session_id: str, value: Any,
                                **_kwargs: Any) -> SetSessionConfigOptionResponse:
        self._options[config_id] = str(value)
        return SetSessionConfigOptionResponse(config_options=self._config())

    async def cancel(self, session_id: str, **_kwargs: Any) -> None:
        self._cancelled.setdefault(session_id, asyncio.Event()).set()

    async def _send(self, session_id: str, update: Any) -> None:
        await self._conn.session_update(session_id=session_id, update=update)
        await asyncio.sleep(PACE)

    async def prompt(self, session_id: str, prompt: list[Any], **_kwargs: Any) -> PromptResponse:
        request = _request_text(prompt)
        _log({"method": "session/prompt", "session_id": session_id,
              "text": "".join(getattr(block, "text", "") or "" for block in prompt)})
        cancelled = self._cancelled[session_id] = asyncio.Event()
        await self._send(session_id, update_agent_thought_text("Thinking about the request."))
        if "[[plan]]" in request:
            await self._send(session_id, update_plan([
                plan_entry("Inspect the workspace", status="completed"),
                plan_entry("Write the answer", status="in_progress"),
            ]))
        if "[[tool]]" in request:
            await self._send(session_id, start_tool_call(
                "tool-read-1", "Read README.md", kind="read", status="in_progress",
                raw_input={"path": "README.md"},
            ))
            await self._send(session_id, update_tool_call(
                "tool-read-1", status="completed",
                content=[tool_content(text_block("# Fixture workspace"))],
                raw_output={"lines": 1},
            ))
        if "[[write]]" in request:
            await self._send(session_id, start_tool_call(
                "tool-write-1", "Write notes.txt", kind="edit", status="in_progress",
                raw_input={"path": "notes.txt"},
            ))
            await self._conn.write_text_file(session_id=session_id, path="notes.txt",
                                             content="scripted note\n")
            await self._send(session_id, update_tool_call(
                "tool-write-1", status="completed",
                content=[tool_diff_content("notes.txt", "scripted note\n")],
            ))
        outcome = None
        if "[[permission]]" in request:
            response = await self._conn.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(tool_call_id="tool-perm-1", title="Run fixture command",
                                         raw_input={"command": "fixture --check"}),
                options=[
                    PermissionOption(option_id="allow", name="Allow once", kind="allow_once"),
                    PermissionOption(option_id="reject", name="Reject", kind="reject_once"),
                ],
            )
            selected = response.outcome
            outcome = getattr(selected, "option_id", None) or getattr(selected, "outcome", None)
        if "[[slow]]" in request:
            await self._send(session_id, update_agent_message_text("Working"))
            try:
                await asyncio.wait_for(cancelled.wait(), timeout=60)
            except TimeoutError:
                pass
            return PromptResponse(stop_reason="cancelled")
        if "[[delay]]" in request:
            await asyncio.sleep(1.5)
        if "[[refuse]]" in request:
            await self._send(session_id, update_agent_message_text("I cannot do that."))
            return PromptResponse(stop_reason="refusal")
        answer = f"ACP reply: {request}"
        if outcome is not None:
            answer += f" (permission: {outcome})"
        await self._send(session_id, update_agent_message_text(answer))
        return PromptResponse(stop_reason="end_turn")


def main() -> None:
    asyncio.run(run_agent(ScriptedAgent()))


if __name__ == "__main__":
    main()
