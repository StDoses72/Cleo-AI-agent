"""Shared API-agent and harness-MCP delegation tools with host-bound parent identity."""

import json
import re
from pathlib import Path

from pydantic import ValidationError

from cleo.routing.benchmarks import match_record
from cleo.routing.execution import create_service
from cleo.routing.models import execution_mode, load_policy
from cleo.routing.scope import current_scope, parent_binding_path

ROUTING_INSTRUCTIONS = """
You remain the coordinator: understand the user, decompose only when useful, choose when
to delegate or parallelize, inspect evidence, and deliver the final answer yourself.
At the beginning of a new goal, call label_current_task with a concise semantic title in the
user's language (4-24 characters preferred, at most 40). For example, use "STM 作业讲解",
not "帮我讲解下这个stm的作业是怎么做的". This labels the existing host task only; it does
not create a task or change its boundary. Do not repeat this for ordinary follow-ups.
Inspect list_execution_candidates and reference rankings before decomposing complex work.
Keep each handoff focused: goal, required context, prior conclusions, artifact paths and
acceptance criteria. Use worker outputs as evidence, check artifacts before continuing, and
pass only relevant results to the next worker. Account for evaluation, handoff and rework
overhead; prefer direct execution when delegation would cost more than it saves.
For sequential work, delegate_subtask accepts handoff {task_id, summary, artifacts} from a
completed predecessor in this goal. Give a short summary and relative artifact paths only.
The host validates ownership and paths; the next worker must still verify the evidence.
For a delegated subtask, provide task_type (coding/bug_fix/terminal/research/analysis/exploration),
complexity (low/medium/high/unknown), required_capabilities, context_requirement (tokens or null),
uncertainty, failure_impact, acceptance_criteria, and budget/deadline if constrained.
Include part: a brief responsibility label in the user's language, e.g. routing connectivity
test or UI implementation (at most 80 characters, no secrets or file contents).
If known, supply token_estimate (input_tokens/output_tokens) separately from a dollar budget.
These are planning estimates, never a quote; unknown estimates may remain absent.
Use route_subtask to inspect a recommendation and delegate_subtask to execute a child.
Honor the user's explicit provider/model; don't silently substitute. Assessment is requirements,
not permission. A child's completed status does not establish acceptance: unknown needs your
review. Do not replay work with changes or external effects without examining them.
Simple tasks can be completed directly. A routing-disabled response leaves explicit tools usable.
The session execution mode is host-owned. Manual mode uses the selected harness/model;
automatic mode delegates only decomposed subtasks. If a separate evaluator is configured,
delegate_subtask runs that assessment once; route_subtask previews never call it. An evaluator
failure needs coordinator review, not silent substitution. Unless explicitly configured, the
evaluator follows the new-conversation default connection/model, not a switched task main model.
When that model and connection are already coordinating, their structured assessment is reused.
In evaluator strategy, route_subtask returns a context_id, eligible candidate cards and
separate AA reference rankings. Read these before selecting a worker. If coordinating
evaluation is reused, pass recommendation {context_id, candidate_id, rationale,
evidence_refs, alternatives, uncertainty} to delegate_subtask. Cite evidence IDs from
the selected card; never invent scores or treat subscription costs as zero. Stale
contexts must be refreshed. An independent evaluator selects the worker itself.
Repeated correction messages are not independent failures or permission to change
global benchmark scores. Ask for attribution when the cause of rework is unclear.
Use flag_subtask_feedback when user corrections indicate rework of a delegated task.
This records tentative feedback for review; it cannot label a confirmed success/failure
or penalize a worker. The user can attribute or retract it in routing settings.
""".strip()


