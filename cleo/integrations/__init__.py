"""对外暴露 integrations 公共入口: 统一 adapter 模型与各 harness provider。

re-export ``cleo.harnesses`` 的核心模型(AgentAdapter / AgentEvent /
AgentResult / AgentSession)、兼容门面 ``CodexAdapter`` 及各 provider,
供 MCP server、agent tools 与 CLI 使用。
"""

from cleo.harnesses import (
    AgentAdapter,
    AgentEvent,
    AgentResult,
    AgentSession,
)
from cleo.integrations.codex import CodexAdapter, CodexResult
from cleo.integrations.harnesses import AcpAgentSpec, ClaudeProvider, CodexProvider

__all__ = [
    "AcpAgentSpec",
    "AgentAdapter",
    "AgentEvent",
    "AgentResult",
    "AgentSession",
    "ClaudeProvider",
    "CodexAdapter",
    "CodexProvider",
    "CodexResult",
]
