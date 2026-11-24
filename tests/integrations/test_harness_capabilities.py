from __future__ import annotations

import asyncio

import pytest

from cleo.harnesses.capabilities import REQUIRED_METHODS, Capability, capabilities_of
from cleo.harnesses.models import AgentEvent
from cleo.harnesses.provider import ProviderSession
from cleo.harnesses.service import AgentService
from cleo.integrations.harnesses.acp import AcpProvider
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.factory import provider_capabilities
from cleo.sessions.store import SessionStore


@pytest.mark.parametrize("provider", [CodexProvider, ClaudeProvider, AcpProvider],
                         ids=lambda provider: provider.__name__)
def test_declared_capabilities_match_the_methods_a_provider_implements(provider) -> None:
    declared = capabilities_of(provider)
    for capability, methods in REQUIRED_METHODS.items():
        implemented = all(callable(getattr(provider, method, None)) for method in methods)
        if capability in declared:
            assert implemented, f"{provider.__name__} declares {capability} without {methods}"
        elif methods != ("update_session_options",):
            # Every provider updates session options; only the methods unique to a
            # capability imply it.
            assert not implemented, f"{provider.__name__} implements {capability} undeclared"


def test_harness_types_resolve_to_the_capability_matrix() -> None:
    assert provider_capabilities("codex_sdk") == set(Capability) - {Capability.LIVE_LOG}
    assert provider_capabilities("claude_sdk") == {
        Capability.REWIND, Capability.QUESTIONS, Capability.USER_APPROVALS,
        Capability.LIVE_LOG,
    }
    assert provider_capabilities("acp") == {Capability.USER_APPROVALS}
    assert provider_capabilities("unknown") == frozenset()
    assert provider_capabilities(None) == frozenset()
    assert capabilities_of(object()) == frozenset()


class CutShortProvider:
    """Streams half a reply to the callback it is given, then loses its connection."""

    def __init__(self, name: str, capabilities: tuple[Capability, ...]) -> None:
        self.name = name
        self.capabilities = frozenset(capabilities)
        self.callbacks: list[object] = []

    async def create_session(self, project_path: str, model: str | None = None):
        return ProviderSession(id="provider-session", native_id="native")

    async def prompt(self, session_id, prompt, on_event=None):
        self.callbacks.append(on_event)
        if on_event is not None:
            await on_event(AgentEvent(
                provider=self.name, type="assistant_message_chunk", text="only half",
                data={"provider_event_type": "stream_event", "payload": {"stream": "message"}},
            ))
        raise RuntimeError("stream ended")


@pytest.mark.parametrize("name, capabilities, kept", [
    ("claude", (), []),
    ("other", (Capability.LIVE_LOG,), ["only half"]),
], ids=["named-claude-undeclared", "declares-live-log"])
def test_a_turn_nobody_listens_to_is_logged_live_only_when_the_provider_declares_it(
    tmp_path, name, capabilities, kept,
) -> None:
    store = SessionStore(tmp_path / "memory")
    service = AgentService(tmp_path, session_store=store)
    provider = CutShortProvider(name, capabilities)
    service.register(provider)

    async def scenario() -> str:
        session = await service.create_session(name, project_path=str(tmp_path))
        with pytest.raises(RuntimeError, match="stream ended"):
            await service.prompt(session.id, "hi")
        return session.id

    session_id = asyncio.run(scenario())

    assert [callback is not None for callback in provider.callbacks] == [bool(kept)]
    assert [event["content"] for event in store.read_events(session_id)
            if event["type"] == "assistant_fragment"] == kept
