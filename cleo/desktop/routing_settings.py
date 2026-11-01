"""Credential-free desktop controls over the existing routing policy and catalog."""

import hashlib
import json
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr

from cleo.routing.benchmarks import BenchmarkCache, match_record
from cleo.routing.catalog import CandidateCatalog
from cleo.routing.context import reference_records
from cleo.routing.credentials import read_key, save_key
from cleo.routing.evaluator import evaluator_profile
from cleo.routing.feedback import FeedbackStore, project_key
from cleo.routing.models import (
    BenchmarkBinding,
    CandidatePolicy,
    EvaluatorSettings,
    FeedbackUpdate,
    Schema,
    load_policy,
    save_policy,
)


class CandidateUpdate(Schema):
    id: str
    enabled: bool
    tier: Literal["economy", "balanced", "strong"]
    modelVersion: str | None = Field(default=None, min_length=1, max_length=200)
    benchmarkRecordId: str | None = None


class SettingsUpdate(Schema):
    revision: str
    enabled: bool
    preference: Literal["quality", "cost", "latency"]
    fallbackCandidate: str | None
    candidates: list[CandidateUpdate]
    defaultMode: Literal["manual", "auto"] | None = None
    permissionPreset: Literal["inherit", "ask", "review", "full"] | None = None
    evaluator: EvaluatorSettings | None = None
    strategy: Literal["rules", "evaluator"] | None = None
    feedbackEnabled: bool | None = None
    taskTrackingEnabled: bool | None = None


class BenchmarkConnectionUpdate(Schema):
    revision: str
    access: Literal["free", "pro"]
    cacheTtlSeconds: int = Field(ge=60, le=2592000)
    apiKey: SecretStr | None = None
    clearKey: bool = False


