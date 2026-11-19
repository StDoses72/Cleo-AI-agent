"""对外暴露 integrations 公共入口: 统一 adapter 模型与各 harness provider。

re-export ``cleo.harnesses`` 的核心模型(AgentAdapter / AgentEvent /
AgentResult / AgentSession)、兼容门面 ``CodexAdapter`` 及各 provider,
供 MCP server、agent tools 与 CLI 使用。名称在首次访问时才导入:
任何 ``cleo.integrations.*`` 子模块的导入都会先执行本文件, 而 provider
会拉起各家 SDK(数秒), 不能让只用到 git 或 harness_home 的进程付这个代价。
"""

from importlib import import_module

_EXPORTS = {
    "AgentAdapter": "cleo.harnesses",
    "AgentEvent": "cleo.harnesses",
    "AgentResult": "cleo.harnesses",
    "AgentSession": "cleo.harnesses",
    "CodexAdapter": "cleo.integrations.codex",
    "CodexResult": "cleo.integrations.codex",
    "AcpAgentSpec": "cleo.integrations.harnesses.acp",
    "ClaudeProvider": "cleo.integrations.harnesses.claude",
    "CodexProvider": "cleo.integrations.harnesses.codex",
}

__all__ = sorted(_EXPORTS)


def __getattr__(name: str):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(_EXPORTS[name]), name)
    globals()[name] = value
    return value
