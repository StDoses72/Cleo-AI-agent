"""One constrained delegation path over the existing adapter, with observational records."""

import asyncio
import hashlib
import math
import subprocess
import uuid
from pathlib import Path

from cleo.harnesses.availability import unsupported_reason
from cleo.harnesses.events import CONTEXT_USAGE_EVENTS
from cleo.routing.benchmarks import BenchmarkCache
from cleo.routing.catalog import CandidateCatalog, atomic_json
from cleo.routing.context import build_context, validate_recommendation
from cleo.routing.evaluator import SubtaskEvaluator
from cleo.routing.feedback import FeedbackStore, project_key
from cleo.routing.models import RouteRequest, TaskAssessment, execution_mode, utcnow
from cleo.routing.permissions import native_permissions, routing_preset
from cleo.routing.router import route
from cleo.runtime.task_usage import normalize_call_usage


def workspace_fingerprint(root: Path):
    """Purpose: Detect repository changes before replay. Input: cwd. Output: digest or unknown.

    This is only one retry gate: unknown tool effects independently prohibit replay.
    No Git repository, unreadable files, external links or large snapshots fail closed.
    """
    try:
        digest = hashlib.sha256()
        for args in (["diff", "--binary", "HEAD"], ["status", "--porcelain=v1", "-z"]):
            result = subprocess.run(
                ["git", "-C", str(root), *args], capture_output=True, timeout=10
            )
            if result.returncode or len(result.stdout) > 10_000_000:
                return None
            digest.update(result.stdout)
        files = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--others", "--exclude-standard", "-z"],
            capture_output=True,
            timeout=10,
            check=True,
        )
        total = 0
        for name in sorted(files.stdout.split(b"\0")):
            if not name:
                continue
            path = root / name.decode("utf-8")
            if not path.resolve().is_relative_to(root.resolve()):
                return None
            total += path.stat().st_size
            if total > 10_000_000:
                return None
            digest.update(name)
            digest.update(path.read_bytes())
        return digest.hexdigest()
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def failure_category(error: str | None):
    """Purpose: Classify without saving vendor text. Input: error. Output: category."""
    text = (error or "").lower()
    if "model_unsupported:" in text:
        return "model_unsupported"
    for category, terms in {
        "authentication": (
            "unauthorized",
            "authentication",
            "401",
            "invalid api key",
            "not logged",
        ),
        "quota": ("quota", "rate limit", "429", "insufficient credit"),
        "context": ("context_length", "context window", "too many tokens"),
        "requirements": ("requirements_unclear", "task_ambiguous"),
        "network": ("connection", "network", "timeout", "timed out"),
        "tool": ("tool", "command", "permission", "sandbox"),
    }.items():
        if any(term in text for term in terms):
            return category
    return "unknown"


