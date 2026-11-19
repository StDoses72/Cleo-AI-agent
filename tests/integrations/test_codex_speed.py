import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from openai_codex.async_client import AsyncCodexClient
from openai_codex.client import _params_dict

from cleo.harnesses.control import SessionOptions
from cleo.integrations.harnesses.codex import CodexProvider, _CodexRuntime


@pytest.mark.parametrize("approval", ["user", "auto_review", "deny_all"])
def test_fast_can_be_enabled_and_explicitly_cleared_without_changing_approval(approval):
    async def scenario():
        start = AsyncMock(return_value=SimpleNamespace(turn=SimpleNamespace(id="turn")))
        low_level = AsyncCodexClient()
        low_level.turn_start = start
        high_level = AsyncMock()
        runtime = _CodexRuntime(
            SimpleNamespace(_client=low_level),
            SimpleNamespace(id="native", turn=high_level),
            options=SessionOptions(approval_mode=approval, sandbox="workspace-write"),
        )
        provider = CodexProvider(None)
        provider._sessions["native"] = runtime
        await provider.update_session_options("native", service_tier="fast")
        await provider.update_session_options("native", model="another-model", effort="high")
        assert runtime.options.service_tier == "fast"
        await provider._start_turn(runtime, "Fast request")
        if approval == "user":
            assert start.call_args.kwargs["params"]["serviceTier"] == "fast"
        else:
            assert high_level.call_args.kwargs["service_tier"] == "fast"
        await provider.update_session_options("native", service_tier="default")
        await provider._start_turn(runtime, "Standard request")
        wire = _params_dict(start.call_args.kwargs["params"])
        assert "serviceTier" in wire and wire["serviceTier"] is None
        assert wire["approvalPolicy"] == ("never" if approval == "deny_all" else "on-request")
        if approval == "user":
            assert wire["approvalsReviewer"] == "user"
        elif approval == "auto_review":
            assert wire["approvalsReviewer"] == "auto_review"
        else:
            assert "approvalsReviewer" not in wire
        assert wire["effort"] == "high" and wire["model"] == "another-model"
        with pytest.raises(ValueError, match="速度档位"):
            await provider.update_session_options("native", service_tier="invalid")
        assert runtime.options.service_tier == "default"

    asyncio.run(scenario())


def _catalog_model(identifier, tiers=(), legacy=(), default=False):
    return SimpleNamespace(
        model=identifier, display_name=identifier, description="fixture", is_default=default,
        default_reasoning_effort="high", supported_reasoning_efforts=[],
        service_tiers=[SimpleNamespace(id=tier, name=tier.title(), description=f"{tier} speed")
                       for tier in tiers],
        additional_speed_tiers=list(legacy),
    )


def test_catalog_speeds_map_native_ids_and_fall_back_to_the_legacy_list():
    from cleo.integrations.harnesses.codex import _catalog_service_tiers

    both = _catalog_service_tiers(_catalog_model("m", tiers=("ultrafast", "priority", "flex")))
    assert [(tier.id, tier.label, tier.description) for tier in both] == [
        ("fast", "Priority", "priority speed"), ("ultrafast", "Ultrafast", "ultrafast speed"),
    ]
    legacy = _catalog_service_tiers(_catalog_model("m", legacy=("fast",)))
    assert [(tier.id, tier.label) for tier in legacy] == [("fast", "Fast")]
    assert _catalog_service_tiers(_catalog_model("m")) == ()


def test_ultrafast_is_sent_only_for_a_model_whose_catalog_offers_it():
    async def scenario():
        start = AsyncMock(return_value=SimpleNamespace(turn=SimpleNamespace(id="turn")))
        low_level = AsyncCodexClient()
        low_level.turn_start = start
        catalog = SimpleNamespace(data=[
            _catalog_model("ultra-model", tiers=("priority", "ultrafast"), default=True),
            _catalog_model("fast-model", tiers=("priority",)),
        ])
        read_catalog = AsyncMock(return_value=catalog)
        runtime = _CodexRuntime(
            SimpleNamespace(_client=low_level, models=read_catalog),
            SimpleNamespace(id="native", turn=AsyncMock()),
            options=SessionOptions(approval_mode="user", model="ultra-model"),
        )
        provider = CodexProvider(None)
        provider._sessions["native"] = runtime
        await provider.update_session_options("native", service_tier="ultrafast")

        async def sent_tier():
            await provider._start_turn(runtime, "request")
            return _params_dict(start.call_args.kwargs["params"])["serviceTier"]

        assert await sent_tier() == "ultrafast"
        # A model without Ultrafast runs at standard speed; the saved choice is kept.
        await provider.update_session_options("native", model="fast-model")
        assert await sent_tier() is None
        assert runtime.options.service_tier == "ultrafast"
        await provider.update_session_options("native", service_tier="fast")
        assert await sent_tier() == "fast"
        # The catalog default model stands in when the session names no model.
        runtime.options = SessionOptions(approval_mode="user", service_tier="ultrafast")
        assert await sent_tier() == "ultrafast"
        # A model the catalog does not list keeps the saved tier, and is looked up once.
        await provider.update_session_options("native", model="custom-model")
        assert await sent_tier() == "ultrafast"
        assert await sent_tier() == "ultrafast"
        assert read_catalog.await_count == 2

    asyncio.run(scenario())


def test_list_models_reports_each_models_speeds(monkeypatch):
    from cleo.integrations.harnesses import codex_models

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.models.return_value = SimpleNamespace(data=[
        _catalog_model("ultra-model", tiers=("priority", "ultrafast")),
        _catalog_model("plain-model"),
    ])
    monkeypatch.setattr(CodexProvider, "_client", lambda _: client)
    monkeypatch.setattr(codex_models, "account_model_ids", AsyncMock(return_value=None))
    provider = CodexProvider(None)
    models = asyncio.run(provider.list_models())
    assert [[tier.id for tier in model.service_tiers] for model in models] == [
        ["fast", "ultrafast"], [],
    ]
    assert provider._model_tiers["ultra-model"] == frozenset({"fast", "ultrafast"})
