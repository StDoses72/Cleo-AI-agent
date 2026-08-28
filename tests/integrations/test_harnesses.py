from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from acp import update_agent_message_text

from cleo.harnesses import (
    AgentAdapter,
    AgentEvent,
    ProviderSession,
    ProviderTurn,
    SessionOptions,
)
from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider, _AcpClientHost
from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime
from cleo.integrations.harnesses.codex import CodexProvider, _CodexRuntime
from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker
from cleo.memory.compaction import load_validated_compact


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


def test_acp_model_options_flatten_named_groups() -> None:
    assert AcpProvider._select_options(
        [
            {
                "name": "Recommended",
                "options": [
                    {"name": "Fast", "value": "fast", "description": "Low latency"},
                    {"name": "Deep", "value": "deep"},
                ],
            },
            {"name": "Ignored"},
        ]
    ) == [
        ("fast", "Fast", "Low latency"),
        ("deep", "Deep", ""),
    ]


def test_acp_provider_reports_missing_command(tmp_path) -> None:
    provider = AcpProvider(
        "missing-acp",
        AcpAgentSpec(command="cleo-command-that-does-not-exist"),
    )

    with pytest.raises(
        FileNotFoundError,
        match="ACP provider 'missing-acp' command not found",
    ):
        asyncio.run(provider.create_session(str(tmp_path)))


def test_acp_connection_check_closes_short_lived_process(tmp_path) -> None:
    provider = AcpProvider("test-acp", AcpAgentSpec(command="test-acp"))
    connected: list[str] = []
    closed: list[tuple[object, object, object]] = []

    class Manager:
        async def __aexit__(self, exc_type, exc, traceback) -> None:
            closed.append((exc_type, exc, traceback))

    async def connect(project_path: str):
        connected.append(project_path)
        return object(), Manager(), object(), object()

    provider._connect = connect

    asyncio.run(provider.check_connection(str(tmp_path)))

    assert connected == [str(tmp_path.resolve())]
    assert closed == [(None, None, None)]


def test_acp_provider_uses_model_specific_effort_controls(tmp_path) -> None:
    provider = AcpProvider("test-acp", AcpAgentSpec(command="test-acp"))
    calls: list[tuple[str, str]] = []

    def config_options(model: str, effort: str | None = None) -> list[dict]:
        options = [
            {
                "id": "model",
                "category": "model",
                "currentValue": model,
                "options": [
                    {"value": "fast", "name": "Fast"},
                    {"value": "deep", "name": "Deep"},
                ],
            }
        ]
        if model == "deep":
            options.append(
                {
                    "id": "reasoning",
                    "category": "thought_level",
                    "currentValue": effort or "high",
                    "options": [
                        {"value": "high", "name": "High"},
                        {"value": "xhigh", "name": "Extra high"},
                    ],
                }
            )
        return options

    class Connection:
        async def new_session(self, **_kwargs):
            return SimpleNamespace(session_id="acp-session", config_options=config_options("fast"))

        async def set_config_option(self, option_id, _session_id, value):
            calls.append((option_id, value))
            if option_id == "model":
                return SimpleNamespace(config_options=config_options(value))
            return SimpleNamespace(config_options=config_options("deep", value))

    class Manager:
        async def __aexit__(self, _exc_type, _exc, _traceback) -> None:
            return None

    connection = Connection()

    async def connect(_project_path: str):
        return connection, Manager(), object(), object()

    provider._connect = connect

    async def scenario() -> None:
        models = await provider.list_models(str(tmp_path))
        assert models[0].id == "fast"
        assert models[0].supported_efforts == ()
        assert models[1].id == "deep"
        assert models[1].default_effort == "high"
        assert models[1].supported_efforts == ("high", "xhigh")

        session = await provider.create_session(str(tmp_path), model="deep")
        assert provider.session_options(session.id) == SessionOptions(model="deep", effort="high")
        options = await provider.update_session_options(session.id, effort="xhigh")
        assert options == SessionOptions(model="deep", effort="xhigh")

    asyncio.run(scenario())
    assert ("model", "deep") in calls
    assert ("reasoning", "xhigh") in calls


