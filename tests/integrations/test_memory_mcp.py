import asyncio
import sys
import tomllib
from types import SimpleNamespace

import pytest
from fastmcp import Client
from fastmcp.client.transports import StdioTransport

from cleo.agents.tools.memory_tools import create_memory_tools
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.memory.reader import TOOL_NAMES
from cleo.sessions.store import SessionStore


@pytest.mark.parametrize("custom_index", [False, True])
def test_stdio_tools_work_from_unrelated_cwd_without_configuration_writes(tmp_path, custom_index):
    root = tmp_path / "cleo memory"
    cwd = tmp_path / "another project"
    cwd.mkdir()
    config = cwd / ".mcp.json"
    config.write_text('{"mcpServers": {"existing": {}}}', encoding="utf-8")
    before = config.read_bytes()
    index = tmp_path / "data" / "sessions.sqlite3" if custom_index else None
    store = SessionStore(root, index)
    store.create_session(
        session_id="chat",
        space="non_productivity",
        project="general",
        provider="cleo",
        owner_type="user",
    )
    store.append_event(
        session_id="chat",
        space="non_productivity",
        project="general",
        event_type="user_message",
        actor="user",
        content="shared requirements",
    )
    mcp = MemoryMcp(root, index)
    transport = StdioTransport(
        command=sys.executable, args=mcp.args, cwd=str(cwd), keep_alive=False
    )

    async def exercise():
        async with Client(transport) as client:
            tools = await client.list_tools()
            assert {t.name for t in tools} == set(TOOL_NAMES)
            assert all(t.annotations.readOnlyHint for t in tools)
            result = await client.call_tool("read_thread", {"session_id": "chat"})
            assert result.data["results"][0]["content"] == "shared requirements"
            search = await client.call_tool(
                "search_conversation_history", {"query": "requirements"}
            )
            assert search.data["results"][0]["session_id"] == "chat"
            local_tools = {t.name: t for t in create_memory_tools(root, index)}
            assert local_tools["read_thread"].invoke({"session_id": "chat"}) == result.data

    asyncio.run(exercise())
    assert transport._connect_task is None
    assert config.read_bytes() == before
    assert set(p.name for p in cwd.iterdir()) == {".mcp.json"}
    if custom_index:
        assert not (root / "sessions.sqlite3").exists()


def test_codex_override_is_client_local_and_valid_toml(tmp_path):
    memory = MemoryMcp(tmp_path / "memory")
    provider = CodexProvider(None, memory_mcp=memory)
    client = provider._client_with_approvals(CodexApprovalBroker("codex"))
    config = client._client._sync.config
    parsed = tomllib.loads("\n".join(config.config_overrides))
    server = parsed["mcp_servers"]["cleo_memory"]
    assert server["command"] == sys.executable
    assert server["args"] == memory.args
    assert server["required"] is True
    independent = CodexProvider(None)._client_with_approvals(CodexApprovalBroker("codex"))
    assert independent._client._sync.config.config_overrides == ()


def test_claude_reconnect_keeps_process_local_mcp(tmp_path, monkeypatch):
    captured = []

    class FakeClient:
        def __init__(self, *, options):
            captured.append(options)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

        async def get_mcp_status(self):
            return {"mcpServers": [{"name": "cleo_memory", "status": "connected"}]}

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", FakeClient)
    memory = MemoryMcp(tmp_path)
    provider = ClaudeProvider(memory_mcp=memory)

    async def exercise():
        session = await provider.resume_session("native", str(tmp_path))
        await provider.update_session_options(session.id, effort="high")
        await provider.close(session.id)

    asyncio.run(exercise())
    assert len(captured) == 2
    assert all(options.mcp_servers == memory.claude_servers() for options in captured)
    assert all(options.resume == "native" for options in captured)