def routing_enabled(settings_model=None):
    """Purpose: Read the user-owned switch. Input: settings. Output: enabled without network."""
    from cleo.config.settings import current_settings

    settings = settings_model or current_settings()
    policy = load_policy(Path(settings.PROFILE_DIR).parent / "routing.json")
    scope = current_scope.get()
    parent = None
    if scope:
        from cleo.sessions.store import SessionStore

        try:
            parent = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH).load_manifest(
                scope.parent_session_id,
            )
        except (ValueError, OSError):
            return False
    return execution_mode(policy, parent) == "auto"


def tool_functions(parent_resolver, service_factory=None):
    """Purpose: Share the same tool implementations across transports. Output: plain callables."""

    async def invoke(operation, **kwargs):
        """Purpose: Own one adapter lifetime. Input: operation. Output: result with safe errors."""
        service = None
        try:
            try:
                parent = parent_resolver()
            except (OSError, ValueError, KeyError):
                parent = None
            if not parent:
                return {
                    "status": "unsupported",
                    "error": "No host-bound parent session; automatic routing is unavailable",
                }
            service = (service_factory or create_service)(parent)
            if not service.policy.enabled:
                return {"status": "routing_disabled"}
            return await operation(service, **kwargs)
        except ValidationError as error:
            return {
                "status": "rejected",
                "error": "Invalid assessment or routing policy",
                "fields": [
                    {"field": ".".join(str(part) for part in item["loc"]), "type": item["type"]}
                    for item in error.errors(
                        include_input=False, include_context=False, include_url=False
                    )
                ],
            }
        except (ValueError, OSError, KeyError):
            return {
                "status": "rejected",
                "error": "Invalid assessment, policy, parent binding or execution constraints",
            }
        finally:
            if service is not None:
                await service.adapter.aclose()

    async def route_subtask(
        assessment: dict, selection: dict | None = None, project_path: str = "."
    ) -> dict:
        """Recommend a child from requirements. The coordinating model remains unchanged."""

        async def preview(service):
            return (await service.preview(assessment, selection, project_path)).model_dump(
                mode="json"
            )

        return await invoke(preview)

    async def delegate_subtask(
        prompt: str, assessment: dict, selection: dict | None = None, project_path: str = ".",
        recommendation: dict | None = None,
        handoff: dict | None = None,
    ) -> dict:
        """Execute a decomposed subtask. Main agent owns acceptance and the final reply."""

        async def execute(service):
            if handoff is not None:
                return await service.delegate(prompt, assessment, selection, project_path,
                                              recommendation=recommendation, handoff=handoff)
            if recommendation is None:
                return await service.delegate(prompt, assessment, selection, project_path)
            return await service.delegate(
                prompt, assessment, selection, project_path, recommendation=recommendation,
            )

        return await invoke(execute)

    async def list_execution_candidates(refresh: bool = False) -> dict:
        """List configured harness/model/effort combinations without paid model turns."""

        async def listing(service):
            from cleo.routing.context import reference_records
            from cleo.routing.models import TaskAssessment

            root = service._project(".")
            candidates = await service.catalog.list(str(root), refresh=refresh)
            context = await service.routing_context(TaskAssessment(
                task_type="analysis", complexity="unknown", failure_impact="low",
                acceptance_criteria=["Coordinator defines acceptance for each subtask"],
            ), service._constrain_parent(candidates), root)
            view = service.benchmarks.read()
            entries = []
            for candidate in candidates:
                record, status = match_record(candidate, view.snapshot)
                grade, references, _ = reference_records(candidate, view.snapshot)
                entries.append(
                    {
                        **candidate.model_dump(mode="json"),
                        "benchmark": {
                            "match": status,
                            "record": record.model_dump(mode="json") if record else None,
                            "reference_grade": grade,
                            "references": [item.model_dump(mode="json") for item in references],
                        },
                    }
                )
            return {
                "candidates": entries,
                "rankings": context["rankings"],
                "benchmark": {
                    "source": view.snapshot.source if view.snapshot else None,
                    "retrieved_at": view.snapshot.retrieved_at.isoformat()
                    if view.snapshot
                    else None,
                    "stale": view.stale,
                    "error": view.error,
                },
            }

        return await invoke(listing)

    async def subtask_status(task_id: str) -> dict:
        """Read this parent's attempts. Completed and accepted are separate states."""

        async def status(service):
            if not re.fullmatch(r"task_[0-9a-f]{32}", task_id):
                raise ValueError("Invalid task ID")
            record = json.loads(
                (service.state_path / "tasks" / (task_id + ".json")).read_text(encoding="utf-8")
            )
            if record["parent_session_id"] != service.parent_session_id:
                raise ValueError("Task belongs to another parent")
            return record

        return await invoke(status)

    async def flag_subtask_feedback(task_id: str) -> dict:
        """Flag rework for user attribution. Repeated flags remain one pending episode."""

        async def flag(service):
            if not re.fullmatch(r"task_[0-9a-f]{32}", task_id):
                raise ValueError("Invalid task ID")
            record = json.loads((service.state_path / "tasks" / f"{task_id}.json").read_text(
                encoding="utf-8",
            ))
            if record["parent_session_id"] != service.parent_session_id:
                raise ValueError("Task belongs to another parent")
            previous = service.feedback.read(task_id)
            if previous:
                return previous
            return service.feedback.submit(record, {
                "task_id": task_id, "outcome": "unknown", "attribution": "unknown",
            }, source="coordinator")

        return await invoke(flag)

    async def label_current_task(title: str) -> dict:
        """Supply a short semantic title for the host's current goal during normal work."""
        service = None
        try:
            parent = parent_resolver()
            if not parent:
                return {"status": "unsupported"}
            service = (service_factory or create_service)(parent)
            from cleo.runtime.task_tracking import label_task

            return label_task(service.store, parent, title)
        except (ValueError, OSError, KeyError):
            return {"status": "rejected"}
        finally:
            if service is not None:
                await service.adapter.aclose()

    return (route_subtask, delegate_subtask, list_execution_candidates,
            subtask_status, flag_subtask_feedback, label_current_task)


