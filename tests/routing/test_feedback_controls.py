"""User feedback is host-bound, reversible and independent of model self-reports."""
import asyncio

import pytest

from cleo.desktop.rpc import RpcRegistry
from tests.routing.test_desktop_settings import desktop_for


def test_feedback_rpc_revises_one_episode_and_rejects_cross_workspace(service_factory, tmp_path):
    async def scenario():
        service, providers = service_factory()
        from cleo.routing.feedback import FeedbackStore

        service.state_path = service.store.memory_root / ".routing"
        service.feedback = FeedbackStore(service.state_path)
        desktop = desktop_for(service, tmp_path)
        (tmp_path / "routing.json").write_text(service.policy.model_dump_json(), encoding="utf-8")
        result = await service.delegate("offline", {
            "task_type": "coding", "complexity": "low", "required_capabilities": [],
            "uncertainty": "low", "failure_impact": "low", "acceptance_criteria": ["check"],
        })
        registry = RpcRegistry()
        update = {"task_id": result["task_id"], "outcome": "failed",
                  "attribution": "selection", "revision": 0}
        view = await registry.dispatch(desktop, "submit_routing_feedback", {"update": update}, None)
        feedback = next(item for item in view["recentTasks"] if item["id"] == update["task_id"])
        assert feedback["feedback"]["revision"] == 1
        with pytest.raises(ValueError, match="已变化"):
            await desktop.submit_routing_feedback(update)
        await desktop.submit_routing_feedback({**update, "revision": 1, "outcome": "retracted"})
        assert service.feedback.read(update["task_id"])["outcome"] == "retracted"
        desktop.settings.active_directory_profile.root_path = tmp_path / "elsewhere"
        with pytest.raises(ValueError, match="工作区"):
            await desktop.submit_routing_feedback({**update, "revision": 2})
        assert sum(len(provider.prompts) for provider in providers) == 1
    asyncio.run(scenario())


def test_coordinator_can_only_flag_unknown_once(service_factory, assessment):
    from cleo.routing.tools import tool_functions

    async def scenario():
        service, _ = service_factory()
        result = await service.delegate("offline", assessment)
        flag = tool_functions(lambda: "parent", lambda _: service)[4]
        first = await flag(result["task_id"])
        second = await flag(result["task_id"])
        assert first == second and first["outcome"] == "unknown"
        assert first["source"] == "coordinator"
        assert first["revision"] == 1
        assert len(list((service.state_path / "feedback").glob("task_*.json"))) == 1
    asyncio.run(scenario())


def test_strategy_extension_roundtrip_is_visible_and_revision_bound(service_factory, tmp_path):
    async def scenario():
        service, _ = service_factory()
        desktop = desktop_for(service, tmp_path)
        (tmp_path / "routing.json").write_text(service.policy.model_dump_json(), encoding="utf-8")
        view = await desktop.get_routing_settings()
        update = {key: view[key] for key in (
            "revision", "enabled", "preference", "fallbackCandidate")}
        update.update(strategy="evaluator", feedbackEnabled=False, candidates=[])
        saved = await desktop.save_routing_settings(update)
        assert saved["strategy"] == "evaluator" and not saved["feedbackEnabled"]
        assert saved["revision"] != view["revision"]
        assert (tmp_path / "routing-v2.json").exists()
        # The rollback-compatible base policy does not contain the extension keys.
        import json
        assert "strategy" not in json.loads((tmp_path / "routing.json").read_text())
    asyncio.run(scenario())
