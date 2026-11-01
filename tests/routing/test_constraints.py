import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from cleo.routing.benchmarks import BenchmarkRecord, BenchmarkSnapshot, CacheView
from cleo.routing.models import BenchmarkBinding, RoutingSettings, TaskAssessment, utcnow
from cleo.routing.router import route


def test_discovery_is_cached_and_execution_only_rechecks_selected(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        service.benchmarks.refresh = AsyncMock(
            side_effect=AssertionError("No automatic AA refresh")
        )
        await service.preview(assessment)
        await service.preview(assessment)
        assert [provider.discoveries for provider in providers] == [1, 1]
        result = await service.delegate("one actual task", assessment)
        assert result["status"] == "completed"
        assert [provider.discoveries for provider in providers] == [2, 1]
        assert len(providers[0].prompts) == 1

    asyncio.run(scenario())


def test_context_disabled_and_subscription_cost_constraints(service_factory, assessment):
    async def scenario():
        service, _ = service_factory()
        candidates = await service.catalog.list(str(service._project(".")))
        task = TaskAssessment.model_validate({**assessment, "context_requirement": 1000})
        assert route(task, candidates, service.policy, CacheView()).selected is None
        task.context_requirement = None
        candidates[0].policy.cost_type = "subscription"
        candidates[0].policy.input_usd_per_million = 0
        candidates[0].policy.output_usd_per_million = 0
        task = TaskAssessment.model_validate(
            {
                **assessment,
                "budget": {
                    "max_usd": 1,
                    "input_tokens": 100,
                    "output_tokens": 100,
                },
            }
        )
        decision = route(task, candidates, service.policy, CacheView())
        assert decision.estimates[candidates[0].id]["usd"] is None
        for candidate in candidates:
            candidate.enabled = False
        assert route(task, candidates, service.policy, CacheView()).selected is None

    asyncio.run(scenario())


def test_different_benchmark_versions_use_explicit_fallback(service_factory, assessment):
    async def scenario():
        service, _ = service_factory()
        candidates = await service.catalog.list(str(service._project(".")))
        records = []
        for index, candidate in enumerate(candidates):
            candidate.model_version = "fixture-v1"
            candidate.policy.benchmark = BenchmarkBinding(
                record_id=str(index), model_version="fixture-v1", effort="high"
            )
            records.append(
                BenchmarkRecord(
                    id=str(index),
                    slug="fixture",
                    name="Fixture",
                    version=f"4.{index}",
                    effort="high",
                    scores={"artificial_analysis_coding_index": index * 50},
                )
            )
        snapshot = BenchmarkSnapshot(
            source_kind="local_import", retrieved_at=utcnow(), records=records
        )
        decision = route(
            TaskAssessment.model_validate(assessment),
            candidates,
            service.policy,
            CacheView(snapshot=snapshot),
        )
        assert decision.selected == service.policy.fallback_candidate
        assert any("not_comparable" in reason for reason in decision.reasons)

    asyncio.run(scenario())


def test_expired_deadline_and_maximum_upgrade_validation(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        result = await service.delegate(
            "task", {**assessment, "deadline": (utcnow() - timedelta(seconds=1)).isoformat()}
        )
        assert result["status"] == "rejected" and not providers[0].prompts

    asyncio.run(scenario())
    with pytest.raises(ValidationError):
        RoutingSettings(max_auto_upgrades=2)


def test_effects_and_explicit_selection_each_prevent_automatic_replay(
    service_factory,
    assessment,
    monkeypatch,
):
    monkeypatch.setattr("cleo.routing.execution.workspace_fingerprint", lambda _: "unchanged")

    async def scenario():
        service, providers = service_factory(
            policy={"automatic_upgrade": True},
            events=[{"type": "tool_call", "text": "external-effect"}],
        )
        for policy in service.policy.candidates.values():
            policy.replay_safe_read_only = True
        service._verify = AsyncMock(return_value=("failed", []))
        result = await service.delegate("task", assessment)
        assert result["attempts"] == 1 and not providers[1].prompts
        providers[0].events = ()
        result = await service.delegate("task", assessment, {"provider": "economy"})
        assert result["attempts"] == 1 and not providers[1].prompts

    asyncio.run(scenario())


def test_time_limit_is_not_a_model_upgrade(service_factory, assessment):
    async def scenario():
        service, providers = service_factory(
            behavior="wait",
            policy={
                "automatic_upgrade": True,
                "max_task_seconds": 1,
            },
        )
        result = await service.delegate("task", assessment)
        assert result["status"] == "timed_out" and result["failure_category"] == "time_limit"
        assert result["attempts"] == 1 and not providers[1].prompts

    asyncio.run(scenario())


def test_depth_and_project_boundaries_are_host_constraints(service_factory, assessment, tmp_path):
    async def scenario():
        service, _ = service_factory()
        with pytest.raises(ValueError, match="inside"):
            await service.preview(assessment, project_path=str(tmp_path.parent))
        service.store.update_manifest("parent", routing_depth=1)
        with pytest.raises(ValueError, match="depth"):
            await service.preview(assessment)

    asyncio.run(scenario())


def test_plan_parent_cannot_widen_child_permissions(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        service.store.update_manifest(
            "parent",
            provider="economy",
            runtime_options={
                "model": "main-model",
                "approval_mode": "plan",
            },
        )
        result = await service.delegate("read-only analysis", assessment)
        assert result["status"] == "completed"
        assert providers[0].prompts[0][2].sandbox == "read-only"
        assert service.store.load_manifest("parent")["runtime_options"]["model"] == "main-model"
        writing = {**assessment, "required_capabilities": ["text", "file_write"]}
        decision = await service.preview(writing)
        assert decision.selected is None
        result = await service.delegate("write a file", writing)
        assert result["status"] == "rejected"
        assert len(providers[0].prompts) == 1

    asyncio.run(scenario())


def test_native_cross_backend_and_acp_boundaries_fail_closed(service_factory):
    async def scenario():
        service, _ = service_factory()
        candidates = await service.catalog.list(str(service._project(".")))
        service.productivity.providers["native-parent"] = SimpleNamespace(type="claude_sdk")
        service.store.update_manifest("parent", provider="native-parent")
        scoped = service._constrain_parent(candidates)
        assert all(
            item.execution_restriction == "cross_backend_permission_authorization_required"
            for item in scoped
        )
        service.policy.allow_cross_backend_delegation = True
        assert all(
            item.execution_restriction is None for item in service._constrain_parent(candidates)
        )
        service.productivity.providers["native-parent"] = SimpleNamespace(type="acp")
        assert all(
            item.execution_restriction == "parent_acp_permission_boundary_unknown"
            for item in service._constrain_parent(candidates)
        )

    asyncio.run(scenario())
