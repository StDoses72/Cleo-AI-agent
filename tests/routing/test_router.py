import asyncio
from datetime import timedelta

import pytest
from pydantic import ValidationError

from cleo.routing.benchmarks import BenchmarkRecord, BenchmarkSnapshot, CacheView, match_record
from cleo.routing.models import (
    BenchmarkBinding,
    CandidatePolicy,
    RouteRequest,
    TaskAssessment,
    utcnow,
)
from cleo.routing.router import route


def test_exact_aa_prices_feed_estimates_without_subscription_zero_cost(assessment):
    from cleo.routing.models import Candidate
    from cleo.routing.router import estimate

    task = TaskAssessment.model_validate({**assessment, "budget": {
        "max_usd": 1, "input_tokens": 1000, "output_tokens": 1000,
    }})
    candidate = Candidate(
        id="api/model@high", connection="api", provider="fixture", backend="codex_sdk",
        model="model", policy=CandidatePolicy(cost_type="api"),
    )
    record = BenchmarkRecord(
        id="aa", slug="model", name="Model (high)", effort="high", version="4.3",
        input_usd_per_million=1, output_usd_per_million=2,
        output_tokens_per_second=100, latency_seconds=0.5,
    )
    result = estimate(candidate, task, record)
    assert result["usd"] == 0.003 and result["seconds"] == 10.5
    task.budget = None
    from cleo.routing.models import TokenEstimate

    task.token_estimate = TokenEstimate(input_tokens=1000, output_tokens=1000)
    assert estimate(candidate, task, record)["usd"] == 0.003
    candidate.policy.cost_type = "subscription"
    assert estimate(candidate, task, record)["usd"] is None


def test_filter_explicit_and_capabilities(service_factory, assessment, tmp_path):
    async def scenario():
        service, _ = service_factory()
        candidates = await service.catalog.list(str(tmp_path))
        task = TaskAssessment.model_validate({**assessment, "required_capabilities": ["image"]})
        decision = route(task, candidates, service.policy, CacheView())
        assert decision.selected is None
        assert all(
            "required_capability_unavailable_or_unknown:image" in errors
            for errors in decision.rejected.values()
        )
        task = TaskAssessment.model_validate(assessment)
        decision = route(
            task, candidates, service.policy, CacheView(), RouteRequest(provider="missing")
        )
        assert decision.selected is None and "explicit_selection_unavailable" in decision.reasons
        selected = route(
            task, candidates, service.policy, CacheView(), RouteRequest(provider="strong")
        )
        assert selected.selected.startswith("strong/")
        old = [
            item.model_copy(update={"checked_at": utcnow() - timedelta(days=1)})
            for item in candidates
        ]
        assert route(task, old, service.policy, CacheView()).selected is None

    asyncio.run(scenario())


def test_unknown_and_hard_budgets_do_not_become_zero_cost(service_factory, assessment, tmp_path):
    async def scenario():
        service, _ = service_factory()
        candidates = await service.catalog.list(str(tmp_path))
        task = TaskAssessment.model_validate(
            {**assessment, "budget": {"max_usd": 1, "mode": "soft"}}
        )
        decision = route(task, candidates, service.policy, CacheView())
        assert decision.selected == service.policy.fallback_candidate
        assert decision.estimates[decision.selected]["usd"] is None
        task.budget.mode = "hard"
        assert route(task, candidates, service.policy, CacheView()).selected is None

    asyncio.run(scenario())


def test_determinism_fallback_unknown_score_and_variant_matching(
    service_factory, assessment, tmp_path
):
    async def scenario():
        service, _ = service_factory()
        candidates = await service.catalog.list(str(tmp_path))
        task = TaskAssessment.model_validate(assessment)
        first = route(task, candidates, service.policy, CacheView())
        assert (
            first.selected
            == route(task, list(reversed(candidates)), service.policy, CacheView()).selected
        )
        assert first.selected == service.policy.fallback_candidate
        service.policy.fallback_candidate = None
        assert route(task, candidates, service.policy, CacheView()).selected is None
        candidate = candidates[0].model_copy(
            update={
                "model_version": "pinned-v1",
                "policy": CandidatePolicy(
                    tier="economy",
                    benchmark=BenchmarkBinding(
                        record_id="fixture", model_version="pinned-v1", effort="high"
                    ),
                ),
            }
        )
        snapshot = BenchmarkSnapshot(
            source_kind="local_import",
            retrieved_at=utcnow(),
            records=[
                BenchmarkRecord(
                    id="fixture",
                    slug="fixture",
                    name="Fixture high",
                    effort="low",
                    version="4.3",
                    scores={"artificial_analysis_coding_index": None},
                )
            ],
        )
        assert match_record(candidate, snapshot)[0] is None
        snapshot.records[0].effort = "high"
        assert match_record(candidate, snapshot)[0] is not None
        assert (
            route(task, [candidate], service.policy, CacheView(snapshot=snapshot)).selected is None
        )
        snapshot.records[0].scores["artificial_analysis_coding_index"] = -1
        assert (
            route(task, [candidate], service.policy, CacheView(snapshot=snapshot)).selected
            == candidate.id
        )

    asyncio.run(scenario())


def test_assessment_cannot_grant_permissions(assessment):
    with pytest.raises(ValidationError):
        TaskAssessment.model_validate({**assessment, "sandbox": "full-access"})
    with pytest.raises(ValidationError):
        TaskAssessment.model_validate({**assessment, "acceptance_criteria": [""]})
