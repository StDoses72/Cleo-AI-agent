"""Regression coverage for account-rejected models without real inference."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from cleo.harnesses.availability import ModelAvailability, provider_scope, unsupported_reason
from cleo.harnesses.control import HarnessModel
from cleo.harnesses.provider import ProviderTurn
from cleo.routing.catalog import candidate_id
from cleo.routing.models import CandidatePolicy


def test_account_unsupported_model_is_not_replayed_after_metadata_refresh(
    service_factory, assessment,
):
    async def scenario():
        service, providers = service_factory(policy={"automatic_upgrade": True})
        identifier = candidate_id("economy", "gpt-6.1-sol", "high")
        service.policy.fallback_candidate = identifier
        service.policy.candidates[identifier] = CandidatePolicy(tier="strong")
        providers[0].list_models = AsyncMock(return_value=(
            HarnessModel("gpt-6.1-sol", "Fixture", "Fixture", True, "high", ("high",),
                         available=True, availability_source="fixture_account_catalog"),
        ))
        providers[0].prompt = AsyncMock(return_value=ProviderTurn(
            "fixture", "turn", "failed", error=(
                '{"type":"error","status":400,"error":{"type":"invalid_request_error",'
                '"message":"The \'gpt-6.1-sol\' model is not supported when using Codex '
                'with a ChatGPT account."}}'
            ),
        ))
        request = {"candidate_id": identifier}
        first = await service.delegate("offline fixture", assessment, request)
        assert first["failure_category"] == "model_unsupported"
        assert first["attempts"] == 1 and not providers[1].prompts
        refreshed = await service.catalog.list(str(service._project(".")), refresh=True)
        rejected = next(item for item in refreshed if item.id == identifier)
        assert rejected.available is False and rejected.enabled is False
        assert rejected.status_reason == "model_unsupported"
        second = await service.delegate("offline fixture", assessment, request)
        assert second["status"] == "rejected"
        assert providers[0].prompt.await_count == 1

    asyncio.run(scenario())


def test_catalog_only_names_are_not_enabled_even_by_old_blanket_policy(service_factory):
    async def scenario():
        service, providers = service_factory()
        providers[0].list_models = AsyncMock(return_value=(
            HarnessModel("fixture-model", "Fixture", "Bundled name", True, "high", ("high",)),
        ))
        entries = await service.catalog.list(str(service._project(".")))
        selected = next(item for item in entries if item.provider == "economy")
        assert selected.available is None and not selected.enabled
        assert selected.status_reason == "account_support_unknown"
        assert not providers[0].prompts

    asyncio.run(scenario())


def test_evidence_survives_restart_but_is_scoped_to_account_and_effort(service_factory):
    async def scenario():
        service, providers = service_factory()
        provider = providers[0]
        provider.availability_identity = "first-account"
        scope = provider_scope(provider)
        service.catalog.availability.record(scope, "fixture-model", "*", available=False,
                                            reason="model_unsupported")
        entries = await service.catalog.list(str(service._project(".")), refresh=True)
        assert not next(item for item in entries if item.provider == "economy").enabled
        provider.availability_identity = "second-account"
        entries = await service.catalog.list(str(service._project(".")))
        assert next(item for item in entries if item.provider == "economy").enabled
        provider.availability_identity = "first-account"
        restarted, _ = service_factory()
        restarted.adapter.provider_control("economy").availability_identity = "first-account"
        entries = await restarted.catalog.list(str(restarted._project(".")), refresh=True)
        assert not next(item for item in entries if item.provider == "economy").enabled

    asyncio.run(scenario())


@pytest.mark.parametrize("error", [
    "network timeout", "401 unauthorized", "429 quota", "400 invalid request",
    'The "different-model" model is not supported with this account.',
    'The "fixture-model" model context window was exceeded.',
])
def test_unrelated_errors_do_not_poison_support(error):
    assert unsupported_reason(error, "fixture-model", "high") is None


def test_effort_rejection_does_not_disable_other_efforts_or_models(tmp_path):
    store = ModelAvailability(tmp_path)
    store.record("account", "model", "high", available=False, reason="effort_unsupported")
    assert store.read("account", "model", "high")["available"] is False
    assert store.read("account", "model", "low") is None
    assert store.read("account", "different", "high") is None
    store.record("account", "model", None, available=True, reason="execution_completed")
    store.record("account", "model", "high", available=True, reason="execution_completed")
    assert store.read("account", "model", "high")["available"] is False
    assert store.read("account", "model", "low") is None
    assert (unsupported_reason("reasoning effort 'high' is not supported", "model", "high")
            == "effort_unsupported")
    assert "network timeout" not in json.dumps([json.loads(p.read_text())
                                               for p in store.root.glob("*.json")])


def test_main_harness_failure_is_shared_with_routing_and_not_replayed(service_factory):
    async def scenario():
        service, providers = service_factory()
        provider = providers[0]
        provider.prompt = AsyncMock(side_effect=RuntimeError(
            "The 'fixture-model' model is not supported when using Codex with a ChatGPT account.",
        ))
        child = await service.adapter.create_session("economy", model="fixture-model")
        with pytest.raises(RuntimeError, match="not supported"):
            await service.adapter.prompt(child.id, "offline")
        with pytest.raises(ValueError, match="model_unsupported"):
            await service.adapter.prompt(child.id, "offline")
        entries = await service.catalog.list(str(service._project(".")), refresh=True)
        assert not next(item for item in entries if item.provider == "economy").enabled
        assert provider.prompt.await_count == 1
        await service.adapter.close(child.id)

    asyncio.run(scenario())
