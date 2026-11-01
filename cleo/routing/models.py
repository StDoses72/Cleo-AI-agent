"""Validated routing inputs, trusted policy and credential-free execution metadata."""

from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True, allow_inf_nan=False)


class Budget(Schema):
    max_usd: float = Field(gt=0)
    mode: Literal["soft", "hard"] = "soft"
    input_tokens: int | None = Field(default=None, gt=0)
    output_tokens: int | None = Field(default=None, gt=0)


class TokenEstimate(Schema):
    input_tokens: int | None = Field(default=None, gt=0)
    output_tokens: int | None = Field(default=None, gt=0)


class TaskAssessment(Schema):
    part: str | None = Field(default=None, min_length=1, max_length=80)
    task_type: Literal["coding", "bug_fix", "terminal", "research", "analysis", "exploration"]
    complexity: Literal["low", "medium", "high", "unknown"]
    required_capabilities: set[str] = Field(default_factory=set, max_length=30)
    context_requirement: int | None = Field(default=None, gt=0)
    uncertainty: Literal["low", "medium", "high", "unknown"] = "unknown"
    failure_impact: Literal["low", "medium", "high"] = "medium"
    acceptance_criteria: list[str] = Field(min_length=1, max_length=20)
    budget: Budget | None = None
    token_estimate: TokenEstimate | None = None
    deadline: datetime | None = None

    @field_validator("part")
    @classmethod
    def part_label(cls, value):
        """Purpose: Retain a safe responsibility label. Input: optional brief. Output: label."""
        if value is None:
            return None
        from cleo.runtime.task_tracking import task_abstract

        result = task_abstract(value)
        if not result:
            raise ValueError("part must be nonblank")
        return result

    @field_validator("acceptance_criteria")
    @classmethod
    def criteria(cls, values):
        """Purpose: Bound assessment text. Input: criteria. Output: nonblank requirements."""
        if any(not value.strip() or len(value) > 1000 for value in values):
            raise ValueError("Acceptance criteria must be nonblank and at most 1000 characters")
        return values

    @field_validator("deadline")
    @classmethod
    def timezone(cls, value):
        """Purpose: Prevent ambiguous deadlines. Input: date. Output: timezone-aware date."""
        if value is not None and value.tzinfo is None:
            raise ValueError("deadline must include a timezone")
        return value


class BenchmarkBinding(Schema):
    record_id: str
    model_version: str
    effort: str | None = None
    family: Literal["model", "coding_agent"] = "model"
    harness: str | None = None
    harness_version: str | None = None


class CandidatePolicy(Schema):
    enabled: bool = True
    tier: Literal["economy", "balanced", "strong"] = "balanced"
    model_version: str | None = None
    harness_version: str | None = None
    capabilities: dict[str, bool | None] = Field(default_factory=dict)
    context_window: int | None = Field(default=None, gt=0)
    cost_type: Literal["api", "subscription", "unknown"] = "unknown"
    input_usd_per_million: float | None = Field(default=None, ge=0)
    output_usd_per_million: float | None = Field(default=None, ge=0)
    cache_hit_usd_per_million: float | None = Field(default=None, ge=0)
    cache_write_usd_per_million: float | None = Field(default=None, ge=0)
    output_tokens_per_second: float | None = Field(default=None, gt=0)
    latency_seconds: float | None = Field(default=None, ge=0)
    benchmark: BenchmarkBinding | None = None
    replay_safe_read_only: bool = False


class VerificationCheck(Schema):
    argv: list[str] = Field(min_length=1, max_length=30)
    timeout_seconds: int = Field(default=60, ge=1, le=600)
    read_only: bool = False


class EvaluatorSettings(Schema):
    mode: Literal["default", "main", "independent"] = "default"
    profile_id: str | None = None
    model: str | None = None
    timeout_seconds: int = Field(default=60, ge=5, le=180)


class RoutingSettings(Schema):
    enabled: bool = False
    strategy: Literal["rules", "evaluator"] = "rules"
    auto_refresh_benchmarks: bool = True
    task_tracking_enabled: bool = False
    feedback_enabled: bool = True
    feedback_min_samples: int = Field(default=5, ge=1, le=100)
    feedback_weight_cap: float = Field(default=0.15, ge=0, le=0.15)
    default_mode: Literal["manual", "auto"] = "auto"
    permission_preset: Literal["inherit", "ask", "review", "full"] = "inherit"
    evaluator: EvaluatorSettings = Field(default_factory=EvaluatorSettings)
    cache_ttl_seconds: int = Field(default=86400, ge=1, le=2592000)
    catalog_ttl_seconds: int = Field(default=300, ge=1, le=86400)
    aa_key_env: str = Field(default="ARTIFICIAL_ANALYSIS_API_KEY", pattern=r"^[A-Z][A-Z0-9_]*$")
    aa_access: Literal["free", "pro"] = "free"
    candidates: dict[str, CandidatePolicy] = Field(default_factory=dict)
    fallback_candidate: str | None = None
    complexity_tiers: dict[str, Literal["economy", "balanced", "strong"]] = Field(
        default_factory=lambda: {
            "low": "economy",
            "medium": "balanced",
            "high": "strong",
            "unknown": "strong",
        }
    )
    preference: Literal["quality", "cost", "latency"] = "quality"
    max_auto_upgrades: int = Field(default=1, ge=0, le=1)
    automatic_upgrade: bool = False
    allow_cross_backend_delegation: bool = False
    max_depth: int = Field(default=1, ge=1, le=3)
    max_task_seconds: int = Field(default=600, ge=1, le=3600)
    max_soft_budget_usd: float | None = Field(default=None, gt=0)
    checks: dict[str, VerificationCheck] = Field(default_factory=dict)
    checks_by_task_type: dict[str, list[str]] = Field(default_factory=dict)

    @field_validator("complexity_tiers")
    @classmethod
    def all_tiers(cls, value):
        """Purpose: Require a total complexity policy. Input: tier map. Output: validated map."""
        if set(value) != {"low", "medium", "high", "unknown"}:
            raise ValueError("Configure all four complexity tiers")
        return value


