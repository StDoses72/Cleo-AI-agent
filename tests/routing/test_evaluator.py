import asyncio
import json
from types import SimpleNamespace

import pytest

from cleo.config.settings import AgentProfile
from cleo.routing.evaluator import SubtaskEvaluator, complete_assessment, evaluator_profile
from cleo.routing.models import EvaluatorSettings, TaskAssessment


def configured(backend="api"):
    """Purpose: Provide connected model metadata only. Output: isolated API/harness profile."""
    profile = AgentProfile(
        provider="openai" if backend == "api" else backend, backend=backend,
        model="fixture-evaluator", api_key="private-fixture-key" if backend == "api" else "",
    )
    settings = SimpleNamespace(profiles=SimpleNamespace(agents={"evaluator": profile}))
    selection = EvaluatorSettings(
        mode="independent", profile_id="evaluator", model="fixture-evaluator",
    )
    return settings, selection


@pytest.mark.parametrize("backend", ["api", "codex", "claude_code"])
def test_explicit_evaluator_connection_and_model_validation(backend):
    settings, selection = configured(backend)
    assert evaluator_profile(settings, selection).backend == backend
    selection.model = "unconnected-model"
    with pytest.raises(ValueError, match="模型目录"):
        evaluator_profile(settings, selection)


def test_evaluator_cannot_relax_hard_requirements(assessment):
    async def scenario():
        settings, selection = configured()
        original = TaskAssessment.model_validate({
            **assessment, "required_capabilities": ["text", "file_read"],
            "context_requirement": 12000, "failure_impact": "high",
            "budget": {"max_usd": 1},
        })

        async def complete(profile, instructions, payload):
            assert "private-fixture-key" not in payload
            return json.dumps({**assessment, "context_requirement": 100,
                               "budget": {"max_usd": 1000}})

        evaluated, _ = await SubtaskEvaluator(settings, selection, complete=complete).assess(
            "one decomposed subtask", original,
        )
        assert evaluated.required_capabilities == {"text", "file_read"}
        assert evaluated.context_requirement == 12000 and evaluated.failure_impact == "high"
        assert evaluated.budget.max_usd == 1
        assert evaluated.acceptance_criteria == original.acceptance_criteria

    asyncio.run(scenario())


def test_only_actual_delegation_calls_the_selected_evaluator(
    service_factory, assessment, tmp_path,
):
    async def scenario():
        service, providers = service_factory()
        settings, selection = configured()
        calls = []

        async def complete(*args):
            calls.append(1)
            return json.dumps(assessment)

        service.policy.evaluator = selection
        service.evaluator = SubtaskEvaluator(settings, selection, complete=complete)
        await service.preview(assessment)
        assert calls == []
        result = await service.delegate("subtask", assessment)
        assert result["status"] == "completed" and calls == [1]
        path = service.state_path / "tasks" / f"{result['task_id']}.json"
        record = json.loads(path.read_text())
        assert record["evaluator"]["model"] == "fixture-evaluator"
        assert record["acceptance"] == "unknown"
        assert len(providers[0].prompts) == 1
        assert service.store.load_manifest("parent")["runtime_options"]["model"] == "main-model"

    asyncio.run(scenario())


@pytest.mark.parametrize("behavior", ["invalid", "network", "cancel", "budget"])
def test_failed_cancelled_or_unbudgeted_evaluation_never_launches_a_child(
    behavior, service_factory, assessment,
):
    async def scenario():
        service, providers = service_factory()
        settings, selection = configured()
        calls = []

        async def complete(*args):
            calls.append(1)
            if behavior == "cancel":
                raise asyncio.CancelledError()
            if behavior == "network":
                raise OSError("network error private-fixture-key")
            return json.dumps({**assessment, "approval_mode": "bypassPermissions"})

        service.policy.evaluator = selection
        service.evaluator = SubtaskEvaluator(settings, selection, complete=complete)
        task = {**assessment, **({"budget": {"max_usd": 1}} if behavior == "budget" else {})}
        if behavior == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await service.delegate("sensitive-task-text", task)
        else:
            result = await service.delegate("sensitive-task-text", task)
            assert result["status"] == ("rejected" if behavior == "budget" else "evaluation_failed")
        assert not any(provider.prompts or provider.sessions for provider in providers)
        record = next((service.state_path / "tasks").glob("*.json")).read_text()
        assert "sensitive-task-text" not in record and "private-fixture-key" not in record
        assert json.loads(record)["acceptance"] == "unknown"
        assert len(calls) == (0 if behavior == "budget" else 1)
        if behavior == "cancel":
            assert json.loads(record)["status"] == "cancelled"

    asyncio.run(scenario())


