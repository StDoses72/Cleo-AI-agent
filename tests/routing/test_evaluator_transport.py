"""Exercise the real evaluator/provider configuration seam without launching a CLI."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.config.settings import AgentProfile
from cleo.harnesses.provider import ProviderTurn
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.subscriptions import AgentMcp
from cleo.routing.models import RoutingSettings
from cleo.runtime.task_tracking import begin_task_turn
from cleo.sessions.store import SessionStore


@pytest.mark.parametrize("decision", ["new", "continue", "cancel"])
def test_boundary_uses_real_subscription_configuration(tmp_path, monkeypatch, decision):
    """Purpose: Catch provider protocol drift before any paid turn. Output: confirmed boundary."""
    store = SessionStore(tmp_path / "memory")
    store.create_session(session_id="root", space="non_productivity", project="general",
                         provider="cleo", owner_type="user")
    store.update_manifest("root", runtime_options={"model": "keep-main"})
    settings = SimpleNamespace(active_agent_profile=AgentProfile(
        provider="codex", backend="codex", model="fixture-default"))
    policy = RoutingSettings(task_tracking_enabled=True)
    configs = []
    client = SimpleNamespace(__aenter__=AsyncMock(), close=AsyncMock(),
                             thread_start=AsyncMock(return_value=SimpleNamespace(id="native")),
                             _client=SimpleNamespace(_sync=SimpleNamespace(_approval_handler=None)))
    monkeypatch.setattr("cleo.integrations.subscriptions.executable", lambda profile: "fake-cli")

    def fake_client(config, **kwargs):
        configs.append(config)
        return client

    monkeypatch.setattr(CodexProvider, "_client", staticmethod(fake_client))
    prompt = AsyncMock(return_value=ProviderTurn(native_session_id="native", turn_id="turn",
        status="completed", response=f'{{"decision":"{decision}","abstract":"Task"}}'))
    monkeypatch.setattr(CodexProvider, "prompt", prompt)
    if decision == "cancel":
        prompt.side_effect = asyncio.CancelledError

    async def scenario():
        first = await begin_task_turn(store, settings, store.load_manifest("root"), "first", policy)
        if decision == "cancel":
            with pytest.raises(asyncio.CancelledError):
                await begin_task_turn(store, settings, store.load_manifest("root"), "next", policy)
            assert store.read_events("root")[-1]["data"]["status"] == "cancelled"
        else:
            second = await begin_task_turn(
                store, settings, store.load_manifest("root"), "next", policy)
            assert second["status"] == "confirmed", second["evaluation"]
            assert (first["task_id"] == second["task_id"]) == (decision == "continue")
        assert store.load_manifest("root")["runtime_options"]["model"] == "keep-main"

    asyncio.run(scenario())
    prompt.assert_awaited_once()
    client.close.assert_awaited_once()
    assert configs[0].codex_bin == "fake-cli"
    overrides = " ".join(configs[0].config_overrides)
    assert "dream_extract" in overrides and "forced_login_method" in overrides
    assert "cleo_computer" not in overrides


def test_readonly_adapter_rejects_permission_expansion(tmp_path, monkeypatch):
    """Purpose: New provider parameters must not grant evaluator tools or approvals."""
    profile = AgentProfile(provider="codex", backend="codex", model="fixture")
    monkeypatch.setattr("cleo.integrations.subscriptions.executable", lambda profile: "fake-cli")
    with pytest.raises(ValueError):
        AgentMcp(profile, tmp_path, "readonly", mode="dream_extract").codex_config(
            approval_mode="user", computer_client="ignored")
