import asyncio
import json
from types import SimpleNamespace

import pytest

from cleo.desktop.rpc import RpcRegistry
from cleo.desktop.service import DesktopService


def desktop_for(service, root):
    """Purpose: Bind the real desktop RPC to offline executors. Output: isolated desktop."""
    desktop = DesktopService.__new__(DesktopService)
    desktop.settings = SimpleNamespace(
        PROFILE_DIR=root / "cleo.json",
        productivity=service.productivity,
        active_directory_profile=SimpleNamespace(root_path=root),
    )
    desktop.store = service.store
    desktop._adapter_instance = service.adapter
    return desktop


def test_desktop_routing_is_visible_and_saves_without_a_model_turn(service_factory, tmp_path):
    async def scenario():
        service, providers = service_factory()
        desktop = desktop_for(service, tmp_path)
        path = tmp_path / "routing.json"
        path.write_text(service.policy.model_dump_json(), encoding="utf-8")
        registry = RpcRegistry()
        view = await registry.dispatch(desktop, "get_routing_settings", {}, None)
        assert view["enabled"] is True and view["benchmark"]["recordCount"] == 0
        assert view["fallbackCandidate"] == service.policy.fallback_candidate
        update = {
            key: view[key] for key in ("revision", "enabled", "preference", "fallbackCandidate")
        }
        update["enabled"] = False
        update["candidates"] = [
            {key: item[key] for key in ("id", "enabled", "tier")} for item in view["candidates"]
        ]
        result = await registry.dispatch(desktop, "save_routing_settings", {"update": update}, None)
        assert result["enabled"] is False
        assert json.loads(path.read_text())["enabled"] is False
        assert all(not provider.prompts for provider in providers)
        with pytest.raises(ValueError, match="已变化"):
            await desktop.save_routing_settings(update)

    asyncio.run(scenario())


def test_desktop_rejects_unknown_candidate_and_exposes_no_secret(
    service_factory,
    tmp_path,
    monkeypatch,
):
    async def scenario():
        service, _ = service_factory()
        desktop = desktop_for(service, tmp_path)
        (tmp_path / "routing.json").write_text(service.policy.model_dump_json(), encoding="utf-8")
        monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "private-api-key")
        view = await desktop.get_routing_settings()
        assert view["benchmark"]["keyConfigured"] is True
        assert "private-api-key" not in json.dumps(view)
        update = {
            key: view[key] for key in ("revision", "enabled", "preference", "fallbackCandidate")
        }
        update["candidates"] = [{"id": "invented/model@high", "enabled": True, "tier": "strong"}]
        with pytest.raises(ValueError, match="候选"):
            await desktop.save_routing_settings(update)

    asyncio.run(scenario())


def test_catalog_discovery_cannot_stamp_old_policy_with_a_new_revision(
    service_factory,
    tmp_path,
    monkeypatch,
):
    from cleo.routing.catalog import CandidateCatalog

    async def scenario():
        service, _ = service_factory()
        desktop = desktop_for(service, tmp_path)
        path = tmp_path / "routing.json"
        path.write_text(service.policy.model_dump_json(), encoding="utf-8")
        original = CandidateCatalog.list

        async def concurrent_edit(catalog, *args, **kwargs):
            candidates = await original(catalog, *args, **kwargs)
            changed = service.policy.model_copy(update={"enabled": False})
            path.write_text(changed.model_dump_json(), encoding="utf-8")
            return candidates

        monkeypatch.setattr(CandidateCatalog, "list", concurrent_edit)
        view = await desktop.get_routing_settings()
        assert view["enabled"] is True
        update = {
            key: view[key] for key in ("revision", "enabled", "preference", "fallbackCandidate")
        }
        update["candidates"] = []
        with pytest.raises(ValueError, match="已变化"):
            await desktop.save_routing_settings(update)

    asyncio.run(scenario())