class RoutingControls:
    def __init__(self, settings, store, adapter):
        """Purpose: Bind local controls. Input: desktop services. Output: scoped settings API."""
        self.settings, self.store, self.adapter = settings, store, adapter
        self.path = Path(settings.PROFILE_DIR).with_name("routing.json")
        self.state = Path(store.memory_root) / ".routing"
        self.credential_path = self.path.with_name("benchmark-credentials.json")

    def benchmark_cache(self, policy):
        """Purpose: Share secure AA configuration. Input: policy. Output: local cache adapter."""
        return BenchmarkCache(
            self.state / "benchmarks.json", policy, credential_path=self.credential_path,
        )

    def revision(self):
        """Purpose: Detect edits from another window/CLI. Output: opaque policy revision."""
        content = b"\0".join(
            path.read_bytes() if path.exists() else b""
            for path in (self.path, self.path.with_name("routing-execution.json"),
                         self.path.with_name("routing-v2.json"),
                         self.path.with_name("routing-permissions.json"),
                         self.path.with_name("task-tracking.json"))
        )
        return hashlib.sha256(content).hexdigest()

    async def view(self, refresh=False):
        """Purpose: Show policy and metadata without inference. Output: credential-free view."""
        revision = self.revision()
        policy = load_policy(self.path)
        catalog = CandidateCatalog(
            self.adapter, self.settings.productivity, policy, self.state / "catalog.json"
        )
        candidates = await catalog.list(
            str(Path(self.settings.active_directory_profile.root_path).resolve()), refresh=refresh
        )
        view = self.benchmark_cache(policy).read()
        entries = []
        for item in candidates:
            record, matched = match_record(item, view.snapshot)
            grade, references, _ = reference_records(item, view.snapshot)
            entries.append(
                {
                    "id": item.id,
                    "provider": item.provider,
                    "connection": item.connection,
                    "backend": item.backend,
                    "model": item.model,
                    "effort": item.effort,
                    "enabled": item.enabled,
                    "tier": item.policy.tier,
                    "available": item.available,
                    "costType": item.policy.cost_type,
                    "checkedAt": item.checked_at.isoformat() if item.checked_at else None,
                    "statusReason": item.status_reason,
                    "availabilitySource": item.availability_source,
                    "benchmarkMatch": matched,
                    "referenceGrade": grade,
                    "referenceRecords": [reference.model_dump(mode="json")
                                         for reference in references],
                    "benchmarkVersion": record.version if record else None,
                    "modelVersion": item.model_version,
                    "benchmarkRecordId": item.policy.benchmark.record_id
                    if item.policy.benchmark else None,
                }
            )
        return {
            "revision": revision,
            "enabled": policy.enabled,
            "strategy": policy.strategy,
            "feedbackEnabled": policy.feedback_enabled,
            "taskTrackingEnabled": policy.task_tracking_enabled,
            "feedbackMinSamples": policy.feedback_min_samples,
            "feedbackWeightCap": policy.feedback_weight_cap,
            "defaultMode": policy.default_mode,
            "permissionPreset": policy.permission_preset,
            "evaluator": policy.evaluator.model_dump(mode="json"),
            "evaluatorDefault": {
                "id": self.settings.active_profiles.agent,
                "label": self.settings.active_agent_profile.display_name
                or self.settings.active_profiles.agent,
                "model": self.settings.active_agent_profile.model,
                "backend": self.settings.active_agent_profile.backend,
            } if getattr(self.settings, "active_profiles", None) else None,
            "evaluatorConnections": [
                {"id": name, "label": profile.display_name or name, "backend": profile.backend,
                 "models": profile.available_models}
                for name, profile in getattr(
                    getattr(self.settings, "profiles", None), "agents", {},
                ).items()
                if profile.backend in {"api", "codex", "claude_code"}
            ],
            "preference": policy.preference,
            "fallbackCandidate": policy.fallback_candidate,
            "automaticUpgrade": policy.automatic_upgrade,
            "crossBackendDelegation": policy.allow_cross_backend_delegation,
            "candidates": entries,
            "benchmark": {
                "source": view.snapshot.source if view.snapshot else None,
                "retrievedAt": view.snapshot.retrieved_at.isoformat() if view.snapshot else None,
                "stale": view.stale,
                "error": view.error,
                "recordCount": len(view.snapshot.records) if view.snapshot else 0,
                "keyConfigured": bool(read_key(self.credential_path, policy.aa_key_env)),
                "access": policy.aa_access,
                "cacheTtlSeconds": policy.cache_ttl_seconds,
                "records": [item.model_dump(mode="json") for item in view.snapshot.records]
                if view.snapshot else [],
            },
            "recentTasks": self.recent_tasks(),
        }

    def recent_tasks(self):
        """Purpose: Show ordinary task outcomes. Output: bounded summaries, without task text."""
        records = []
        paths = sorted(
            (self.state / "tasks").glob("task_*.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )[:10]
        for path in paths:
            try:
                if path.stat().st_size > 256_000:
                    continue
                item = json.loads(path.read_text(encoding="utf-8"))
                records.append(
                    {
                        "id": item["task_id"],
                        "status": item["status"],
                        "acceptance": item.get("acceptance", "unknown"),
                        "candidate": item.get("final_candidate_id")
                        or item.get("decision", {}).get("selected"),
                        "createdAt": item.get("created_at"),
                        "feedback": FeedbackStore(self.state).read(item["task_id"]),
                        "taskType": item.get("assessment", {}).get("task_type"),
                        "reasons": item.get("decision", {}).get("reasons", []),
                    }
                )
            except (OSError, ValueError, KeyError):
                continue
        return records

    async def submit_feedback(self, update):
        """Purpose: Accept explicit local user attribution for a finished workspace task.

        Input: Validated task ID, outcome and revision. Output: refreshed settings.
        """
        update = FeedbackUpdate.model_validate(update)
        path = self.state / "tasks" / f"{update.task_id}.json"
        if path.stat().st_size > 256_000:
            raise ValueError("Task record too large")
        record = json.loads(path.read_text(encoding="utf-8"))
        root = self.settings.active_directory_profile.root_path
        if record.get("project_key") != project_key(root):
            raise ValueError("只能反馈当前工作区的任务。")
        if not record.get("final_candidate_id"):
            raise ValueError("尚无执行结果。")
        FeedbackStore(self.state).submit(record, update, source="user")
        return await self.view()

    async def save(self, update):
        """Purpose: Persist explicit user changes. Input: validated edits. Output: fresh view."""
        update = SettingsUpdate.model_validate(update)
        view = await self.view()
        if update.revision != self.revision():
            raise ValueError("路由配置已变化，请重新加载后保存。")
        policy = load_policy(self.path)
        if update.strategy is not None:
            policy.strategy = update.strategy
        if update.feedbackEnabled is not None:
            policy.feedback_enabled = update.feedbackEnabled
        if update.taskTrackingEnabled is not None:
            policy.task_tracking_enabled = update.taskTrackingEnabled
        if update.evaluator is not None:
            if update.evaluator.mode == "independent":
                evaluator_profile(self.settings, update.evaluator)
            policy.evaluator = update.evaluator
        if update.defaultMode is not None:
            policy.default_mode = update.defaultMode
        if update.permissionPreset is not None:
            policy.permission_preset = update.permissionPreset
        known = {item["id"]: item for item in view["candidates"]}
        if len({item.id for item in update.candidates}) != len(update.candidates):
            raise ValueError("候选配置不能重复。")
        for item in update.candidates:
            if item.id not in known or (item.enabled and known[item.id]["available"] is not True):
                raise ValueError("候选不存在或目录不可用，请先刷新执行目录。")
            original = policy.candidates.get(
                item.id, CandidatePolicy(cost_type=known[item.id]["costType"])
            )
            policy.candidates[item.id] = original.model_copy(
                update={"enabled": item.enabled if known[item.id]["available"] is True
                        else original.enabled, "tier": item.tier}
            )
            if "benchmarkRecordId" in item.model_fields_set and (
                item.benchmarkRecordId != (
                    original.benchmark.record_id if original.benchmark else None
                )
                or item.modelVersion != original.model_version
            ):
                target = policy.candidates[item.id]
                if item.benchmarkRecordId is None:
                    target.benchmark = None
                    target.model_version = None
                else:
                    snapshot = self.benchmark_cache(policy).read().snapshot
                    matches = [record for record in (snapshot.records if snapshot else [])
                               if record.id == item.benchmarkRecordId and record.family == "model"
                               and record.effort == known[item.id]["effort"] and record.version]
                    if len(matches) != 1 or not item.modelVersion:
                        raise ValueError("请选择唯一的同推理档位评测，并确认实际模型版本。")
                    target.model_version = item.modelVersion
                    target.benchmark = BenchmarkBinding(
                        record_id=item.benchmarkRecordId, model_version=item.modelVersion,
                        effort=known[item.id]["effort"],
                    )
        if update.enabled:
            fallback = policy.candidates.get(update.fallbackCandidate)
            if not fallback or not fallback.enabled or update.fallbackCandidate not in known:
                raise ValueError("开启路由前，请选择一个已启用的保守回退配置。")
            if known[update.fallbackCandidate]["available"] is not True:
                raise ValueError("保守回退的执行目录当前不可用。")
        policy.enabled, policy.preference = update.enabled, update.preference
        policy.fallback_candidate = update.fallbackCandidate
        save_policy(self.path, policy)
        if hasattr(self.adapter, "provider_settings"):
            from cleo.integrations.harnesses.factory import sync_providers

            sync_providers(
                self.adapter,
                self.settings.productivity.model_copy(
                    update={"providers": dict(self.adapter.provider_settings)}
                ),
            )
        return await self.view()

    async def refresh_benchmarks(self):
        """Purpose: Refresh only by explicit action. Output: cache metadata, never credentials."""
        policy = load_policy(self.path)
        result = await self.benchmark_cache(policy).refresh()
        view = await self.view()
        view["benchmark"]["error"] = result.error
        return view

    async def save_benchmark_connection(self, update):
        """Purpose: Save explicit AA credentials/settings. Output: metadata without the key."""
        update = BenchmarkConnectionUpdate.model_validate(update)
        if update.revision != self.revision():
            raise ValueError("路由配置已变化，请重新加载后保存。")
        key = update.apiKey.get_secret_value().strip() if update.apiKey is not None else ""
        if len(key) > 4096 or (update.clearKey and key):
            raise ValueError("Benchmark 密钥设置无效。")
        policy = load_policy(self.path)
        policy.aa_access = update.access
        policy.cache_ttl_seconds = update.cacheTtlSeconds
        if key:
            save_key(self.credential_path, key)
        elif update.clearKey:
            self.credential_path.unlink(missing_ok=True)
        save_policy(self.path, policy)
        return await self.view()
