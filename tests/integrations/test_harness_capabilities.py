from __future__ import annotations

import pytest

from cleo.harnesses.capabilities import REQUIRED_METHODS, Capability, capabilities_of
from cleo.integrations.harnesses.acp import AcpProvider
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.factory import provider_capabilities


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
    assert provider_capabilities("codex_sdk") == set(Capability)
    assert provider_capabilities("claude_sdk") == {
        Capability.REWIND, Capability.QUESTIONS, Capability.USER_APPROVALS,
    }
    assert provider_capabilities("acp") == {Capability.USER_APPROVALS}
    assert provider_capabilities("unknown") == frozenset()
    assert provider_capabilities(None) == frozenset()
    assert capabilities_of(object()) == frozenset()