def test_harness_evaluator_uses_existing_isolated_transport(monkeypatch):
    async def scenario():
        settings, selection = configured("codex")
        profile = evaluator_profile(settings, selection)
        seen = []

        async def complete(selected, cwd, instructions, prompt):
            assert selected.model == "fixture-evaluator" and cwd.is_dir()
            seen.append(cwd)
            return "{}"

        monkeypatch.setattr("cleo.integrations.subscriptions.subscription_text", complete)
        assert (await complete_assessment(profile, "instructions", "subtask")).text == "{}"
        assert seen and not seen[0].exists()

    asyncio.run(scenario())


def test_unset_evaluator_follows_new_conversation_default_not_task_main(assessment):
    async def scenario():
        settings, _ = configured()
        settings.active_agent_profile = settings.profiles.agents["evaluator"]
        settings.active_profiles = SimpleNamespace(agent="evaluator")
        seen = []

        async def complete(profile, *_):
            seen.append(profile.model)
            return json.dumps(assessment)

        evaluator = SubtaskEvaluator(settings, EvaluatorSettings(), complete=complete, parent={
            "runtime_options": {"agent_profile": "different-connection", "chat_profile": {
                "backend": "api", "provider": "openai", "model": "task-main-model",
            }},
        })
        task = TaskAssessment.model_validate(assessment)
        _, info = await evaluator.assess("subtask", task)
        assert seen == ["fixture-evaluator"] and info["mode"] == "default"
        settings.active_agent_profile = settings.active_agent_profile.model_copy(
            update={"model": "new-conversation-default"},
        )
        await evaluator.assess("next subtask", task)
        assert seen == ["fixture-evaluator", "new-conversation-default"]

    asyncio.run(scenario())


def test_default_evaluator_reuses_only_the_same_coordinator_connection(assessment):
    async def scenario():
        settings, _ = configured()
        settings.active_agent_profile = settings.profiles.agents["evaluator"]
        settings.active_profiles = SimpleNamespace(agent="evaluator")
        parent = {"runtime_options": {"agent_profile": "evaluator", "chat_profile": {
            "backend": "api", "provider": "openai", "model": "fixture-evaluator",
        }}}

        async def forbidden(*_):
            raise AssertionError("Matching coordinator must not trigger another call")

        evaluator = SubtaskEvaluator(
            settings, EvaluatorSettings(), complete=forbidden, parent=parent,
        )
        _, info = await evaluator.assess("subtask", TaskAssessment.model_validate(assessment))
        assert info["status"] == "reused_coordinator_assessment"
        parent["runtime_options"]["agent_profile"] = "different-connection"
        assert evaluator.requires_call() is True

    asyncio.run(scenario())


def test_api_evaluator_uses_selected_model_and_reports_only_usage(monkeypatch):
    async def scenario():
        settings, selection = configured()
        seen = []

        class Model:
            async def ainvoke(self, messages):
                return SimpleNamespace(content="{}", response_metadata={}, usage_metadata={
                    "input_tokens": 20, "output_tokens": 10, "total_tokens": 30,
                    "private": "must-not-be-returned",
                })

        def build(**kwargs):
            seen.append(kwargs["model"])
            return Model()

        monkeypatch.setattr("langchain.chat_models.init_chat_model", build)
        result = await complete_assessment(evaluator_profile(settings, selection), "rules", "task")
        assert seen == ["fixture-evaluator"]
        assert result.text == "{}" and result.usage == {
            "input_tokens": 20, "output_tokens": 10, "total_tokens": 30,
        }

    asyncio.run(scenario())


def test_cancel_during_metadata_discovery_is_recorded_without_a_model_call(
    service_factory, assessment,
):
    async def scenario():
        service, providers = service_factory()
        entered = asyncio.Event()

        async def waiting(*_):
            entered.set()
            await asyncio.Event().wait()

        service.catalog.list = waiting
        operation = asyncio.create_task(service.delegate("subtask", assessment))
        await entered.wait()
        operation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await operation
        record = json.loads(next((service.state_path / "tasks").glob("*.json")).read_text())
        assert record["status"] == "cancelled" and record["acceptance"] == "unknown"
        assert record["attempts"] == [] and not any(provider.prompts for provider in providers)

    asyncio.run(scenario())


def test_unavailable_executors_do_not_spend_an_evaluator_call(service_factory, assessment):
    async def scenario():
        service, providers = service_factory()
        settings, selection = configured()
        called = []

        async def complete(*_):
            called.append(True)
            return json.dumps(assessment)

        async def empty(*_):
            return []

        service.policy.evaluator = selection
        service.evaluator = SubtaskEvaluator(settings, selection, complete=complete)
        service.catalog.list = empty
        result = await service.delegate("subtask", assessment)
        assert result["status"] == "rejected" and not called
        assert not any(provider.prompts for provider in providers)

    asyncio.run(scenario())
