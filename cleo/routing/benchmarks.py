"""Artificial Analysis v2 metadata, exact variant matching and offline-first caching."""

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

import httpx
from pydantic import Field, field_validator

from cleo.routing.catalog import atomic_json
from cleo.routing.credentials import read_key
from cleo.routing.models import Candidate, RoutingSettings, Schema, utcnow

AA_SOURCE = "https://artificialanalysis.ai"
AA_API = AA_SOURCE + "/api/v2/language/models"
_EFFORT = re.compile(r"\((none|minimal|low|medium|high|xhigh|max|ultra)\)$", re.I)


class BenchmarkRecord(Schema):
    id: str
    slug: str
    name: str
    family: Literal["model", "coding_agent"] = "model"
    harness: str | None = None
    harness_version: str | None = None
    effort: str | None = None
    version: str | None = None
    scores: dict[str, float | None] = Field(default_factory=dict)
    input_usd_per_million: float | None = Field(default=None, ge=0)
    output_usd_per_million: float | None = Field(default=None, ge=0)
    cache_hit_usd_per_million: float | None = Field(default=None, ge=0)
    cache_write_usd_per_million: float | None = Field(default=None, ge=0)
    benchmark_cost_per_task: float | None = Field(default=None, ge=0)
    output_tokens_per_second: float | None = Field(default=None, ge=0)
    latency_seconds: float | None = Field(default=None, ge=0)
    context_window: int | None = Field(default=None, gt=0)


class BenchmarkSnapshot(Schema):
    schema_version: Literal[1] = 1
    source: str = AA_SOURCE
    source_kind: Literal["official_api", "local_import"]
    retrieved_at: datetime
    data_as_of: datetime | None = None
    access_tier: str | None = None
    records: list[BenchmarkRecord]

    @field_validator("retrieved_at", "data_as_of")
    @classmethod
    def dated(cls, value):
        """Purpose: Keep freshness meaningful. Input: timestamp. Output: aware past time."""
        if value is not None and (value.tzinfo is None or value > utcnow()):
            raise ValueError("Snapshot timestamps must be timezone-aware and not in the future")
        return value


class CacheView(Schema):
    snapshot: BenchmarkSnapshot | None = None
    stale: bool = True
    error: str | None = None