def test_claude_provider_reconnects_with_selected_effort(tmp_path) -> None:
    provider = ClaudeProvider(default_model="claude-test")

    class Client:
        def __init__(self) -> None:
            self.disconnected = False

        async def disconnect(self) -> None:
            self.disconnected = True

        async def set_model(self, _model) -> None:
            return None

        async def set_permission_mode(self, _mode) -> None:
            return None

    original = Client()
    replacement = Client()
    provider._sessions["claude-session"] = _ClaudeRuntime(
        client=original,
        options=SessionOptions(
            model="claude-test",
            effort="high",
            approval_mode="acceptEdits",
        ),
        cwd=str(tmp_path),
        native_session_id="native-session",
    )
    connected: list[dict] = []

    async def connect(project_path, model, effort=None, resume=None, permission_mode=None):
        connected.append(
            {
                "project_path": project_path,
                "model": model,
                "effort": effort,
                "resume": resume,
                "permission_mode": permission_mode,
            }
        )
        return _ClaudeRuntime(
            client=replacement,
            options=SessionOptions(model=model, effort=effort, approval_mode=permission_mode),
            cwd=project_path,
            native_session_id=resume,
        )

    provider._connect = connect

    options = asyncio.run(provider.update_session_options("claude-session", effort="max"))

    assert original.disconnected
    assert options.effort == "max"
    assert connected == [
        {
            "project_path": str(tmp_path),
            "model": "claude-test",
            "effort": "max",
            "resume": "native-session",
            "permission_mode": "acceptEdits",
        }
    ]


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
        assert adapter._store.load_manifest(result.session_id)["title"] == "hello"
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
        await host.write_text_file("session-1", "notes.txt", "one\ntwo\n")
        content = await host.read_text_file("session-1", "notes.txt", line=2, limit=1)
        assert target.read_text(encoding="utf-8") == "one\ntwo\n"
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
    assert received[3].type == "assistant_message_completed"
    assert received[3].data["payload"]["item"]["phase"] == "final_answer"


def test_agent_adapter_persists_visible_codex_commentary_as_thought() -> None:
    commentary = AgentEvent(
        provider="codex",
        type="assistant_message_completed",
        text="Checking the repository before the final answer.",
        data={
            "provider_event_type": "item/completed",
            "schema_version": 2,
            "payload": {
                "item": {
                    "id": "message-1",
                    "type": "agentMessage",
                    "phase": "commentary",
                }
            },
        },
    )
    final = commentary.model_copy(
        update={
            "data": {
                **commentary.data,
                "payload": {
                    "item": {
                        "id": "message-2",
                        "type": "agentMessage",
                        "phase": "final_answer",
                    }
                },
            }
        }
    )

    stored = AgentAdapter._stored_provider_event(commentary)

    assert stored is not None
    assert stored["type"] == "thought"
    assert stored["content"] == commentary.text
    assert stored["data"]["payload"]["item"]["id"] == "message-1"
    assert AgentAdapter._stored_provider_event(final) is None


def test_codex_provider_reads_account_rate_limit_windows() -> None:
    class FakeClient:
        async def request(self, method, params, *, response_model):
            assert method == "account/rateLimits/read"
            assert params is None
            return response_model.model_validate(
                {
                    "rateLimits": {
                        "primary": {
                            "usedPercent": 20,
                            "windowDurationMins": 300,
                            "resetsAt": 1_800_000_000,
                        },
                        "secondary": {
                            "usedPercent": 35,
                            "windowDurationMins": 10_080,
                            "resetsAt": 1_800_100_000,
                        },
                    }
                }
            )

    provider = CodexProvider(default_model="test-model")
    provider._sessions["session-limits"] = _CodexRuntime(
        client=SimpleNamespace(_client=FakeClient()),
        thread=SimpleNamespace(id="thread-limits"),
    )

    windows = asyncio.run(provider.account_rate_limits("session-limits"))

    assert [(window.window_minutes, window.used_percent) for window in windows] == [
        (300, 20),
        (10_080, 35),
    ]


def test_codex_provider_applies_runtime_options_to_next_turn() -> None:
    received_kwargs: dict[str, object] = {}

    class FakeTurn:
        id = "turn-options"

        async def stream(self):
            yield SimpleNamespace(
                method="turn/completed",
                payload=SimpleNamespace(
                    model_dump=lambda **_kwargs: {
                        "turn": {"id": self.id, "status": "completed"}
                    }
                ),
            )

    class FakeThread:
        id = "codex-options"

        async def turn(self, _prompt, **kwargs):
            received_kwargs.update(kwargs)
            return FakeTurn()

    provider = CodexProvider(default_model="gpt-default")
    provider._sessions["session-options"] = _CodexRuntime(
        client=SimpleNamespace(),
        thread=FakeThread(),
        options=SessionOptions(
            model="gpt-before",
            approval_mode="deny_all",
            sandbox="workspace-write",
        ),
    )

    async def exercise() -> None:
        options = await provider.update_session_options(
            "session-options",
            model="gpt-after",
            effort="high",
            approval_mode="auto_review",
            sandbox="full-access",
        )
        assert options.model == "gpt-after"
        await provider.prompt("session-options", "continue")

    asyncio.run(exercise())

    assert str(received_kwargs["model"]) == "gpt-after"
    assert str(received_kwargs["effort"].value) == "high"
    assert str(received_kwargs["approval_mode"].value) == "auto_review"
    assert str(received_kwargs["sandbox"].value) == "full-access"


