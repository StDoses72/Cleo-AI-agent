"""Offline regressions for task ownership across Claude SDK transport replacements."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.desktop.service import DesktopService
from cleo.harnesses.adapter import AgentAdapter
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.routing.scope import parent_binding_path
from cleo.sessions.store import SessionStore


@pytest.fixture
def host(tmp_path, monkeypatch):
    """Purpose: Exercise real host bindings without starting any SDK or computer process.

    Input: Isolated home and monkeypatch fixture. Output: Host and fake SDK controls.
    """
    connections = []

    class Client:
        def __init__(self, options):
            """Purpose: Capture launch configuration. Input: SDK options. Output: Fake client."""
            self.options = options
            self.closed = False
            self.fail_disconnect = False
            connections.append(self)

        async def connect(self):
            """Purpose: Simulate startup. Input: Fixture state. Output: Success or failure."""

        async def disconnect(self):
            """Purpose: Simulate shutdown. Input: Fixture state. Output: Close or failure."""
            if self.fail_disconnect:
                raise RuntimeError("fixture shutdown failure")
            self.closed = True

        async def get_mcp_status(self):
            """Purpose: Avoid real MCP startup. Input: Launch servers. Output: Connected status."""
            return {"mcpServers": [{"name": name, "status": "connected"}
                                   for name in self.options.mcp_servers]}

        async def query(self, prompt):
            """Purpose: Accept offline prompts. Input: Fixture text. Output: No side effects."""

        async def receive_response(self):
            """Purpose: Finish offline turns. Input: None. Output: A fake SDK result."""
            from claude_agent_sdk import ResultMessage

            yield ResultMessage(subtype="success", duration_ms=0, duration_api_ms=0,
                                is_error=False, num_turns=1, session_id="fixture-native",
                                result="done")

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path)
    store = SessionStore(tmp_path / "memory")
    provider = ClaudeProvider(memory_mcp=MemoryMcp(
        store.memory_root, routing_enabled=True, computer_config_path=tmp_path / "computer.json"))
    adapter = AgentAdapter(tmp_path, session_store=store)
    adapter.register(provider)
    desktop = DesktopService.__new__(DesktopService)
    desktop._adapter_instance = adapter
    desktop._productivity_sessions = {}
    return SimpleNamespace(adapter=adapter, provider=provider, desktop=desktop, store=store,
                           connections=connections, project=str(tmp_path), client_type=Client)


def launch_key(client):
    """Purpose: Compare private launch identities without logging them.

    Input: Fake SDK client. Output: Its shared computer/memory key.
    """
    servers = client.options.mcp_servers
    args = servers["cleo_computer"]["args"]
    key = args[args.index("--client-key") + 1]
    args = servers["cleo_memory"]["args"]
    assert args[args.index("--routing-parent-key") + 1] == key
    return key


async def create_owned_session(host):
    """Purpose: Register a real host route. Input: Offline host. Output: Session and runtime."""
    session = await host.adapter.create_session("claude", project_path=host.project)
    host.desktop._productivity_sessions[session.id] = session
    runtime = host.provider._sessions[host.adapter._sessions[session.id].provider_session_id]
    return session, runtime


async def assert_owner(host, key, session):
    """Purpose: Check both ownership consumers. Input: Host key/task. Output: Assertions."""
    assert await host.desktop.computer_owner(key) == session.id
    binding = parent_binding_path(host.store.memory_root, key)
    assert json.loads(binding.read_text(encoding="utf-8")) == {"session_id": session.id}


@pytest.mark.parametrize("trigger", ["permissions", "effort", "cancel-recovery", "rewind"])
def test_reconnect_retains_task_identity(host, monkeypatch, trigger):
    """Purpose: Protect all reconnect callers, including ones without an adapter rebind.

    Input: Fake SDK, real host and reconnect trigger. Output: Stable, isolated ownership.
    """
    async def scenario():
        """Purpose: Repeat a reconnect and check isolation. Input: Fixture. Output: Assertions."""
        session, runtime = await create_owned_session(host)
        initial_key = launch_key(runtime.client)
        runtime.native_session_id = "fixture-native"
        await assert_owner(host, initial_key, session)
        for index in range(2):
            previous = runtime.client
            if trigger == "permissions":
                await host.adapter.update_session_options(
                    session.id, approval_mode="bypassPermissions" if index == 0 else "acceptEdits")
            elif trigger == "effort":
                await host.adapter.update_session_options(
                    session.id, effort="high" if index == 0 else "medium")
            elif trigger == "cancel-recovery":
                runtime.needs_reconnect = True
                await host.adapter.prompt(session.id, "offline fixture")
            else:
                monkeypatch.setattr(host.provider, "_transcript", AsyncMock(return_value=[
                    {"text": "edited prompt", "uuid": "fixture-turn"}]))
                await host.provider.rewind(
                    host.adapter._sessions[session.id].provider_session_id,
                    prompt="edited prompt", later=[])
                runtime.native_session_id = "fixture-native"
            assert previous.closed
            assert runtime.client is not previous
            assert launch_key(runtime.client) == initial_key
            await assert_owner(host, launch_key(runtime.client), session)
        other, other_runtime = await create_owned_session(host)
        other_key = launch_key(other_runtime.client)
        assert other_key != initial_key
        await assert_owner(host, other_key, other)
        await assert_owner(host, initial_key, session)
        assert await host.desktop.computer_owner("0" * 32) is None
        await host.adapter.close(session.id)
        assert await host.desktop.computer_owner(initial_key) is None
        await host.adapter.close(other.id)

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["connect", "disconnect", "permission-mismatch"])
def test_failed_reconnect_preserves_existing_owner(host, monkeypatch, failure):
    """Purpose: Keep identity and options intact when transport replacement fails.

    Input: Startup or shutdown failure. Output: Original task binding remains valid.
    """
    async def scenario():
        """Purpose: Fail then retry a replacement. Input: Fixture. Output: Atomicity assertions."""
        session, runtime = await create_owned_session(host)
        original = runtime.client
        key = launch_key(original)
        if failure == "connect":
            monkeypatch.setattr(host.client_type, "connect", AsyncMock(
                side_effect=RuntimeError("fixture startup failure")))
        elif failure == "disconnect":
            original.fail_disconnect = True
        else:
            monkeypatch.setattr(host.client_type, "get_server_info", AsyncMock(
                return_value={"current_permission_mode": "acceptEdits"}), raising=False)
        options = {"approval_mode": "bypassPermissions"} if failure == "permission-mismatch" \
            else {"effort": "high"}
        with pytest.raises((RuntimeError, ValueError), match="fixture|未应用所选权限"):
            await host.adapter.update_session_options(session.id, **options)
        assert runtime.client is original
        assert runtime.options.effort is None
        assert runtime.options.approval_mode == "acceptEdits"
        assert runtime.computer_client == key
        assert launch_key(host.connections[-1]) == key
        await assert_owner(host, key, session)
        if failure != "connect":
            assert host.connections[-1].closed
        if failure == "disconnect":
            original.fail_disconnect = False
            await host.adapter.update_session_options(session.id, effort="high")
            await assert_owner(host, launch_key(runtime.client), session)
        await host.adapter.close(session.id)

    asyncio.run(scenario())
