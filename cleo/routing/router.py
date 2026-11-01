"""Deterministic policy ranking after hard constraints; benchmark scores are not probabilities."""

from typing import Any

from pydantic import Field

from cleo.routing.benchmarks import CacheView, match_record
from cleo.routing.models import (
    Candidate,
    RouteRequest,
    RoutingSettings,
    Schema,
    TaskAssessment,
    utcnow,
)

TIERS = {"economy": 0, "balanced": 1, "strong": 2}
METRICS = {
    "coding": "artificial_analysis_coding_index",
    "bug_fix": "artificial_analysis_coding_index",
    "terminal": "artificial_analysis_agentic_index",
    "research": "artificial_analysis_intelligence_index",
    "analysis": "artificial_analysis_intelligence_index",
    "exploration": "artificial_analysis_agentic_index",
}


class RouteDecision(Schema):
    context: dict[str, Any] | None = None
    candidate_ids: list[str] = Field(default_factory=list)
    selected: str | None = None
    alternatives: list[str] = Field(default_factory=list)
    upgrades: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    missing: dict[str, list[str]] = Field(default_factory=dict)
    rejected: dict[str, list[str]] = Field(default_factory=dict)
    estimates: dict[str, dict[str, Any]] = Field(default_factory=dict)
    benchmark: dict[str, Any] = Field(default_factory=dict)


def estimate(candidate: Candidate, assessment: TaskAssessment, benchmark=None):
    """Purpose: Keep estimates separate from invoices. Input: route/task. Output: soft estimate."""
    budget, policy = assessment.budget, candidate.policy
    tokens = assessment.token_estimate or budget
    input_price = policy.input_usd_per_million
    output_price = policy.output_usd_per_million
    speed = policy.output_tokens_per_second
    latency = policy.latency_seconds
    if benchmark is not None:
        input_price = input_price if input_price is not None else benchmark.input_usd_per_million
        output_price = (output_price if output_price is not None
                        else benchmark.output_usd_per_million)
        speed = speed if speed is not None else benchmark.output_tokens_per_second
        latency = latency if latency is not None else benchmark.latency_seconds
    usd = None
    if (
        policy.cost_type == "api"
        and tokens
        and tokens.input_tokens
        and tokens.output_tokens
        and input_price is not None
        and output_price is not None
    ):
        usd = (
            tokens.input_tokens * input_price
            + tokens.output_tokens * output_price
        ) / 1_000_000
    seconds = None
    if tokens and tokens.output_tokens and speed:
        seconds = tokens.output_tokens / speed + (latency or 0)
    return {
        "usd": usd,
        "seconds": seconds,
        "budget_enforcement": "soft",
        "cost_type": policy.cost_type,
        "source": "matched_benchmark_and_operator_token_estimates" if benchmark
        else "operator_pricing_and_token_estimates",
    }


