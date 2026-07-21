from __future__ import annotations

import asyncio
import os
import secrets
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from acp import (
    PROTOCOL_VERSION,
    ReadTextFileResponse,
    RequestPermissionResponse,
    WriteTextFileResponse,
    spawn_agent_process,
    text_block,
)
from acp.schema import (
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    FileSystemCapabilities,
    Implementation,
)

from core.integrations.agent_adapter.models import AgentEvent, EventCallback, emit_event
from core.integrations.agent_adapter.provider import ProviderSession, ProviderTurn


@dataclass(frozen=True, slots=True)
class AcpAgentSpec:
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    auth_method: str | None = None
    auto_approve: bool = False
    model_config_id: str | None = None


class _AcpClientHost:
    def __init__(self, provider: str, project_path: str, auto_approve: bool) -> None:
        self._provider = provider
        self._root = Path(project_path).resolve()
        self._auto_approve = auto_approve
        self._callback: EventCallback | None = None
        self.events: list[AgentEvent] = []
        self.response_parts: list[str] = []

    def begin_turn(self, callback: EventCallback | None) -> None:
        self._callback = callback
        self.events.clear()
        self.response_parts.clear()

    async def session_update(self, session_id: str, update: Any, **_kwargs: Any) -> None:
        data = update.model_dump(by_alias=True, exclude_none=True)
        event_type = data.get("sessionUpdate", type(update).__name__)
        content = data.get("content") or {}
        text = content.get("text") if isinstance(content, dict) else None
        event = AgentEvent(provider=self._provider, type=event_type, text=text, data=data)
        self.events.append(event)
        if event_type == "agent_message_chunk" and text:
            self.response_parts.append(text)
        await emit_event(self._callback, event)

    async def request_permission(
        self,
        session_id: str,
        tool_call: Any,
        options: list[Any],
        **_kwargs: Any,
    ) -> RequestPermissionResponse:
        kinds = ("allow_once", "allow_always") if self._auto_approve else (
            "reject_once",
            "reject_always",
        )
        selected = next(
            (option for kind in kinds for option in options if option.kind == kind),
            None,
        )
        if selected is None:
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
        return RequestPermissionResponse(
            outcome=AllowedOutcome(outcome="selected", option_id=selected.option_id)
        )

    async def read_text_file(
        self,
        session_id: str,
        path: str,
        line: int | None = None,
        limit: int | None = None,
        **_kwargs: Any,
    ) -> ReadTextFileResponse:
        file_path = self._workspace_path(path)
        content = await asyncio.to_thread(file_path.read_text, encoding="utf-8")
        if line is not None or limit is not None:
            lines = content.splitlines(keepends=True)
            start = (line or 1) - 1
            content = "".join(lines[start:] if limit is None else lines[start : start + limit])
        return ReadTextFileResponse(content=content)

    async def write_text_file(
        self,
        session_id: str,
        path: str,
        content: str,
        **_kwargs: Any,
    ) -> WriteTextFileResponse:
        file_path = self._workspace_path(path)
        await asyncio.to_thread(file_path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(file_path.write_text, content, encoding="utf-8")
        return WriteTextFileResponse()

    def _workspace_path(self, value: str) -> Path:
        path = Path(value).resolve()
        if not path.is_relative_to(self._root):
            raise PermissionError(f"ACP file access is outside the project: {path}")
        return path


@dataclass(slots=True)
class _AcpRuntime:
    connection: Any
    manager: AbstractAsyncContextManager[Any]
    host: _AcpClientHost
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    active: bool = False


class AcpProvider:
    def __init__(self, name: str, spec: AcpAgentSpec) -> None:
        self.name = name
        self._spec = spec
        self._sessions: dict[str, _AcpRuntime] = {}

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        connection, manager, host, _initialize = await self._connect(project_path)
        try:
            created = await connection.new_session(cwd=project_path, mcp_servers=[])
            if model and self._spec.model_config_id:
                await connection.set_config_option(
                    self._spec.model_config_id,
                    created.session_id,
                    model,
                )
        except Exception:
            await manager.__aexit__(None, None, None)
            raise

        self._sessions[created.session_id] = _AcpRuntime(connection, manager, host)
        return ProviderSession(id=created.session_id, native_id=created.session_id)

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        connection, manager, host, initialize = await self._connect(project_path)
        capabilities = initialize.agent_capabilities
        if capabilities is None or not capabilities.load_session:
            await manager.__aexit__(None, None, None)
            raise ValueError(f"ACP provider {self.name} does not support session/load")
        try:
            await connection.load_session(
                cwd=project_path,
                session_id=native_session_id,
                mcp_servers=[],
            )
        except Exception:
            await manager.__aexit__(None, None, None)
            raise

        self._sessions[native_session_id] = _AcpRuntime(connection, manager, host)
        return ProviderSession(id=native_session_id, native_id=native_session_id)

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        runtime = self._sessions[session_id]
        async with runtime.lock:
            runtime.host.begin_turn(on_event)
            runtime.active = True
            try:
                result = await runtime.connection.prompt(session_id, [text_block(prompt)])
            finally:
                runtime.active = False

        return ProviderTurn(
            native_session_id=session_id,
            turn_id=f"acp_{secrets.token_hex(6)}",
            status="completed" if result.stop_reason == "end_turn" else result.stop_reason,
            response="".join(runtime.host.response_parts) or None,
            events=tuple(runtime.host.events),
        )

    async def cancel(self, session_id: str) -> None:
        runtime = self._sessions[session_id]
        if runtime.active:
            await runtime.connection.cancel(session_id)

    async def close(self, session_id: str) -> None:
        runtime = self._sessions.pop(session_id, None)
        if runtime is None:
            return
        if runtime.active:
            await runtime.connection.cancel(session_id)
        await runtime.manager.__aexit__(None, None, None)

    async def _connect(self, project_path: str) -> tuple[Any, Any, _AcpClientHost, Any]:
        host = _AcpClientHost(self.name, project_path, self._spec.auto_approve)
        environment = {**os.environ, **self._spec.env}
        manager = spawn_agent_process(
            host,
            self._spec.command,
            *self._spec.args,
            env=environment,
            cwd=project_path,
        )
        connection, _process = await manager.__aenter__()
        try:
            initialized = await connection.initialize(
                PROTOCOL_VERSION,
                client_capabilities=ClientCapabilities(
                    fs=FileSystemCapabilities(read_text_file=True, write_text_file=True),
                    terminal=False,
                ),
                client_info=Implementation(name="cleo", title="Cleo", version="0.1.0"),
            )
            if self._spec.auth_method:
                await connection.authenticate(self._spec.auth_method)
        except Exception:
            await manager.__aexit__(None, None, None)
            raise
        return connection, manager, host, initialized
