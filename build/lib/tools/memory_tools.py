"""Project-bound memory retrieval tools exposed to the interactive agent."""

from __future__ import annotations

import json

from langchain.tools import tool

from core.memory.store import search_conversation_history, search_memories


def create_project_memory_search_tool(space: str, project: str):
    """Bind durable-memory lookup to the current space and project."""

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
    """Bind detailed session-history lookup to the current space and project."""

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