def parse_api(payload: dict, *, retrieved_at: datetime | None = None) -> BenchmarkSnapshot:
    """Purpose: Parse the documented v2 model envelope. Input: API data. Output: safe snapshot.

    Unknown numeric evaluation keys are preserved as separate metrics. Missing values stay
    None. The model coding index is never relabeled as a complete coding-agent index.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ValueError("Expected the Artificial Analysis v2 model list envelope")
    version = payload.get("intelligence_index_version")
    if (
        not isinstance(version, (int, float))
        or isinstance(version, bool)
        or not math.isfinite(version)
        or payload.get("tier") not in {"free", "pro", "commercial"}
        or not isinstance(payload.get("pagination"), dict)
    ):
        raise ValueError("Missing v2 tier, version or pagination metadata")
    records = []
    for item in payload["data"]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("Expected a named model record")
        evaluations = item.get("evaluations") or {}
        pricing = item.get("pricing") or {}
        performance = item.get("performance") or {}
        costs = item.get("artificial_analysis_intelligence_index_cost") or {}
        if not all(isinstance(value, dict) for value in (evaluations, pricing, performance, costs)):
            raise ValueError("Expected model metric objects")
        task_cost = costs.get("cost_per_task") or {}
        if not isinstance(task_cost, dict):
            raise ValueError("Expected benchmark task cost object")
        match = _EFFORT.search(item["name"])
        records.append(
            BenchmarkRecord(
                id=item["id"],
                slug=item["slug"],
                name=item["name"],
                effort=match.group(1).lower() if match else None,
                version=str(version) if version is not None else None,
                scores={
                    key: value
                    for key, value in evaluations.items()
                    if value is None
                    or (isinstance(value, (int, float)) and not isinstance(value, bool))
                },
                input_usd_per_million=pricing.get("price_1m_input_tokens"),
                output_usd_per_million=pricing.get("price_1m_output_tokens"),
                cache_hit_usd_per_million=pricing.get("price_1m_cache_hit_tokens"),
                cache_write_usd_per_million=pricing.get("price_1m_cache_write_tokens"),
                benchmark_cost_per_task=task_cost.get("total_cost"),
                output_tokens_per_second=performance.get("median_output_tokens_per_second"),
                latency_seconds=performance.get("median_time_to_first_token_seconds"),
                context_window=item.get("context_window_tokens"),
            )
        )
    return BenchmarkSnapshot(
        source_kind="official_api",
        retrieved_at=retrieved_at or utcnow(),
        access_tier=payload.get("tier"),
        records=records,
    )


def match_record(candidate: Candidate, snapshot: BenchmarkSnapshot | None):
    """Purpose: Match a model/version/effort without fuzzy aliases. Output: record and status."""
    if snapshot is None:
        return None, "benchmark_missing"
    binding = candidate.policy.benchmark
    if binding is None or candidate.model_version is None:
        return None, "variant_unmatched: configure an exact model version and benchmark binding"
    if binding.model_version != candidate.model_version or binding.effort != candidate.effort:
        return None, "version_or_effort_mismatch"
    matches = [
        record
        for record in snapshot.records
        if record.id == binding.record_id
        and record.family == binding.family
        and record.effort == candidate.effort
        and (
            record.family != "coding_agent"
            or (
                record.harness == binding.harness == candidate.backend
                and record.harness_version is not None
                and record.harness_version == binding.harness_version == candidate.harness_version
            )
        )
    ]
    if len(matches) != 1 or not matches[0].version:
        return None, "benchmark_ambiguous_or_unversioned"
    return matches[0], "explicit_variant_match"


class BenchmarkCache:
    def __init__(
        self, path: Path, policy: RoutingSettings, *, transport=None, credential_path=None,
    ):
        """Purpose: Bind cache and secure API transport. Input: path/policy. Output: cache."""
        self.path, self.policy, self.transport = path, policy, transport
        self.credential_path = credential_path

    def read(self) -> CacheView:
        """Purpose: Load local metadata only. Input: none. Output: snapshot with freshness."""
        try:
            snapshot = BenchmarkSnapshot.model_validate_json(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return CacheView(error="benchmark_cache_missing")
        except (ValueError, OSError):
            return CacheView(error="benchmark_cache_invalid")
        age = (utcnow() - snapshot.retrieved_at).total_seconds()
        return CacheView(snapshot=snapshot, stale=age >= self.policy.cache_ttl_seconds)

    async def prepare(self) -> CacheView:
        """Purpose: Refresh missing/stale metadata once per bounded retry window.

        Input: Existing secure cache configuration. Output: new or last valid AA data, no inference.
        """
        from cleo.memory.repository import file_lock

        current = self.read()
        if not current.stale or not self.policy.auto_refresh_benchmarks:
            return current
        marker = self.path.with_name("benchmark-refresh.json")
        with file_lock(marker.with_suffix(".lock")):
            try:
                previous = json.loads(marker.read_text(encoding="utf-8"))
                age = (utcnow() - datetime.fromisoformat(previous["attempted_at"])).total_seconds()
                if 0 <= age < min(300, self.policy.cache_ttl_seconds):
                    return current.model_copy(update={"error": previous.get("error")})
            except (OSError, ValueError, TypeError, KeyError):
                pass
            atomic_json(marker, {"attempted_at": utcnow().isoformat(), "error": "refresh_pending"})
        # No lock is held while waiting on a network request. Other processes reuse old data.
        result = await self.refresh()
        atomic_json(marker, {"attempted_at": utcnow().isoformat(), "error": result.error})
        return result

    def import_snapshot(self, path: Path) -> CacheView:
        """Purpose: Import offline evidence. Input: local snapshot. Output: validated cache."""
        if path.stat().st_size > 8_000_000:
            raise ValueError("Benchmark snapshot exceeds 8 MB")
        snapshot = BenchmarkSnapshot.model_validate_json(path.read_text(encoding="utf-8"))
        snapshot.source_kind = "local_import"
        atomic_json(self.path, snapshot.model_dump(mode="json"))
        return self.read()

    async def refresh(self) -> CacheView:
        """Purpose: Manually refresh the documented API. Output: new or last valid snapshot.

        The API key is read only from server-side secure configuration. Exceptions
        and response bodies are never logged or returned. Delegation never calls this method.
        """
        previous = self.read()
        key = read_key(self.credential_path, self.policy.aa_key_env)
        if not key:
            return previous.model_copy(update={"error": "aa_api_key_missing"})
        endpoint = AA_API + ("/free" if self.policy.aa_access == "free" else "")
        data, version, tier = [], None, None
        try:
            async with httpx.AsyncClient(
                timeout=20, transport=self.transport, follow_redirects=False
            ) as client:
                for page in range(1, 21):
                    response = await client.get(
                        endpoint, headers={"x-api-key": key}, params={"page": page}
                    )
                    if response.status_code != 200:
                        return previous.model_copy(
                            update={"error": f"aa_http_{response.status_code}"}
                        )
                    payload = response.json()
                    current = parse_api(payload)
                    current_version = payload.get("intelligence_index_version")
                    if page > 1 and current_version != version:
                        raise ValueError("Index changed while paging")
                    version, tier = current_version, payload.get("tier")
                    data.extend(current.records)
                    pagination = payload.get("pagination") or {}
                    if pagination.get("page", page) != page:
                        raise ValueError("Unexpected pagination")
                    if not pagination.get("has_more", False):
                        break
                else:
                    raise ValueError("Too many pages")
            snapshot = BenchmarkSnapshot(
                source_kind="official_api", access_tier=tier, retrieved_at=utcnow(), records=data
            )
            atomic_json(self.path, snapshot.model_dump(mode="json"))
        except (httpx.HTTPError, ValueError, KeyError, TypeError, OSError):
            return previous.model_copy(update={"error": "aa_refresh_failed"})
        return self.read()
