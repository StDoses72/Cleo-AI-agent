import asyncio
import json
import os
from types import SimpleNamespace

import httpx
import pytest

from cleo.config.settings import AgentProfile
from cleo.desktop.routing_settings import RoutingControls
from cleo.routing.benchmarks import BenchmarkCache, BenchmarkRecord, BenchmarkSnapshot
from cleo.routing.credentials import read_key, save_key
from cleo.routing.models import RoutingSettings, execution_mode, load_policy, save_policy, utcnow


def test_secure_benchmark_key_roundtrip_and_environment_override(tmp_path, monkeypatch):
    path = tmp_path / "key.json"
    monkeypatch.delenv("AA_FIXTURE_KEY", raising=False)
    save_key(path, "private-fixture-key")
    assert "private-fixture-key" not in path.read_text()
    assert read_key(path, "AA_FIXTURE_KEY") == "private-fixture-key"
    if os.name != "nt":
        assert path.stat().st_mode & 0o077 == 0
    monkeypatch.setenv("AA_FIXTURE_KEY", "environment-key")
    assert read_key(path, "AA_FIXTURE_KEY") == "environment-key"


def test_aa_refresh_uses_secure_key_and_official_endpoint(tmp_path, monkeypatch):
    async def scenario():
        key = tmp_path / "key.json"
        save_key(key, "private-fixture-key")
        monkeypatch.delenv("ARTIFICIAL_ANALYSIS_API_KEY", raising=False)

        def respond(request):
            assert request.headers["x-api-key"] == "private-fixture-key"
            assert request.url.path == "/api/v2/language/models/free"
            return httpx.Response(200, json={
                "tier": "free", "intelligence_index_version": 4.3,
                "pagination": {"page": 1, "has_more": False}, "data": [],
            })

        cache = BenchmarkCache(tmp_path / "cache.json", RoutingSettings(),
                               transport=httpx.MockTransport(respond), credential_path=key)
        view = await cache.refresh()
        assert view.snapshot.source_kind == "official_api" and view.stale is False
        assert "private-fixture-key" not in cache.path.read_text()

    asyncio.run(scenario())


def test_execution_settings_keep_old_base_schema_and_session_override(tmp_path):
    path = tmp_path / "routing.json"
    policy = RoutingSettings(enabled=True, default_mode="manual")
    save_policy(path, policy)
    raw = json.loads(path.read_text())
    assert "default_mode" not in raw and "evaluator" not in raw
    restored = load_policy(path)
    assert execution_mode(restored) == "manual"
    assert execution_mode(restored, {"runtime_options": {"routing_mode": "auto"}}) == "auto"
    restored.enabled = False
    assert execution_mode(restored, {"runtime_options": {"routing_mode": "auto"}}) == "manual"


def test_session_manual_mode_blocks_the_real_delegation_entry(service_factory, assessment):
    async def scenario():
        service, providers = service_factory(policy={"default_mode": "manual"})
        from cleo.routing.tools import tool_functions

        delegate = tool_functions(lambda: "parent", lambda _: service)[1]
        assert await delegate("subtask", assessment) == {"status": "routing_disabled"}
        assert not any(provider.prompts for provider in providers)

    asyncio.run(scenario())


def test_desktop_execution_mode_rpc_preserves_parent_model(service_factory, tmp_path):
    async def scenario():
        from cleo.desktop.rpc import RpcRegistry
        from cleo.desktop.service import DesktopService

        service, _ = service_factory()
        save_policy(tmp_path / "routing.json", service.policy)
        desktop = DesktopService.__new__(DesktopService)
        desktop.settings = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json")
        desktop.store = service.store
        desktop._runs = SimpleNamespace(
            runtime_lock=lambda _: asyncio.Lock(), is_switching=lambda _: False,
            is_running=lambda _: False,
        )
        desktop._chat = SimpleNamespace(forget=lambda _: None)
        desktop._runtime_profile = lambda manifest: {
            "model": manifest["runtime_options"]["model"],
            "routingMode": manifest["runtime_options"]["routing_mode"],
        }
        for mode in ("manual", "auto"):
            result = await RpcRegistry().dispatch(desktop, "update_runtime", {
                "thread_id": "parent", "update": {"routingMode": mode},
            }, None)
            assert result == {"model": "main-model", "routingMode": mode}
        with pytest.raises(ValueError, match="执行模式"):
            await desktop.update_runtime(thread_id="parent", update={"routingMode": "unknown"})

    asyncio.run(scenario())