class RoutingService:
    def __init__(
        self, adapter, store, productivity, policy, state_path: Path, parent_session_id: str,
        *, settings_model=None,
    ):
        """Purpose: Bind routing to a parent. Input: services and policy. Output: runner."""
        policy = policy.model_copy(update={
            "enabled": execution_mode(policy, store.load_manifest(parent_session_id)) == "auto",
        })
        self.adapter, self.store, self.policy = adapter, store, policy
        self.permission_run_id = store.load_manifest(parent_session_id).get(
            "routing_permission_run_id")
        self.evaluator = SubtaskEvaluator(
            settings_model, policy.evaluator, parent=store.load_manifest(parent_session_id),
        )
        self.productivity, self.state_path, self.parent_session_id = (
            productivity,
            state_path,
            parent_session_id,
        )
        self.catalog = CandidateCatalog(adapter, productivity, policy, state_path / "catalog.json")
        self.benchmarks = BenchmarkCache(
            state_path / "benchmarks.json", policy,
            credential_path=Path(settings_model.PROFILE_DIR).with_name("benchmark-credentials.json")
            if settings_model else None,
        )
        self.feedback = FeedbackStore(state_path)

    async def routing_context(self, assessment, candidates, root):
        """Purpose: Prepare AA metadata and local ranks without inference. Output: context."""
        try:
            async with asyncio.timeout(25):
                view = await self.benchmarks.prepare()
        except (TimeoutError, OSError):
            view = self.benchmarks.read().model_copy(update={"error": "aa_refresh_failed"})
        return build_context(assessment, candidates, self.policy, view, self.feedback,
                             project_key(root), self.parent_session_id)

    def _project(self, project_path):
        """Purpose: Bound child scope. Input: relative project. Output: checked absolute cwd."""
        parent = self.store.load_manifest(self.parent_session_id)
        if parent.get("routing_depth", 0) >= self.policy.max_depth:
            raise ValueError("Delegation depth limit reached")
        root = Path(parent.get("cwd") or ".").resolve()
        selected = (root / project_path).resolve()
        if not selected.is_dir() or not selected.is_relative_to(root):
            raise ValueError("Routed project must stay inside the parent workspace")
        return selected

    async def preview(self, assessment, request=None, project_path="."):
        """Purpose: Preview without a turn. Input: evaluation. Output: recommendation."""
        task = TaskAssessment.model_validate(assessment)
        explicit = RouteRequest.model_validate(request or {})
        root = self._project(project_path)
        candidates = self._constrain_parent(await self.catalog.list(str(root)))
        if self.policy.strategy == "evaluator" and not any(explicit.model_dump().values()):
            from cleo.routing.router import RouteDecision

            context = await self.routing_context(task, candidates, root)
            return RouteDecision(candidate_ids=[card["id"] for card in context["candidates"]],
                                 context=context, reasons=["evaluator_recommendation_required"],
                                 rejected=context["rejected"])
        return route(task, candidates, self.policy, self.benchmarks.read(), explicit)

    async def delegate(
        self, prompt, assessment, request=None, project_path=".", recommendation=None, handoff=None,
    ):
        """Purpose: Execute only a decomposed subtask chosen by the coordinator.

        Input: task instruction, validated assessment and optional explicit selection.
        Output: result and trace ID. The parent model/manifest is never rewritten.
        """
        if not self.policy.enabled:
            return {
                "status": "routing_disabled",
                "error": "Use the existing explicit delegation tools",
            }
        task = TaskAssessment.model_validate(assessment)
        explicit = RouteRequest.model_validate(request or {})
        root = self._project(project_path)
        handoff_metadata = None
        if handoff is not None:
            from cleo.routing.handoff import prepare_handoff

            context, handoff_metadata = prepare_handoff(
                handoff, state=self.state_path, parent=self.parent_session_id,
                usage_task_id=self.store.load_manifest(self.parent_session_id).get("usage_task_id"),
                root=root,
            )
            prompt += context
        task_id = "task_" + uuid.uuid4().hex
        record_path = self.state_path / "tasks" / (task_id + ".json")
        record = {
            "task_id": task_id,
            "parent_session_id": self.parent_session_id,
            "usage_task_id": self.store.load_manifest(self.parent_session_id).get("usage_task_id"),
            "assessment": task.model_dump(mode="json", exclude={"acceptance_criteria"}),
            "acceptance_criteria_count": len(task.acceptance_criteria),
            "decision": {},
            "attempts": [],
            "status": "rejected",
            "acceptance": "unknown",
            "created_at": utcnow().isoformat(),
            "project_key": project_key(root),
            "handoff": handoff_metadata,
        }
        atomic_json(record_path, record)
        task_started = asyncio.get_running_loop().time()
        if task.deadline and task.deadline <= utcnow():
            record["decision"] = {"reasons": ["deadline_expired"]}
            atomic_json(record_path, record)
            return {"task_id": task_id, "status": "rejected", "route": record["decision"]}
        if self.evaluator.requires_call() and (
            task.budget or self.policy.max_soft_budget_usd is not None
        ):
            record["decision"] = {"reasons": ["evaluator_cost_unknown_for_budget"]}
            atomic_json(record_path, record)
            return {"task_id": task_id, "status": "rejected", "route": record["decision"]}

        def record_cancellation():
            """Purpose: Retain pre-execution cancellation. Output: terminal task record."""
            record.update(status="cancelled", failure_category="user_cancelled",
                          ended_at=utcnow().isoformat())
            if record.get("evaluation_started"):
                record["evaluator"] = {"status": "cancelled", "called": True,
                                       "usage": getattr(self.evaluator, "last_usage", None)}
            atomic_json(record_path, record)

        try:
            candidates = self._constrain_parent(await self.catalog.list(str(root)))
        except asyncio.CancelledError:
            record_cancellation()
            raise
        if not any(item.enabled and item.available is True for item in candidates):
            record["decision"] = route(
                task, candidates, self.policy, self.benchmarks.read(), explicit,
            ).model_dump(mode="json")
            record["evaluator"] = {"mode": self.policy.evaluator.mode, "status": "not_started",
                                   "reason": "no_available_executor"}
            atomic_json(record_path, record)
            return {"task_id": task_id, "status": "rejected", "route": record["decision"]}
        context = None
        choice = None
        user_selected = any(value is not None for value in explicit.model_dump().values())
        try:
            remaining = min(
                self.policy.max_task_seconds,
                (task.deadline - utcnow()).total_seconds() if task.deadline else float("inf"),
            )
            async with asyncio.timeout(remaining):
                if self.policy.strategy == "evaluator" and not user_selected:
                    context = await self.routing_context(task, candidates, root)
                    if not context["candidates"]:
                        record["decision"] = {"context": context,
                                              "reasons": ["no_eligible_candidate"]}
                        atomic_json(record_path, record)
                        return {"task_id": task_id, "status": "rejected",
                                "route": record["decision"]}
                    if not self.evaluator.requires_call():
                        if recommendation is None:
                            record["decision"] = {
                                "context": context,
                                "reasons": ["coordinator_recommendation_required"],
                            }
                            atomic_json(record_path, record)
                            return {"task_id": task_id, "status": "recommendation_required",
                                    "context": context}
                        choice = validate_recommendation(recommendation, context)
                if self.evaluator.requires_call():
                    record["evaluation_started"] = utcnow().isoformat()
                    atomic_json(record_path, record)
                task, evaluation = await self.evaluator.assess(
                    prompt, task, **({"context": context} if context is not None else {}),
                )
                if context is not None and choice is None:
                    choice = validate_recommendation(evaluation["recommendation"], context)
            record["evaluator"] = {
                **evaluation, "started_at": record["created_at"],
                "called": bool(record.get("evaluation_started")),
                "ended_at": utcnow().isoformat(),
            }
            record["assessment"] = task.model_dump(mode="json", exclude={"acceptance_criteria"})
        except asyncio.CancelledError:
            record_cancellation()
            raise
        except Exception as error:
            # No vendor text or subtask text is retained. A selected evaluator is never
            # silently replaced, and a failed assessment never launches a child executor.
            record.update(status="evaluation_failed", failure_category="evaluator",
                          ended_at=utcnow().isoformat())
            record["evaluator"] = {"mode": self.policy.evaluator.mode, "status": "failed",
                                   "called": bool(record.get("evaluation_started")),
                                   "usage": getattr(self.evaluator, "last_usage", None),
                                   "failure_category": failure_category(str(error))}
            atomic_json(record_path, record)
            return {
                "task_id": task_id, "status": "evaluation_failed",
                "failure_category": record["evaluator"]["failure_category"],
                "error": "Selected evaluator unavailable or failed; coordinator review required",
            }
        selected_request = RouteRequest(candidate_id=choice.candidate_id) if choice else explicit
        decision = route(task, candidates, self.policy, self.benchmarks.read(), selected_request)
        if choice:
            from cleo.integrations.runtime_diagnostics import diagnostic_text

            choice = choice.model_copy(update={
                "rationale": diagnostic_text(choice.rationale, prompt=prompt, limit=800),
            })
            decision.reasons = ["evaluator_recommendation_validated", choice.rationale]
            decision.alternatives = choice.alternatives
            decision.upgrades = [item for item in choice.alternatives
                                 if item != choice.candidate_id]
            decision.context = context
            record["evaluator"]["recommendation"] = choice.model_dump(mode="json")
        record["decision"] = decision.model_dump(mode="json")
        atomic_json(record_path, record)
        if decision.selected is None:
            return {
                "task_id": task_id,
                "status": "rejected",
                "route": decision.model_dump(mode="json"),
            }
        selected = next(item for item in candidates if item.id == decision.selected)
        deadline = min(
            (task.deadline - utcnow()).total_seconds() if task.deadline else float("inf"),
            self.policy.max_task_seconds - (asyncio.get_running_loop().time() - task_started),
        )
        started = asyncio.get_running_loop().time()
        explicit_selection = any(value is not None for value in explicit.model_dump().values())
        for number in range(1 + self.policy.max_auto_upgrades):
            attempt = {
                "attempt": number + 1,
                "candidate_id": selected.id,
                "started_at": utcnow().isoformat(),
                "status": "running",
                "acceptance": "unknown",
                "actual_cost_usd": None,
                "usage": {},
                "failure_category": None,
                "permission_preset": routing_preset(
                    self.policy, self.store.load_manifest(self.parent_session_id),
                ),
                "estimate": decision.estimates.get(selected.id),
                "upgrade_from": (record["attempts"][-1]["candidate_id"] if number else None),
            }
            record["attempts"].append(attempt)
            record["status"] = "running"
            atomic_json(record_path, record)
            before = await asyncio.to_thread(workspace_fingerprint, root)
            session = None
            observed_tools = False
            response = None
            approval_waiters = []

            async def observe(event, attempt_record=attempt, candidate_policy=selected.policy,
                              waiters=approval_waiters):
                """Purpose: Retain minimal telemetry. Input: native event. Output: safe counters."""
                nonlocal observed_tools
                if event.type == "permission_request" and attempt_record.get("session_id"):
                    from cleo.routing.approvals import worker_approval

                    waiters.append(asyncio.create_task(worker_approval(
                        self.store, self.adapter, self.parent_session_id,
                        attempt_record["session_id"], task_id,
                        event.data.get("payload", event.data),
                        run_id=self.permission_run_id, timeout_seconds=max(1, deadline),
                    )))
                if (
                    event.type
                    not in {
                        "turn_started",
                        "turn_completed",
                        "assistant_message_chunk",
                        "agent_message",
                        "thought",
                        "usage",
                        "token_usage",
                    }
                    and event.data.get("provider_event_type") not in CONTEXT_USAGE_EVENTS
                ):
                    observed_tools = True
                payload = event.data.get("payload", event.data)
                if not isinstance(payload, dict):
                    return
                token_usage = payload.get("tokenUsage") or {}
                usage = token_usage.get("total") or token_usage.get("last") or {}
                if event.type == "usage" and isinstance(payload.get("usage"), dict):
                    usage = normalize_call_usage(payload["usage"])
                for source, dest in (
                    ("inputTokens", "input_tokens"),
                    ("outputTokens", "output_tokens"),
                    ("cachedInputTokens", "cached_input_tokens"),
                    ("input_tokens", "input_tokens"),
                    ("output_tokens", "output_tokens"),
                    ("cache_read_input_tokens", "cached_input_tokens"),
                    ("cache_creation_input_tokens", "cache_write_input_tokens"),
                ):
                    value = usage.get(source)
                    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                        attempt_record["usage"][dest] = value
                if event.type == "usage":
                    cost = payload.get("total_cost_usd")
                    if (
                        isinstance(cost, (float, int))
                        and not isinstance(cost, bool)
                        and math.isfinite(cost)
                        and cost >= 0
                    ):
                        attempt_record["provider_reported_cost_usd"] = cost
                        if candidate_policy.cost_type == "api":
                            attempt_record["actual_cost_usd"] = cost
                            attempt_record["actual_cost_source"] = "api_provider_report"

            try:
                remaining = deadline - (asyncio.get_running_loop().time() - started)
                async with asyncio.timeout(max(0, remaining)):
                    actual = self._constrain_parent(
                        [await self.catalog.validate(selected, str(root))]
                    )[0]
                    validated = route(
                        task,
                        [actual],
                        self.policy,
                        self.benchmarks.read(),
                        RouteRequest(candidate_id=actual.id),
                    )
                    if validated.selected is None:
                        raise ValueError("Selected route no longer satisfies execution constraints")
                    session = await self.adapter.create_session(
                        actual.provider, project_path=str(root), model=actual.model
                    )
                    parent = self.store.load_manifest(self.parent_session_id)
                    self.store.update_manifest(
                        session.id,
                        parent_session_id=self.parent_session_id,
                        routing_task_id=task_id,
                        usage_task_id=record["usage_task_id"],
                        routing_depth=parent.get("routing_depth", 0) + 1,
                    )
                    attempt["session_id"] = session.id
                    atomic_json(record_path, record)
                    await self._prepare(session.id, actual, parent, force_readonly=number > 0)
                    native = self.store.load_manifest(session.id).get("runtime_options") or {}
                    attempt["permissions"] = {
                        key: native[key] for key in ("sandbox", "approval_mode")
                        if native.get(key) is not None
                    }
                    atomic_json(record_path, record)
                    result = await self.adapter.prompt(session.id, prompt, on_event=observe)
                    response = result.response
                    attempt["status"] = result.status
                    attempt["failure_category"] = (
                        None
                        if result.status == "completed"
                        else (
                            "user_cancelled"
                            if result.status == "cancelled"
                            else unsupported_reason(result.error, actual.model, actual.effort)
                            or failure_category(result.error)
                        )
                    )
                    if result.status == "completed":
                        attempt["acceptance"], attempt["checks"] = await self._verify(task, root)
                        if attempt["acceptance"] == "failed":
                            attempt["failure_category"] = "implementation"
            except asyncio.CancelledError:
                attempt.update(status="cancelled", failure_category="user_cancelled")
                record.update(status="cancelled", acceptance="unknown")
                raise
            except TimeoutError:
                attempt.update(status="timed_out", failure_category="time_limit")
            except Exception as error:
                reason = unsupported_reason(str(error), selected.model, selected.effort)
                attempt.update(status="failed",
                               failure_category=reason or failure_category(str(error)))
                if reason and selected.availability_scope:
                    self.catalog.availability.record(
                        selected.availability_scope, selected.model,
                        "*" if reason == "model_unsupported" else selected.effort,
                        available=False, reason=reason,
                    )
            finally:
                for waiter in approval_waiters:
                    waiter.cancel()
                await asyncio.gather(*approval_waiters, return_exceptions=True)
                attempt["finished_at"] = utcnow().isoformat()
                if session is not None:
                    try:
                        await self.adapter.close(session.id)
                    except Exception:
                        attempt["cleanup"] = "provider_cleanup_failed"
                record.update(
                    status=attempt["status"],
                    acceptance=attempt["acceptance"],
                    final_candidate_id=attempt["candidate_id"],
                    candidate_scope=selected.availability_scope,
                )
                atomic_json(record_path, record)
                if attempt["acceptance"] in {"passed", "failed"}:
                    self.feedback.submit(record, {
                        "task_id": task_id, "outcome": attempt["acceptance"],
                        "attribution": "executor",
                    }, source="check")
            after = await asyncio.to_thread(workspace_fingerprint, root)
            safe = (
                before is not None
                and before == after
                and not observed_tools
                and selected.policy.replay_safe_read_only
                and selected.backend == "codex_sdk"
                and all(
                    self.policy.checks[name].read_only
                    for name in self.policy.checks_by_task_type.get(task.task_type, [])
                    if name in self.policy.checks
                )
            )
            can_upgrade = (
                self.policy.automatic_upgrade
                and number < self.policy.max_auto_upgrades
                and not explicit_selection
                and attempt["failure_category"] == "implementation"
                and safe
                and not task.budget
                and self.policy.max_soft_budget_usd is None
                and any(
                    item.id in decision.upgrades and item.backend == "codex_sdk"
                    for item in candidates
                )
            )
            attempt["upgrade_gate"] = {
                "workspace_unchanged": before is not None and before == after,
                "tool_effects_observed": observed_tools,
                "safe_to_replay": safe,
            }
            if not can_upgrade:
                attempt["upgrade"] = (
                    "not_replayed; coordinator_review_required"
                    if attempt["failure_category"]
                    else "not_needed"
                )
                atomic_json(record_path, record)
                return {
                    "task_id": task_id,
                    "thread_id": attempt.get("session_id"),
                    "selected_candidate": attempt["candidate_id"],
                    "status": attempt["status"],
                    "acceptance": attempt["acceptance"],
                    "failure_category": attempt["failure_category"],
                    "recommended_action": {
                        "context": "explore_and_reassess",
                        "requirements": "clarify_and_reassess",
                        "authentication": "repair_connection",
                        "quota": "review_quota_or_budget",
                        "network": "inspect_transport",
                        "tool": "inspect_tools_and_permissions",
                        "implementation": "coordinator_review_of_failed_checks",
                        "model_unsupported": "choose_supported_configuration",
                        "effort_unsupported": "choose_supported_configuration",
                    }.get(attempt["failure_category"], "coordinator_review"),
                    "response": response,
                    "route": decision.model_dump(mode="json"),
                    "attempts": len(record["attempts"]),
                }
            attempt["upgrade"] = "one_safe_upgrade"
            selected = next(
                item
                for identifier in decision.upgrades
                for item in candidates
                if item.id == identifier and item.backend == "codex_sdk"
            )
        raise AssertionError("Bounded upgrade loop must return")

    def _constrain_parent(self, candidates):
        """Purpose: Enforce user authorization before selecting an executor.

        Input: Discovered candidates and the bound parent runtime. Output: Scoped candidates.
        """
        parent = self.store.load_manifest(self.parent_session_id)
        settings = self.productivity.providers.get(parent["provider"])
        preset = routing_preset(self.policy, parent)
        if preset != "inherit":
            scoped = []
            for item in candidates:
                restriction = None
                if settings is None and parent["provider"] != "cleo":
                    restriction = "parent_permissions_unknown"
                try:
                    native_permissions(item.backend, preset)
                    if settings is not None and item.backend != settings.type \
                            and not self.policy.allow_cross_backend_delegation:
                        restriction = "cross_backend_permission_authorization_required"
                    if settings is not None:
                        expected = native_permissions(settings.type, preset)
                        options = parent.get("runtime_options") or {}
                        if any(options.get(key) != value for key, value in expected.items()):
                            restriction = "routing_permissions_not_applied_to_parent"
                except ValueError:
                    restriction = "routing_permission_preset_unsupported"
                scoped.append(item.model_copy(update={"execution_restriction": restriction}))
            return scoped
        if settings is None:
            if parent["provider"] != "cleo":
                return [
                    item.model_copy(update={"execution_restriction": "parent_permissions_unknown"})
                    for item in candidates
                ]
            return candidates
        options = parent.get("runtime_options") or {}
        readonly = options.get("sandbox") == "read-only" or options.get("approval_mode") == "plan"
        scoped = []
        for item in candidates:
            restriction = None
            if settings.type == "acp":
                restriction = "parent_acp_permission_boundary_unknown"
            elif item.backend != settings.type and not self.policy.allow_cross_backend_delegation:
                restriction = "cross_backend_permission_authorization_required"
            if readonly and item.backend != "codex_sdk":
                restriction = "cannot_preserve_parent_readonly_boundary"
            capabilities = dict(item.capabilities)
            if readonly:
                capabilities["file_write"] = False
            scoped.append(
                item.model_copy(
                    update={"execution_restriction": restriction, "capabilities": capabilities}
                )
            )
        return scoped

    async def _prepare(self, session_id, candidate, parent, *, force_readonly=False):
        """Purpose: Preserve native permissions and effort. Input: child/parent. Output: options."""
        options = {}
        parent_options = parent.get("runtime_options") or {}
        preset = routing_preset(self.policy, parent)
        if preset != "inherit":
            from cleo.harnesses.capabilities import Capability

            if force_readonly or candidate.policy.replay_safe_read_only:
                if candidate.backend != "codex_sdk":
                    raise ValueError("Cannot preserve the read-only replay boundary")
                options = {"sandbox": "read-only", "approval_mode": "deny_all"}
            else:
                options = native_permissions(candidate.backend, preset)
            if Capability.USER_APPROVALS in self.adapter.session_capabilities(session_id):
                await self.adapter.enable_user_approvals(session_id)
            if candidate.effort is not None:
                options["effort"] = candidate.effort
            # The provider validates live account/client restrictions before any prompt.
            await self.adapter.update_session_options(session_id, **options)
            return
        readonly = (
            force_readonly
            or parent_options.get("sandbox") == "read-only"
            or parent_options.get("approval_mode") == "plan"
        )
        if candidate.backend == "codex_sdk":
            configured = self.productivity.providers[candidate.provider].options.sandbox
            sandbox = (
                "read-only" if readonly or candidate.policy.replay_safe_read_only else configured
            )
            if sandbox == "full-access" and parent_options.get("sandbox") != "full-access":
                raise ValueError("Child sandbox would widen parent permissions")
            options.update(
                sandbox=sandbox,
                approval_mode="deny_all",
            )
        elif readonly or parent_options.get("approval_mode") == "plan":
            raise ValueError("Cannot preserve the parent read-only boundary in this backend")
        elif candidate.backend == "claude_sdk":
            if (
                self.productivity.providers[candidate.provider].options.permission_mode
                == "bypassPermissions"
            ):
                raise ValueError("Routed children cannot bypass native permissions")
            if parent_options.get("approval_mode") in {"default", "dontAsk"}:
                options["approval_mode"] = parent_options["approval_mode"]
        elif candidate.backend == "acp":
            if self.productivity.providers[candidate.provider].options.auto_approve:
                raise ValueError("Routed children cannot auto-approve unknown native requests")
        if candidate.effort is not None:
            options["effort"] = candidate.effort
        if options:
            await self.adapter.update_session_options(session_id, **options)

    async def _verify(self, task, root):
        """Purpose: Use operator-selected checks, never agent self-reports. Output: acceptance."""
        checks = self.policy.checks_by_task_type.get(task.task_type, [])
        if not checks:
            return "unknown", []
        evidence = []
        for name in checks:
            check = self.policy.checks.get(name)
            if check is None:
                return "unknown", [{"check": name, "status": "not_configured"}]
            process = await asyncio.create_subprocess_exec(
                *check.argv,
                cwd=root,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                async with asyncio.timeout(check.timeout_seconds):
                    await process.wait()
            except BaseException:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
                raise
            evidence.append({"check": name, "exit_code": process.returncode})
        return (
            "passed" if all(item["exit_code"] == 0 for item in evidence) else "failed"
        ), evidence


def create_service(
    parent_session_id, *, settings_model=None, memory_root=None, index_path=None,
    refresh_config=False,
):
    """Purpose: Build the shared existing harness stack. Input: trusted parent. Output: service."""
    from cleo.config.settings import current_settings, load_settings
    from cleo.integrations.harnesses.factory import build_agent_adapter
    from cleo.routing.models import load_policy
    from cleo.sessions.store import SessionStore

    settings = settings_model or (load_settings() if refresh_config else current_settings())
    store = SessionStore(
        memory_root or settings.MEMORY_DIR, index_path or settings.SESSION_INDEX_PATH
    )
    parent = store.load_manifest(parent_session_id)
    policy = load_policy(Path(settings.PROFILE_DIR).parent / "routing.json")
    adapter = build_agent_adapter(
        parent["cwd"],
        settings.productivity,
        session_store=store,
        computer_config_path=Path(settings.PROFILE_DIR).with_name("computer-use.json"),
    )
    return RoutingService(
        adapter,
        store,
        settings.productivity,
        policy,
        Path(store.memory_root) / ".routing",
        parent_session_id,
        settings_model=settings,
    )