def test_codex_provider_routes_user_approval_to_app_server_client() -> None:
    received: dict[str, object] = {}

    class LowLevelClient:
        async def turn_start(self, thread_id, prompt, params):
            received.update(thread_id=thread_id, prompt=prompt, params=params)
            return SimpleNamespace(turn=SimpleNamespace(id="turn-user"))

    provider = CodexProvider(default_model="gpt-default")
    runtime = _CodexRuntime(
        client=SimpleNamespace(_client=LowLevelClient()),
        thread=SimpleNamespace(id="thread-user"),
        options=SessionOptions(
            model="gpt-user",
            effort="high",
            approval_mode="user",
            sandbox="workspace-write",
        ),
    )

    turn = asyncio.run(provider._start_turn(runtime, "commit these changes"))

    assert turn.id == "turn-user"
    assert received["thread_id"] == "thread-user"
    assert received["prompt"] == "commit these changes"
    assert received["params"] == {
        "approvalPolicy": "on-request",
        "approvalsReviewer": "user",
        "effort": "high",
        "model": "gpt-user",
        "sandboxPolicy": {"type": "workspaceWrite"},
    }


def test_codex_approval_broker_waits_for_user_decision() -> None:
    async def scenario() -> None:
        broker = CodexApprovalBroker()
        received: list[AgentEvent] = []
        ready = asyncio.Event()

        async def on_event(event: AgentEvent) -> None:
            received.append(event)
            if event.type == "permission_request":
                ready.set()

        broker.bind(asyncio.get_running_loop(), on_event)
        response_task = asyncio.create_task(
            asyncio.to_thread(
                broker.handle,
                "item/commandExecution/requestApproval",
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "command": "git commit -m test",
                    "cwd": "D:/repo",
                    "availableDecisions": ["accept", "acceptForSession", "decline"],
                },
            )
        )
        await asyncio.wait_for(ready.wait(), timeout=1)
        request = received[0].data["payload"]

        result = await broker.resolve(request["id"], "acceptForSession")
        response = await asyncio.wait_for(response_task, timeout=1)

        assert result["decision"] == "acceptForSession"
        assert response == {"decision": "acceptForSession"}
        assert [event.type for event in received] == [
            "permission_request",
            "permission_response",
        ]

    asyncio.run(scenario())


def test_codex_approval_broker_rejects_when_no_ui_is_bound() -> None:
    broker = CodexApprovalBroker()

    assert broker.handle(
        "item/fileChange/requestApproval",
        {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1"},
    ) == {"decision": "decline"}


def test_codex_approval_broker_cancel_unblocks_pending_request() -> None:
    async def scenario() -> None:
        broker = CodexApprovalBroker()
        ready = asyncio.Event()

        async def on_event(event: AgentEvent) -> None:
            if event.type == "permission_request":
                ready.set()

        broker.bind(asyncio.get_running_loop(), on_event)
        response_task = asyncio.create_task(
            asyncio.to_thread(
                broker.handle,
                "item/fileChange/requestApproval",
                {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                },
            )
        )
        await asyncio.wait_for(ready.wait(), timeout=1)

        broker.cancel_all()

        assert await asyncio.wait_for(response_task, timeout=1) == {"decision": "cancel"}

    asyncio.run(scenario())


def test_agent_adapter_persists_rich_session_controls(tmp_path) -> None:
    class RichProvider(FakeProvider):
        def __init__(self) -> None:
            super().__init__()
            self.options = SessionOptions(
                model="gpt-test",
                approval_mode="deny_all",
                sandbox="workspace-write",
            )
            self.renamed: list[str] = []
            self.compacted: list[str] = []
            self.archived: list[str] = []

        def session_options(self, _session_id: str) -> SessionOptions:
            return self.options

        async def update_session_options(self, _session_id: str, **changes):
            self.options = SessionOptions(
                model=changes.get("model") or self.options.model,
                effort=changes.get("effort") or self.options.effort,
                approval_mode=changes.get("approval_mode") or self.options.approval_mode,
                sandbox=changes.get("sandbox") or self.options.sandbox,
            )
            return self.options

        async def fork_session(self, _session_id: str) -> ProviderSession:
            return ProviderSession(id="provider-fork", native_id="native-fork")

        async def rename_session(self, _session_id: str, name: str) -> None:
            self.renamed.append(name)

        async def compact_session(self, session_id: str) -> None:
            self.compacted.append(session_id)

        async def archive_session(self, session_id: str) -> None:
            self.archived.append(session_id)

    provider = RichProvider()
    adapter = AgentAdapter(tmp_path)
    adapter.register(provider)

    async def exercise() -> None:
        session = await adapter.create_session("fake", model="test-model")
        manifest = adapter._store.load_manifest(session.id)
        assert manifest["runtime_options"]["model"] == "gpt-test"

        options = await adapter.update_session_options(session.id, effort="high")
        assert options.effort == "high"
        assert adapter._store.load_manifest(session.id)["runtime_options"]["effort"] == "high"

        await adapter.rename_session(session.id, "Focused work")
        assert adapter._store.load_manifest(session.id)["title"] == "Focused work"

        forked = await adapter.fork_session(session.id)
        assert adapter._store.load_manifest(forked.id)["parent_session_id"] == session.id

        await adapter.compact_session(forked.id)
        await adapter.archive_session(forked.id)
        assert adapter._store.load_manifest(forked.id)["status"] == "archived"

    asyncio.run(exercise())

    assert provider.renamed == ["Focused work"]
    assert provider.compacted == ["provider-fork"]
    assert provider.archived == ["provider-fork"]