def create_routing_tools():
    """Purpose: Bind LangChain tools to the active host context. Input: none. Output: tool tuple."""
    from langchain.tools import tool

    return tuple(
        tool(function)
        for function in tool_functions(
            lambda: current_scope.get().parent_session_id if current_scope.get() else None
        )
    )


def register_mcp_tools(server, memory_root, parent_key, index_path=None):
    """Purpose: Bind harness tools to a launch key. Input: host MCP. Output: tools."""

    def resolve():
        """Purpose: Resolve host identity. Input: none. Output: parent without model input."""
        payload = json.loads(
            parent_binding_path(Path(memory_root), parent_key).read_text(encoding="utf-8")
        )
        return payload["session_id"]

    for function in tool_functions(
        resolve,
        lambda parent: create_service(
            parent, memory_root=memory_root, index_path=index_path, refresh_config=True,
        ),
    ):
        server.tool(name=function.__name__)(function)


async def maybe_route_codex(
    prompt, project_path, model, assessment=None, provider=None, candidate_id=None
):
    """Purpose: Gate legacy delegation on user policy. Output: routed result or None."""
    if not routing_enabled():
        if provider not in (None, "codex") or candidate_id is not None:
            return {
                "status": "rejected",
                "error": "Automatic routing is disabled; the legacy tool supports Codex/model only",
            }
        return None
    if assessment is None:
        return {
            "status": "assessment_required",
            "error": "Provide a subtask assessment; keep the parent as coordinator",
        }
    selection = {
        key: value
        for key, value in {
            "model": model,
            "provider": provider,
            "candidate_id": candidate_id,
        }.items()
        if value is not None
    }
    delegate = tool_functions(
        lambda: current_scope.get().parent_session_id if current_scope.get() else None
    )[1]
    return await delegate(prompt, assessment, selection, project_path)
