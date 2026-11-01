import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastmcp import Client
from langchain_core.messages import AIMessageChunk

from cleo.routing.scope import current_scope, delegation_scope, parent_binding_path


def test_actual_codex_langchain_tool_uses_router_and_keeps_main_model(
    service_factory,
    assessment,
    monkeypatch,
    tmp_path,
):
    from cleo.agents.tools import codex_tools
    from cleo.routing import tools

    async def scenario():
        service, providers = service_factory()
        parent = service.store.load_manifest("parent")
        monkeypatch.setattr(tools, "routing_enabled", lambda: True)
        monkeypatch.setattr(tools, "create_service", lambda _: service)
        monkeypatch.setattr(
            codex_tools,
            "_default_adapter",
            lambda: (_ for _ in ()).throw(
                AssertionError("Routed calls must not use the old facade")
            ),
        )
        with delegation_scope("parent", tmp_path):
            result = await codex_tools.codex_tool.ainvoke(
                {"prompt": "child task", "assessment": assessment}
            )
        assert result["status"] == "completed" and result["acceptance"] == "unknown"
        assert service.store.load_manifest("parent") == parent
        assert len(providers[0].prompts) == 1 and not providers[1].prompts

    asyncio.run(scenario())


def test_disabled_routing_preserves_existing_explicit_tool(monkeypatch):
    from cleo.agents.tools import codex_tools
    from cleo.routing import tools

    start = AsyncMock(return_value=SimpleNamespace(model_dump=lambda: {"status": "legacy"}))
    monkeypatch.setattr(tools, "routing_enabled", lambda: False)
    monkeypatch.setattr(codex_tools, "_default_adapter", lambda: SimpleNamespace(start=start))
    result = asyncio.run(
        codex_tools.codex_tool.ainvoke({"prompt": "task", "model": "explicit-model"})
    )
    assert result == {"status": "legacy"}
    start.assert_awaited_once_with("task", ".", "explicit-model")


def test_unbound_tool_reports_unsupported_without_a_model_call(monkeypatch, assessment):
    from cleo.routing import tools

    monkeypatch.setattr(tools, "routing_enabled", lambda: True)
    result = asyncio.run(tools.maybe_route_codex("task", ".", None, assessment))
    assert result["status"] == "unsupported"


def test_real_mcp_entrypoint_resolves_host_parent_binding(
    service_factory,
    assessment,
    monkeypatch,
):
    from cleo.mcp.memory_server import create_server
    from cleo.routing import tools

    async def scenario():
        service, providers = service_factory()
        key = "a" * 32
        providers[0].delegation_parent_key = lambda native: (
            key if native == "economy-0" else "b" * 32
        )
        # Exercise host session binding rather than a model-supplied parent argument.
        host = await service.adapter.create_session(
            "economy", project_path=str(service._project(".")), model="fixture-model"
        )
        binding = parent_binding_path(service.store.memory_root, key)
        mapped = json.loads(binding.read_text())
        assert mapped["session_id"].startswith("agent_")
        await service.adapter.close(host.id)
        service.parent_session_id = mapped["session_id"]
        original = service.store.load_manifest(service.parent_session_id)
        monkeypatch.setattr(tools, "create_service", lambda parent, **_: service)
        server = create_server(str(service.store.memory_root), routing_parent_key=key)
        async with Client(server) as client:
            names = {tool.name for tool in await client.list_tools()}
            assert {"route_subtask", "delegate_subtask", "subtask_status"} <= names
            result = await client.call_tool(
                "delegate_subtask", {"prompt": "MCP child", "assessment": assessment}
            )
            assert not result.is_error
        assert service.store.load_manifest(service.parent_session_id) == original
        assert len(providers[0].prompts) == 1

    asyncio.run(scenario())


def test_agent_stream_binds_parent_without_changing_its_model(tmp_path):
    from cleo.agents.cleo import Agent

    class Graph:
        async def astream(self, inputs, **kwargs):
            assert current_scope.get().parent_session_id == "stream-parent"
            assert current_scope.get().project_path == tmp_path
            yield AIMessageChunk(content="main response")

    agent = Agent.__new__(Agent)
    agent.root_dir = tmp_path
    agent.deepagent = Graph()
    agent.model_name = "session-main"

    async def scenario():
        result = [chunk async for chunk in agent.stream_text("user request", "stream-parent")]
        assert result == ["main response"]
        assert agent.model_name == "session-main" and current_scope.get() is None

    asyncio.run(scenario())


def test_factory_only_attaches_parent_tools_when_operator_enables_routing(tmp_path):
    from cleo.config.settings import ProductivitySettings
    from cleo.integrations.harnesses.factory import build_agent_adapter
    from cleo.sessions.store import SessionStore

    store = SessionStore(tmp_path / "memory")
    policy = tmp_path / "routing.json"
    for enabled in (False, True):
        policy.write_text(json.dumps({"enabled": enabled}))
        adapter = build_agent_adapter(tmp_path, ProductivitySettings(), session_store=store)
        memory = adapter.memory_mcp
        key = "a" * 32
        assert memory.routing_enabled is enabled
        assert ("--routing-parent-key" in memory._tool_args(key)) is enabled
        assert (
            "--routing-parent-key" in memory.claude_servers(key)["cleo_memory"]["args"]
        ) is enabled
        assert ("--routing-parent-key" in memory.acp_servers(key)[0].args) is enabled


def test_invalid_assessment_reports_fields_without_input_text(service_factory, monkeypatch):
    from cleo.routing import tools

    async def scenario():
        service, _ = service_factory()
        functions = tools.tool_functions(lambda: "parent", lambda _: service)
        result = await functions[0]({"secret_task_text": "private-content"})
        assert result["status"] == "rejected"
        assert any(item["field"] == "task_type" for item in result["fields"])
        assert "private-content" not in json.dumps(result)

    asyncio.run(scenario())
