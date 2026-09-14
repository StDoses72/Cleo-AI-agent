"""Regression coverage for a Codex draft that has no durable rollout yet."""

import asyncio
from types import SimpleNamespace

import pytest
from openai_codex.errors import JsonRpcError

from cleo.harnesses import AgentAdapter
from cleo.harnesses.provider import NativeSessionNotFoundError
from cleo.integrations.harnesses.codex import CodexProvider


class DraftClient:
    """Model the real CLI losing an unstarted thread when its process exits."""

    def __init__(self, calls, error=None):
        self.calls = calls
        self.error = error

    async def __aenter__(self):
        return self

    async def close(self):
        self.calls.append("close")

    async def thread_start(self, **_options):
        self.calls.append("start")
        return SimpleNamespace(id=f"native-{self.calls.count('start')}")

    async def thread_resume(self, native_id, **_options):
        self.calls.append("resume")
        raise self.error or JsonRpcError(-32600, f"no rollout found for thread id {native_id}")


def test_missing_empty_rollout_reconnects_the_same_cleo_task_and_options(tmp_path):
    async def exercise():
        calls = []
        provider = CodexProvider("model")
        provider._client_with_approvals = lambda _broker: DraftClient(calls)
        first = AgentAdapter(tmp_path)
        first.register(provider)
        original = await first.create_session("codex", model="model")
        await first.update_session_options(
            original.id, effort="max", approval_mode="deny_all", sandbox="workspace-write"
        )
        await first.close(original.id)
        recovered = AgentAdapter(tmp_path, session_store=first._store)
        recovered.register(provider)
        resumed = await recovered.resume_session("codex", original.native_session_id)
        assert resumed.id == original.id
        assert resumed.native_session_id != original.native_session_id
        assert recovered.session_options(resumed.id).effort == "max"
        assert recovered.session_options(resumed.id).sandbox == "workspace-write"
        assert calls.count("start") == 2
        assert (
            first._store.load_manifest(original.id)["native_session_id"]
            == resumed.native_session_id
        )
        await recovered.close(resumed.id)

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "with_history,error",
    [
        (True, None),
        (False, JsonRpcError(-32600, "invalid request for a different reason")),
        (False, JsonRpcError(-32000, "authentication failed")),
        (False, RuntimeError("transport unavailable")),
    ],
)
def test_reconnect_never_discards_history_or_retries_unrelated_failures(
    tmp_path, with_history, error
):
    async def exercise():
        calls = []
        provider = CodexProvider("model")
        provider._client_with_approvals = lambda _broker: DraftClient(calls, error)
        first = AgentAdapter(tmp_path)
        first.register(provider)
        original = await first.create_session("codex", model="model")
        if with_history:
            first._store.append_event(
                space="productivity",
                project=original.project,
                session_id=original.id,
                event_type="user_message",
                actor="user",
                content="keep my history",
            )
        await first.close(original.id)
        recovered = AgentAdapter(tmp_path, session_store=first._store)
        recovered.register(provider)
        with pytest.raises(NativeSessionNotFoundError if error is None else type(error)):
            await recovered.resume_session("codex", original.native_session_id)
        assert calls.count("start") == 1
        assert (
            first._store.load_manifest(original.id)["native_session_id"]
            == original.native_session_id
        )

    asyncio.run(exercise())