def route(
    assessment: TaskAssessment,
    candidates: list[Candidate],
    policy: RoutingSettings,
    benchmarks: CacheView,
    request: RouteRequest | None = None,
) -> RouteDecision:
    """Purpose: Recommend a constrained child route. Input: validated requirements/policy.

    Output: a deterministic recommendation, explanations, exclusions and stronger alternatives.
    Evaluation text cannot alter connections, tools, sandbox settings or trusted policy.
    """
    request = request or RouteRequest()
    result = RouteDecision(
        benchmark={
            "source": benchmarks.snapshot.source if benchmarks.snapshot else None,
            "retrieved_at": benchmarks.snapshot.retrieved_at.isoformat()
            if benchmarks.snapshot
            else None,
            "stale": benchmarks.stale,
            "cache_error": benchmarks.error,
        }
    )
    result.candidate_ids = sorted(item.id for item in candidates)
    if benchmarks.stale and benchmarks.snapshot:
        result.reasons.append("using_stale_benchmark_cache; see_retrieval_time")
    explicit = any(value is not None for value in request.model_dump().values())
    eligible = []
    for candidate in sorted(candidates, key=lambda item: item.id):
        errors = []
        if candidate.execution_restriction:
            errors.append(candidate.execution_restriction)
        if not candidate.enabled or candidate.available is not True:
            errors.append("connection_disabled_unavailable_or_unchecked")
        if (
            candidate.checked_at is None
            or not 0
            <= (utcnow() - candidate.checked_at).total_seconds()
            < policy.catalog_ttl_seconds
        ):
            errors.append("connection_check_expired")
        for capability in sorted(assessment.required_capabilities):
            if candidate.capabilities.get(capability) is not True:
                errors.append(f"required_capability_unavailable_or_unknown:{capability}")
        if assessment.context_requirement and (
            candidate.context_window is None
            or candidate.context_window < assessment.context_requirement
        ):
            errors.append("context_insufficient_or_unknown")
        for field in ("candidate_id", "provider", "model", "effort"):
            expected = getattr(request, field)
            actual = candidate.id if field == "candidate_id" else getattr(candidate, field)
            if expected is not None and expected != actual:
                errors.append(f"explicit_{field}_mismatch")
        matched, _ = match_record(candidate, benchmarks.snapshot)
        estimated = estimate(candidate, assessment, matched)
        result.estimates[candidate.id] = estimated
        limit = min(
            value
            for value in [
                assessment.budget.max_usd if assessment.budget else float("inf"),
                policy.max_soft_budget_usd or float("inf"),
            ]
        )
        if assessment.budget and assessment.budget.mode == "hard":
            errors.append("hard_usd_budget_not_supported_by_harness")
        if estimated["usd"] is not None and estimated["usd"] > limit:
            errors.append("soft_budget_estimate_exceeds_limit")
        if assessment.deadline and assessment.deadline <= utcnow():
            errors.append("deadline_expired")
        if errors:
            result.rejected[candidate.id] = errors
        else:
            eligible.append(candidate)
    if not eligible:
        result.reasons.append(
            "explicit_selection_unavailable"
            if explicit
            else "no_candidate_satisfies_hard_constraints"
        )
        return result
    target = policy.complexity_tiers[assessment.complexity]
    if assessment.failure_impact == "high":
        target = "strong"
    if not explicit:
        eligible = [item for item in eligible if TIERS[item.policy.tier] >= TIERS[target]]
    if not eligible:
        result.reasons.append(f"no_candidate_in_required_operator_tier:{target}")
        return result
    metric = METRICS[assessment.task_type]
    records = {}
    for item in eligible:
        record, match = match_record(item, benchmarks.snapshot)
        missing = []
        score_key = (
            "coding_agent_index"
            if record
            and record.family == "coding_agent"
            and assessment.task_type in {"coding", "bug_fix", "terminal", "exploration"}
            else metric
        )
        if record is None or record.scores.get(score_key) is None:
            missing.append(match if record is None else f"metric_missing:{score_key}")
        else:
            records[item.id] = (record, record.scores[score_key])
        if result.estimates[item.id]["usd"] is None:
            missing.append("task_cost_unknown; subscription_is_not_free")
        if result.estimates[item.id]["seconds"] is None:
            missing.append("task_duration_unknown")
        result.missing[item.id] = missing
    comparable = (
        len(records) == len(eligible)
        and len({(record.family, record.version) for record, _ in records.values()}) == 1
    )
    if not comparable:
        result.reasons.append("benchmark_missing_or_not_comparable; no_scores_imputed")
    unknown_preference = (
        policy.preference == "cost"
        and any(result.estimates[item.id]["usd"] is None for item in eligible)
        or policy.preference == "latency"
        and any(result.estimates[item.id]["seconds"] is None for item in eligible)
        or any(
            (assessment.budget or policy.max_soft_budget_usd)
            and result.estimates[item.id]["usd"] is None
            for item in eligible
        )
    )
    fallback = next((item for item in eligible if item.id == policy.fallback_candidate), None)
    conservative = not comparable or unknown_preference
    if conservative and not explicit and fallback is None:
        result.reasons.append("configure_an_eligible_conservative_fallback")
        return result

    def ordering(item):
        """Purpose: Define a stable lexicographic policy. Input: candidate. Output: sort key."""
        quality = -records[item.id][1] if comparable else 0
        cost = result.estimates[item.id]["usd"]
        duration = result.estimates[item.id]["seconds"]
        preference = {
            "quality": (quality,),
            "cost": (cost if cost is not None else float("inf"), quality),
            "latency": (duration if duration is not None else float("inf"), quality),
        }[policy.preference]
        return (TIERS[item.policy.tier] - TIERS[target], *preference, item.id)

    ordered = sorted(eligible, key=ordering)
    selected = fallback if conservative and not explicit else ordered[0]
    result.selected = selected.id
    result.alternatives = [item.id for item in ordered if item.id != selected.id]
    result.upgrades = [
        item.id for item in ordered if TIERS[item.policy.tier] > TIERS[selected.policy.tier]
    ]
    result.reasons.extend(
        [
            "explicit_selection_honored"
            if explicit
            else (
                "conservative_operator_fallback"
                if conservative
                else f"operator_tier:{target}; comparable_metric:{metric}"
            ),
            f"preference:{policy.preference}; stable_id_tiebreak; budget_estimates_are_soft",
        ]
    )
    result.benchmark["matches"] = {
        key: {"record_id": record.id, "family": record.family, "version": record.version}
        for key, (record, _) in records.items()
    }
    return result
