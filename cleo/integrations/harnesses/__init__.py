"""External harness provider implementations and their composition factory.

Names load on first use, so importing one provider (or the light helpers beside them) does not
import every harness SDK.
"""

from importlib import import_module

_EXPORTS = {
    "AcpAgentSpec": "cleo.integrations.harnesses.acp",
    "AcpProvider": "cleo.integrations.harnesses.acp",
    "ClaudeProvider": "cleo.integrations.harnesses.claude",
    "CodexProvider": "cleo.integrations.harnesses.codex",
    "build_agent_adapter": "cleo.integrations.harnesses.factory",
    "create_provider": "cleo.integrations.harnesses.factory",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(_EXPORTS[name]), name)
    globals()[name] = value
    return value
