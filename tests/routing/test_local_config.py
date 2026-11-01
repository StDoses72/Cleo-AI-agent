import asyncio
import json
from types import SimpleNamespace

import pytest

from cleo.desktop.local_config import METHODS, LocalConfigService
from cleo.desktop.rpc import RpcMethod, RpcRegistry


def test_preview_shares_routing_controls_and_cannot_execute(
    service_factory, tmp_path, monkeypatch,
):
    """Purpose: Exercise real preview RPC with fake providers. Output: saved policy, no turns."""
    async def scenario():
        service, providers = service_factory()
        settings = SimpleNamespace(
            PROFILE_DIR=tmp_path / "cleo.json", MEMORY_DIR=service.store.memory_root,
            SESSION_INDEX_PATH=service.store.index_path, productivity=service.productivity,
            active_directory_profile=SimpleNamespace(root_path=tmp_path),
        )
        config = SimpleNamespace(snapshot=SimpleNamespace(version=1, settings=settings))
        monkeypatch.setattr(
            "cleo.integrations.harnesses.factory.build_agent_adapter",
            lambda *a, **kw: service.adapter,
        )
        (tmp_path / "routing.json").write_text(service.policy.model_dump_json())
        preview = LocalConfigService(config)
        registry = RpcRegistry(RpcMethod(name, "renderer") for name in METHODS)
        view = await registry.dispatch(preview, "get_routing_settings", {}, None)
        update = {key: view[key] for key in (
            "revision", "enabled", "preference", "fallbackCandidate",
        )}
        update.update(preference="cost", candidates=[])
        saved = await registry.dispatch(preview, "save_routing_settings", {"update": update}, None)
        assert saved["preference"] == "cost"
        assert json.loads((tmp_path / "routing.json").read_text())["preference"] == "cost"
        with pytest.raises(ValueError, match="已变化"):
            await preview.save_routing_settings(update)
        for method in ("stream_turn", "create_thread", "check_model_connection", "load_workspace"):
            with pytest.raises(ValueError, match="unsupported"):
                await registry.dispatch(preview, method, {}, None)
        assert all(not provider.prompts and not provider.sessions for provider in providers)
        assert service.store.load_manifest("parent")["runtime_options"]["model"] == "main-model"
        await preview.shutdown()

    asyncio.run(scenario())


def test_preview_connection_summaries_redact_secrets_and_follow_config(tmp_path):
    """Purpose: Read edited connection settings. Output: fresh summaries without secret URLs."""
    async def scenario():
        path = tmp_path / "cleo.json"
        raw = {"profiles": {"agents": {"primary": {
            "provider": "openai", "model": "first", "api_key": "private-api-key",
            "base_url": "https://private-api-key@example.test/?key=private-api-key",
        }}}, "active_profiles": {"agent": "primary"}}
        path.write_text(json.dumps(raw))
        preview = LocalConfigService(SimpleNamespace(
            snapshot=SimpleNamespace(settings=SimpleNamespace(PROFILE_DIR=path)),
        ))
        result = await preview.get_model_settings()
        assert "private-api-key" not in json.dumps(result)
        assert result["profiles"][0]["hasApiKey"] is True
        assert result["profiles"][0]["model"] == "first"
        raw["profiles"]["agents"]["primary"]["model"] = "changed"
        path.write_text(json.dumps(raw))
        assert (await preview.get_model_settings())["profiles"][0]["model"] == "changed"

    asyncio.run(scenario())


@pytest.mark.parametrize("owner_type", ["user", "agent"])
def test_preview_reads_current_task_only_without_inference_or_event_writes(
    service_factory, owner_type,
):
    """Purpose: Exercise the sidebar RPC against real storage and reject unrelated IDs."""
    async def scenario():
        service, providers = service_factory()
        store = service.store
        store.update_manifest("parent", usage_task_id="current", owner_type=owner_type)
        store.create_session(session_id="worker", space="productivity", project="project",
                             provider="codex", owner_type="agent", parent_session_id="parent")
        store.update_manifest("worker", usage_task_id="current")
        store.append_events(session_id="parent", space="non_productivity", project="project",
            events=[{"type": "task_boundary", "actor": "system", "data": {
                "task_id": "old", "number": 1, "decision": "new", "status": "initial",
                "model": "fixture", "abstract": "Archived task"}},
                {"type": "task_boundary", "actor": "system", "data": {
                "task_id": "current", "number": 2, "decision": "new", "status": "confirmed",
                "model": "fixture", "abstract": "Current task"}},
                {"type": "user_message", "actor": "user", "content": "private raw prompt"}])
        before = store.read_events("parent")
        preview = LocalConfigService(SimpleNamespace(snapshot=SimpleNamespace(settings=
            SimpleNamespace(MEMORY_DIR=store.memory_root, SESSION_INDEX_PATH=store.index_path))))
        registry = RpcRegistry(RpcMethod(name, "renderer") for name in METHODS)
        result = await registry.dispatch(preview, "get_task_usage_preview", {}, None)
        assert result["sessionId"] == "parent"
        assert [item["id"] for item in result["sessions"]] == ["parent"]
        assert result["usage"]["abstract"] == "Current task"
        assert "history" not in result["usage"] and "breakdown" not in result["usage"]
        assert "private raw prompt" not in json.dumps(result)
        assert "Archived task" not in json.dumps(result)
        with pytest.raises(ValueError):
            await preview.get_task_usage_preview("../outside")
        assert store.read_events("parent") == before
        assert preview.adapter is None
        assert all(not provider.prompts and not provider.sessions for provider in providers)

    asyncio.run(scenario())
