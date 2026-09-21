import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from openai_codex.client import _params_dict

from cleo.harnesses.control import SessionOptions
from cleo.integrations.harnesses.codex import CodexProvider, _CodexRuntime


@pytest.mark.parametrize("approval", ["user", "auto_review", "deny_all"])
def test_fast_can_be_enabled_and_explicitly_cleared_without_changing_approval(approval):
    async def scenario():
        start = AsyncMock(return_value=SimpleNamespace(turn=SimpleNamespace(id="turn")))
        high_level = AsyncMock()
        runtime = _CodexRuntime(
            SimpleNamespace(_client=SimpleNamespace(turn_start=start)),
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
