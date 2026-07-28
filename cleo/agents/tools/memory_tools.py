"""Project-bound memory retrieval tools exposed to the interactive agent."""

from __future__ import annotations

import json

from langchain.tools import tool

from cleo.memory.store import search_conversation_history, search_memories


def create_project_memory_search_tool(space: str, project: str):
    """Bind durable-memory lookup to the current space and project.

    中文说明: 工厂函数, 生成绑定了当前 space/project 闭包变量的
    `search_long_term_memory` tool, 防止 LLM 通过参数越界访问其他
    项目的记忆。

    Args:
        space/project: 绑定的记忆空间与项目; 由 cleo/agents/cleo.py
            Agent.__init__ 在构建 toolist 时传入 (源自 CLI 的当前
            space/project)。

    Returns:
        langchain `@tool` 包装的 tool 对象; 被 Agent.__init__ 放入
        toolist 传给 create_deep_agent, 之后由 deepagents 框架按 LLM
        tool call 调用。
    """

    @tool("search_long_term_memory")
    def search_long_term_memory(
        query: str = "",
        categories: list[str] | None = None,
        tags: list[str] | None = None,
        limit: int = 10,
    ) -> str:
        """Search evidence-backed durable memory for the current project.

        Use this for stable facts, accepted decisions, constraints, corrections,
        preferences, open questions, next actions, patterns, and artifact references.
        The project is bound by the runtime and cannot be changed by tool arguments.

        中文说明: 检索当前项目的证据型长期记忆 (atomic memory)。

        Args:
            query: 检索关键词; 由前台 Agent 的 LLM 在 tool call 中生成。
            categories/tags: 可选过滤条件; 由 LLM 按需传入。
            limit: 返回条数上限, 默认 10; 由 LLM 指定。

        Returns:
            JSON str (status/space/project/results); 由 langchain 框架
            作为 tool message 回传给前台 Agent 的 LLM, 用于组织回答。
        """
        results = search_memories(
            space=space,
            project=project,
            query=query,
            categories=categories,
            tags=tags,
            limit=limit,
        )
        return json.dumps(
            {"status": "ok", "space": space, "project": project, "results": results},
            ensure_ascii=False,
            indent=2,
        )

    return search_long_term_memory


def create_conversation_history_search_tool(space: str, project: str):
    """Bind detailed session-history lookup to the current space and project.

    中文说明: 工厂函数, 生成绑定当前 space/project 的
    `search_conversation_history` tool (检索历史 compact 会话细节)。

    Args:
        space/project: 绑定的记忆空间与项目; 由 cleo/agents/cleo.py
            Agent.__init__ 传入 (源自 CLI 当前 space/project)。

    Returns:
        langchain `@tool` 包装的 tool 对象; 放入 Agent.toolist 后由
        deepagents 框架按 LLM tool call 调用。
    """

    @tool("search_conversation_history")
    def search_project_conversation_history(
        query: str,
        session_ids: list[str] | None = None,
        top_k: int = 5,
    ) -> str:
        """Search prior compact conversations in the current project.

        Use this for details that may not belong in long-term memory: what was
        discussed, how a choice was reached, or why an alternative was rejected.
        Results are source-hash checked against current compact projections.

        中文说明: 检索当前项目历史会话的 compact 记录 (讨论过程与细节)。

        Args:
            query: 检索问题; 由前台 Agent 的 LLM 在 tool call 中生成。
            session_ids: 可选, 限定检索的 session 范围; 由 LLM 传入。
            top_k: 返回结果数, 默认 5; 由 LLM 指定。

        Returns:
            JSON str (status/retrieval/results 等); 由 langchain 框架
            回传给前台 Agent 的 LLM, 用于组织回答。
        """
        results = search_conversation_history(
            space=space,
            project=project,
            query=query,
            session_ids=session_ids,
            top_k=top_k,
        )
        return json.dumps(
            {
                "status": "ok",
                "space": space,
                "project": project,
                "retrieval": "local_lexical_v2",
                "results": results,
            },
            ensure_ascii=False,
            indent=2,
        )

    return search_project_conversation_history
