import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from openai_codex import AsyncTurnHandle
from openai_codex.errors import JsonRpcError
from openai_codex.generated.v2_all import TurnSteerResponse

from cleo.harnesses.control import SessionOptions, SteerRejected
from cleo.integrations.harnesses.codex import CodexProvider, _CodexRuntime


def fixture():
    method = AsyncMock(return_value=TurnSteerResponse(turn_id="native-turn"))
    client = SimpleNamespace(_ensure_initialized=AsyncMock(),
                             _client=SimpleNamespace(turn_steer=method))
    turn = AsyncTurnHandle(client, "native-thread", "native-turn")
    options = SessionOptions(model="model", sandbox="workspace-write", approval_mode="auto_review")
    runtime = _CodexRuntime(client, SimpleNamespace(id="native-thread"), options=options,
                            active_turn=turn)
    provider = CodexProvider(None)
    provider._sessions["session"] = runtime
    return provider, runtime, method


def test_native_sdk_steer_uses_expected_turn_and_only_appends_input():
    provider, runtime, method = fixture()
    original = runtime.options
    asyncio.run(provider.steer("session", "keep the goal; focus on tests", "native-turn"))
    method.assert_awaited_once()
    thread_id, turn_id, inputs = method.call_args.args
    assert (thread_id, turn_id) == ("native-thread", "native-turn")
    assert inputs[0]["type"] == "text"
    assert inputs[0]["text"] == "keep the goal; focus on tests"
    assert not method.call_args.kwargs
    assert runtime.options == original


@pytest.mark.parametrize("active", [True, False])
def test_stale_or_finished_turn_is_rejected_before_transport(active):
    provider, runtime, method = fixture()
    if not active:
        runtime.active_turn = None
    with pytest.raises(SteerRejected, match="未投递"):
        asyncio.run(provider.steer("session", "new input", "old-turn"))
    method.assert_not_awaited()


@pytest.mark.parametrize("error,rejected", [
    (JsonRpcError(-32601, "method not found"), True),
    (JsonRpcError(-32600, "no active turn"), True),
    (JsonRpcError(-32602, "invalid params"), True),
    (JsonRpcError(-32603, "internal error after accepting input"), False),
    (ConnectionError("acknowledgement lost"), False),
])
def test_transport_uncertainty_is_not_mislabeled_as_a_safe_rejection(error, rejected):
    provider, _, method = fixture()
    method.side_effect = error
    with pytest.raises(SteerRejected if rejected else type(error)):
        asyncio.run(provider.steer("session", "new input", "native-turn"))