def test_long_lived_mcp_service_loads_the_latest_default_connection(
    service_factory, tmp_path, monkeypatch,
):
    from cleo.routing.execution import create_service

    service, _ = service_factory()
    save_policy(tmp_path / "routing.json", service.policy)
    stale = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json", productivity=service.productivity,
                            MEMORY_DIR=service.store.memory_root,
                            SESSION_INDEX_PATH=service.store.index_path,
                            active_agent_profile=SimpleNamespace(model="old-default"))
    fresh = SimpleNamespace(PROFILE_DIR=tmp_path / "cleo.json", productivity=service.productivity,
                            MEMORY_DIR=service.store.memory_root,
                            SESSION_INDEX_PATH=service.store.index_path,
                            active_agent_profile=SimpleNamespace(model="new-default"))
    monkeypatch.setattr("cleo.config.settings.current_settings", lambda: stale)
    monkeypatch.setattr("cleo.config.settings.load_settings", lambda: fresh)
    monkeypatch.setattr("cleo.sessions.store.SessionStore", lambda *_: service.store)
    monkeypatch.setattr("cleo.integrations.harnesses.factory.build_agent_adapter",
                        lambda *_, **__: service.adapter)
    reloaded = create_service("parent", memory_root=service.store.memory_root, refresh_config=True)
    assert reloaded.evaluator.settings.active_agent_profile.model == "new-default"
    bound = create_service("parent", settings_model=stale)
    assert bound.evaluator.settings.active_agent_profile.model == "old-default"


def test_mcp_entrypoint_requests_fresh_configuration(service_factory, assessment, monkeypatch):
    from cleo.routing.scope import parent_binding_path
    from cleo.routing.tools import register_mcp_tools

    async def scenario():
        service, providers = service_factory()
        key = "1" * 32
        path = parent_binding_path(service.store.memory_root, key)
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"session_id": "parent"}))
        seen = []

        def factory(parent, **kwargs):
            seen.append((parent, kwargs["refresh_config"]))
            return service

        class Server:
            def __init__(self):
                """Purpose: Capture registered MCP handlers. Output: offline registry."""
                self.tools = {}

            def tool(self, name):
                """Purpose: Reuse the actual registration seam. Output: capture decorator."""
                def capture(function):
                    self.tools[name] = function
                    return function
                return capture

        monkeypatch.setattr("cleo.routing.tools.create_service", factory)
        server = Server()
        register_mcp_tools(server, service.store.memory_root, key, service.store.index_path)
        result = await server.tools["route_subtask"](assessment)
        assert result["selected"] == service.policy.fallback_candidate
        assert seen == [("parent", True)] and not any(provider.prompts for provider in providers)

    asyncio.run(scenario())


def test_credential_settings_evaluator_and_exact_calibration_share_real_controls(
    service_factory, tmp_path, monkeypatch,
):
    async def scenario():
        service, providers = service_factory()
        profile = AgentProfile(provider="openai", model="fixture-evaluator", api_key="private")
        settings = SimpleNamespace(
            PROFILE_DIR=tmp_path / "cleo.json", productivity=service.productivity,
            active_directory_profile=SimpleNamespace(root_path=tmp_path),
            profiles=SimpleNamespace(agents={"api": profile}),
        )
        controls = RoutingControls(settings, service.store, service.adapter)
        save_policy(controls.path, service.policy)
        monkeypatch.delenv("ARTIFICIAL_ANALYSIS_API_KEY", raising=False)
        view = await controls.view()
        view = await controls.save_benchmark_connection({
            "revision": view["revision"], "access": "free", "cacheTtlSeconds": 7200,
            "apiKey": "private-aa-key",
        })
        assert view["benchmark"]["keyConfigured"] is True
        assert "private-aa-key" not in json.dumps(view)
        snapshot = BenchmarkSnapshot(
            source_kind="local_import", retrieved_at=utcnow(), records=[BenchmarkRecord(
                id="fixture-aa-id", slug="fixture-v1", name="Fixture (high)", effort="high",
                version="4.3", scores={"artificial_analysis_coding_index": 50},
            )],
        )
        controls.benchmark_cache(service.policy).path.parent.mkdir(parents=True, exist_ok=True)
        controls.benchmark_cache(service.policy).path.write_text(snapshot.model_dump_json())
        update = {key: view[key] for key in (
            "revision", "enabled", "preference", "fallbackCandidate",
        )}
        update.update(defaultMode="manual", evaluator={
            "mode": "independent", "profile_id": "api", "model": "fixture-evaluator",
        }, candidates=[{
            "id": service.policy.fallback_candidate, "enabled": True, "tier": "economy",
            "modelVersion": "fixture-v1", "benchmarkRecordId": "fixture-aa-id",
        }])
        saved = await controls.save(update)
        assert saved["evaluator"]["model"] == "fixture-evaluator"
        assert saved["defaultMode"] == "manual"
        candidate = next(item for item in saved["candidates"]
                         if item["id"] == service.policy.fallback_candidate)
        assert candidate["benchmarkMatch"] == "explicit_variant_match"
        assert not any(provider.prompts for provider in providers)
        update["revision"] = saved["revision"]
        update["evaluator"]["model"] = "missing-model"
        with pytest.raises(ValueError, match="模型目录"):
            await controls.save(update)
        assert load_policy(controls.path).evaluator.model == "fixture-evaluator"

    asyncio.run(scenario())
