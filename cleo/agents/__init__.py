"""Foreground and memory-consolidation agents.

导出说明:
    Agent: 前台交互 Agent (cleo/agents/cleo.py), 供 cleo/cli 的对话
        流程实例化与流式调用。
    DreamAgent: 后台记忆整理 Agent (cleo/agents/dream.py), 供
        cleo/cli/lifecycle.py 在会话结束时执行 memory consolidation。
"""

from cleo.agents.cleo import Agent
from cleo.agents.dream import DreamAgent

__all__ = ["Agent", "DreamAgent"]