class Candidate(Schema):
    id: str
    connection: str
    provider: str
    backend: str
    model: str
    model_version: str | None = None
    harness_version: str | None = None
    effort: str | None = None
    enabled: bool = True
    available: bool | None = None
    checked_at: datetime | None = None
    capabilities: dict[str, bool | None] = Field(default_factory=dict)
    context_window: int | None = None
    policy: CandidatePolicy = Field(default_factory=CandidatePolicy)
    quota: dict[str, float | str | None] | None = None
    status_reason: str | None = None
    execution_restriction: str | None = None
    availability_scope: str | None = None
    availability_source: str = "catalog_only"


class RouteRequest(Schema):
    candidate_id: str | None = None
    provider: str | None = None
    model: str | None = None
    effort: str | None = None


class ModelRecommendation(Schema):
    context_id: str = Field(pattern=r"^ctx_[a-f0-9]{64}$")
    candidate_id: str = Field(min_length=1, max_length=400)
    rationale: str = Field(min_length=1, max_length=800)
    evidence_refs: list[str] = Field(min_length=1, max_length=12)
    alternatives: list[str] = Field(default_factory=list, max_length=5)
    uncertainty: Literal["low", "medium", "high"] = "high"
    evaluation_id: str | None = Field(default=None, pattern=r"^eval_[a-f0-9]{32}$")
    item_key: str | None = Field(default=None, min_length=1, max_length=80)


class EvaluatedTask(Schema):
    assessment: TaskAssessment
    recommendation: ModelRecommendation


class FeedbackUpdate(Schema):
    task_id: str = Field(pattern=r"^task_[a-f0-9]{32}$")
    outcome: Literal["passed", "failed", "requirements_changed", "unknown", "retracted"]
    attribution: Literal["executor", "selection", "decomposition", "handoff",
                         "environment", "requirements", "unknown"] = "unknown"
    revision: int | None = Field(default=None, ge=0)


V2_FIELDS = {"strategy", "auto_refresh_benchmarks", "feedback_enabled",
             "feedback_min_samples", "feedback_weight_cap"}


def utcnow() -> datetime:
    """Purpose: Use UTC in cache/attempt metadata. Input: none. Output: aware timestamp."""
    return datetime.now(UTC)


def load_policy(path: Path) -> RoutingSettings:
    """Purpose: Read trusted operator policy. Input: path. Output: validated policy/defaults."""
    policy = (RoutingSettings.model_validate_json(path.read_text(encoding="utf-8"))
              if path.is_file() else RoutingSettings())
    extension = path.with_name("routing-execution.json")
    if extension.is_file():
        import json

        extra = json.loads(extension.read_text(encoding="utf-8"))
        if not isinstance(extra, dict) or set(extra) - {
            "default_mode", "evaluator", "permission_preset",
        }:
            raise ValueError("Invalid routing execution settings")
        policy = RoutingSettings.model_validate({**policy.model_dump(), **extra})
    permissions = path.with_name("routing-permissions.json")
    if permissions.is_file():
        import json

        extra = json.loads(permissions.read_text(encoding="utf-8"))
        if not isinstance(extra, dict) or set(extra) != {"preset"}:
            raise ValueError("Invalid routing permission settings")
        policy = RoutingSettings.model_validate({
            **policy.model_dump(), "permission_preset": extra["preset"],
        })
    tracking = path.with_name("task-tracking.json")
    if tracking.is_file():
        import json

        extra = json.loads(tracking.read_text(encoding="utf-8"))
        if (not isinstance(extra, dict) or set(extra) != {"enabled"}
                or not isinstance(extra["enabled"], bool)):
            raise ValueError("Invalid task tracking settings")
        policy = policy.model_copy(update={"task_tracking_enabled": extra["enabled"]})
    v2 = path.with_name("routing-v2.json")
    if v2.is_file():
        import json

        extra = json.loads(v2.read_text(encoding="utf-8"))
        if not isinstance(extra, dict) or set(extra) - V2_FIELDS:
            raise ValueError("Invalid routing strategy settings")
        policy = RoutingSettings.model_validate({**policy.model_dump(), **extra})
    return policy


def save_policy(path: Path, policy: RoutingSettings):
    """Purpose: Persist settings while older Cleo versions can still read the base policy."""
    from cleo.routing.catalog import atomic_json

    payload = policy.model_dump(mode="json")
    atomic_json(path.with_name("task-tracking.json"),
                {"enabled": payload.pop("task_tracking_enabled")})
    advanced = {key: payload.pop(key) for key in V2_FIELDS}
    extension = {key: payload.pop(key) for key in (
        "default_mode", "evaluator",
    )}
    atomic_json(path.with_name("routing-permissions.json"),
                {"preset": payload.pop("permission_preset")})
    atomic_json(path.with_name("routing-v2.json"), advanced)
    atomic_json(path.with_name("routing-execution.json"), extension)
    atomic_json(path, payload)


def execution_mode(policy: RoutingSettings, manifest: dict | None = None) -> str:
    """Purpose: Resolve the host-owned session switch. Output: manual or automatic routing."""
    requested = ((manifest or {}).get("runtime_options") or {}).get("routing_mode")
    return "auto" if policy.enabled and (requested or policy.default_mode) == "auto" else "manual"