def test_acp_create_and_resume_receive_session_mcp(tmp_path, monkeypatch):
    from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider

    calls = []

    class Connection:
        async def new_session(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(session_id="new", config_options=[])

        async def load_session(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(config_options=[])

    class Manager:
        async def __aexit__(self, *args):
            pass

    memory = MemoryMcp(tmp_path)
    provider = AcpProvider("test", AcpAgentSpec("test"), memory_mcp=memory)

    async def connect(project_path):
        return (
            Connection(),
            Manager(),
            None,
            SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=True)),
        )

    monkeypatch.setattr(provider, "_connect", connect)

    async def exercise():
        created = await provider.create_session(str(tmp_path))
        await provider.close(created.id)
        resumed = await provider.resume_session("old", str(tmp_path))
        await provider.close(resumed.id)

    asyncio.run(exercise())
    assert len(calls) == 2
    assert all(call["mcp_servers"] == memory.acp_servers() for call in calls)


def test_codex_create_resume_and_fork_preserve_mcp(tmp_path, monkeypatch):
    clients = []

    class FakeClient:
        def __init__(self, *, config):
            self.config = config
            self._client = SimpleNamespace(_sync=SimpleNamespace(_approval_handler=None))
            self.closed = False
            clients.append(self)

        async def __aenter__(self):
            return self

        async def thread_start(self, **kwargs):
            return SimpleNamespace(id="new")

        async def thread_resume(self, thread_id, **kwargs):
            return SimpleNamespace(id=thread_id)

        async def thread_fork(self, thread_id, **kwargs):
            return SimpleNamespace(id="fork")

        async def close(self):
            self.closed = True

    monkeypatch.setattr("cleo.integrations.harnesses.codex.AsyncCodex", FakeClient)
    memory = MemoryMcp(tmp_path)
    provider = CodexProvider(None, memory_mcp=memory)

    async def exercise():
        created = await provider.create_session(str(tmp_path))
        forked = await provider.fork_session(created.id)
        await provider.close(forked.id)
        await provider.close(created.id)
        resumed = await provider.resume_session(created.id, str(tmp_path))
        await provider.close(resumed.id)

    asyncio.run(exercise())
    assert len(clients) == 3
    assert all(c.config == memory.codex_config() and c.closed for c in clients)


def test_claude_failed_mcp_disconnects_without_creating_session(tmp_path, monkeypatch):
    disconnected = []

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def connect(self):
            pass

        async def get_mcp_status(self):
            return {"mcpServers": [{"name": "cleo_memory", "status": "failed"}]}

        async def disconnect(self):
            disconnected.append(True)

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", FakeClient)
    provider = ClaudeProvider(memory_mcp=MemoryMcp(tmp_path))
    with pytest.raises(RuntimeError, match="Cleo memory MCP failed"):
        asyncio.run(provider.create_session(str(tmp_path)))
    assert disconnected == [True]
    assert provider._sessions == {}


def test_factory_and_codex_facade_share_explicit_store(tmp_path):
    from cleo.config.settings import ProductivitySettings
    from cleo.integrations.codex import CodexAdapter
    from cleo.integrations.harnesses.factory import build_agent_adapter

    project = tmp_path / "other project"
    project.mkdir()
    root = tmp_path / "cleo memory"
    index = tmp_path / "data" / "sessions.sqlite3"
    store = SessionStore(root, index)
    adapter = build_agent_adapter(project, ProductivitySettings(), session_store=store)
    assert adapter.provider_control("codex")._memory_mcp.root == root
    assert adapter.provider_control("codex")._memory_mcp.index_path == index
    facade = CodexAdapter("test", project, memory_root=root, session_index_path=index)
    assert facade._adapter._store.memory_root == root
    assert facade._adapter.provider_control("codex")._memory_mcp.root == root
    assert facade._adapter._store.index_path == index
    assert facade._adapter.provider_control("codex")._memory_mcp.index_path == index
    assert not (root / "sessions.sqlite3").exists()
    assert not (project / "memory").exists()
