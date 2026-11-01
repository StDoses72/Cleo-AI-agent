"""Actual evaluator routing uses local facts and fake completion only."""
import asyncio
import json

from cleo.routing.benchmarks import BenchmarkRecord, BenchmarkSnapshot
from cleo.routing.catalog import atomic_json
from cleo.routing.evaluator import SubtaskEvaluator
from cleo.routing.feedback import FeedbackStore, project_key
from cleo.routing.models import EvaluatorSettings, utcnow


def references(service):
    """Purpose: Install a local AA fixture. Output: no credentials or HTTP request."""
    service.policy.strategy = "evaluator"
    service.policy.auto_refresh_benchmarks = False
    snapshot = BenchmarkSnapshot(source_kind="local_import", retrieved_at=utcnow(), records=[
        BenchmarkRecord(id="aa-fixture", name="Fixture (high)", slug="fixture-model",
                        effort="high", version="4.3",
                        scores={"artificial_analysis_coding_index": 87},
                        input_usd_per_million=0.2, output_usd_per_million=1,
                        output_tokens_per_second=120),
    ])
    atomic_json(service.benchmarks.path, snapshot.model_dump(mode="json"))


def recommendation(context, candidate=None):
    """Purpose: Produce a coordinator decision bound to real fixture evidence."""
    card = next(item for item in context["candidates"]
                if item["id"] == candidate) if candidate else context["candidates"][-1]
    return {"context_id": context["context_id"], "candidate_id": card["id"],
            "rationale": "Use the referenced coding capability for this focused task.",
            "evidence_refs": card["evidence_ids"], "uncertainty": "medium"}


def test_real_mcp_tools_pass_context_bound_recommendation(service_factory, assessment, monkeypatch):
    from fastmcp import Client, FastMCP

    from cleo.routing import tools
    from cleo.routing.scope import parent_binding_path

    async def scenario():
        service, providers = service_factory()
        references(service)
        key = "c" * 32
        atomic_json(parent_binding_path(service.store.memory_root, key), {"session_id": "parent"})
        monkeypatch.setattr(tools, "create_service", lambda *_, **__: service)
        server = FastMCP("offline-routing")
        tools.register_mcp_tools(server, service.store.memory_root, key)
        async with Client(server) as client:
            preview = await client.call_tool("route_subtask", {"assessment": assessment})
            context = preview.data["context"]
            result = await client.call_tool("delegate_subtask", {
                "prompt": "offline task", "assessment": assessment,
                "recommendation": recommendation(context),
            })
            assert result.data["status"] == "completed"
        assert len(providers[1].prompts) == 1 and not providers[0].prompts
        assert service.store.load_manifest("parent")["runtime_options"]["model"] == "main-model"
    asyncio.run(scenario())


def test_coordinator_selects_from_references_without_extra_call(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        references(service)
        preview = await service.preview(assessment)
        assert preview.selected is None
        context = preview.context
        assert context["rankings"] and context["candidates"][0]["references"][0]["scores"]
        assert context["candidates"][0]["reference_grade"] == "family"
        needed = await service.delegate("fixture", assessment)
        assert needed["status"] == "recommendation_required"
        assert not any(item.prompts for item in providers)
        result = await service.delegate("fixture", assessment,
                                        recommendation=recommendation(context))
        assert result["status"] == "completed" and result["acceptance"] == "unknown"
        assert len(providers[1].prompts) == 1 and not providers[0].prompts
        assert service.store.load_manifest("parent")["runtime_options"]["model"] == "main-model"
    asyncio.run(scenario())


def test_independent_evaluator_actually_sees_aa_and_ranks(service_factory, assessment):
    from types import SimpleNamespace

    from cleo.config.settings import AgentProfile

    async def scenario():
        service, providers = service_factory()
        references(service)
        profile = AgentProfile(provider="openai", model="offline", api_key="offline-secret")
        settings = SimpleNamespace(profiles=SimpleNamespace(agents={"offline": profile}))
        selection = EvaluatorSettings(mode="independent", profile_id="offline", model="offline")
        seen = []

        async def complete(profile, instructions, payload):
            data = json.loads(payload)
            assert "offline-secret" not in payload
            context = data["routing_context"]
            assert context["rankings"][0]["dimension"] == "artificial_analysis_coding_index"
            assert context["candidates"][0]["references"][0]["input_usd_per_million"] == 0.2
            seen.append(context["context_id"])
            return json.dumps({"assessment": assessment,
                               "recommendation": recommendation(context)})

        service.policy.evaluator = selection
        service.evaluator = SubtaskEvaluator(settings, selection, complete=complete)
        result = await service.delegate("fixture", assessment)
        assert result["status"] == "completed" and len(seen) == 1
        assert len(providers[1].prompts) == 1
    asyncio.run(scenario())


def test_stale_and_invented_choices_never_launch_workers(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        references(service)
        context = (await service.preview(assessment)).context
        for patch in ({"context_id": "ctx_" + "0" * 64},
                      {"candidate_id": "unconnected/model@high"},
                      {"evidence_refs": ["aa:invented"]}):
            choice = {**recommendation(context), **patch}
            result = await service.delegate("fixture", assessment, recommendation=choice)
            assert result["status"] == "evaluation_failed"
        assert not any(provider.prompts for provider in providers)
    asyncio.run(scenario())


def test_feedback_is_scoped_reversible_and_not_one_sample_per_message(
    service_factory, assessment,
):
    async def scenario():
        service, _ = service_factory()
        references(service)
        root = service._project(".")
        candidate = (await service.catalog.list(str(root)))[0]
        feedback = FeedbackStore(service.state_path)
        base = {"parent_session_id": "parent", "status": "completed",
                "final_candidate_id": candidate.id, "candidate_scope": candidate.availability_scope,
                "project_key": project_key(root), "assessment": assessment}
        for index in range(5):
            record = {**base, "task_id": f"task_{index:032x}"}
            update = {"task_id": record["task_id"], "outcome": "failed",
                      "attribution": "selection"}
            feedback.submit(record, update)
            feedback.submit(record, update)
        summary = feedback.summary(candidate, "coding", project_key(root), service.policy)
        assert summary["samples"] == 5 and -0.15 <= summary["adjustment"] < 0
        unrelated = feedback.summary(candidate, "research", project_key(root), service.policy)
        assert unrelated["samples"] == 0
        record = {**base, "task_id": "task_" + "0" * 32}
        feedback.submit(record, {"task_id": record["task_id"], "outcome": "requirements_changed",
                                 "attribution": "requirements"})
        summary = feedback.summary(candidate, "coding", project_key(root), service.policy)
        assert summary["samples"] == 4 and summary["adjustment"] == 0
        service.policy.feedback_enabled = False
        frozen = feedback.summary(candidate, "coding", project_key(root), service.policy)
        assert not frozen["active"]
    asyncio.run(scenario())
