"""Background agent responsible for durable memory consolidation."""

from pathlib import Path
from typing import Any

from langchain.agents import create_agent
from langchain.chat_models import init_chat_model

from cleo.agents.tools.dream_agent_tools import (
    complete_memory_consolidation,
    list_all_project_names,
    list_all_session_ids,
    read_compact_memory,
    read_project_memory,
    remember_durable_knowledge,
    write_memory_to_markdown,
)
from cleo.config.settings import settings
from cleo.memory.compaction import load_validated_compact
from cleo.memory.paths import DEFAULT_MEMORY_SPACE
from cleo.memory.state import (
    get_session_source,
    mark_consolidation_failed,
    mark_consolidation_started,
    needs_consolidation,
)

DREAM_AGENT_SYSTEM_PROMPT = """
You are Cleo DreamAgent, a background memory consolidation agent.

Your job is to read short-term conversation records and convert them into durable
project memory.
You do not answer the user directly. What you get is mostly a preset prompt
rather than actual human user input.
You do not continue the conversation. You call the tools given to you to save
memory into files for future retrieval, and propose updates to long-term memory
based on the new information you get.
You only extract, organize, and propose memory updates.

Core principles:
- Preserve facts, decisions, constraints, user preferences, corrections, open
  questions, and next actions.
- Prefer durable project knowledge over conversational chatter.
- Do not store vague praise, greetings, temporary wording, or low-value back-and-forth.
- Do not invent facts. If something is uncertain, mark it as uncertain.
- Separate observed facts from inferred conclusions.
- Keep project memory concise, inspectable, and useful for future agents.
- Treat user corrections as high-priority memory.
- Treat implementation decisions as durable only when the user accepted them or
  the codebase already reflects them.
- Every atomic memory must cite event IDs from the validated compact source.
- Never bypass the compact source by reading the raw session event log.
- Memory stays inside the exact space and project named by the request.
- A run is successful only after project Markdown is written and the explicit
  completion tool accepts the source hash.
""".strip()

active_profile = settings.active_agent_profile


class DreamAgent:
    """Consolidate validated session projections into project memory."""

    def __init__(self, system_prompt: str = DREAM_AGENT_SYSTEM_PROMPT) -> None:
        self.root_dir = Path(__file__).resolve().parents[2]
        self.toolist = [
            read_compact_memory,
            list_all_session_ids,
            list_all_project_names,
            read_project_memory,
            remember_durable_knowledge,
            write_memory_to_markdown,
            complete_memory_consolidation,
        ]
        self.model = init_chat_model(
            model=active_profile.model,
            model_provider=active_profile.provider,
            api_key=active_profile.api_key.get_secret_value(),
            temperature=active_profile.temperature,
            base_url=active_profile.base_url,
        )
        self.system_prompt = system_prompt
        self.dreamagent = create_agent(
            model=self.model,
            tools=self.toolist,
            system_prompt=self.system_prompt,
        )

    async def invoke(
        self,
        session_id: str,
        project: str = "general",
        space: str = DEFAULT_MEMORY_SPACE,
    ) -> Any:
        payload = load_validated_compact(
            memory_root=settings.MEMORY_DIR,
            space=space,
            project=project,
            session_id=session_id,
        )
        source_hash = str((payload.get("source") or {}).get("source_content_hash") or "")
        if not needs_consolidation(space, project, session_id, source_hash):
            return {
                "status": "skipped",
                "reason": "session event source is already consolidated",
                "source_hash": source_hash,
            }
        mark_consolidation_started(space, project, session_id, source_hash)
        focus = (
            "Extract user preferences, goals, relationships, corrections, plans, and durable facts."
            if space == "non_productivity"
            else (
                "Extract task intent, technical decisions, changed files, tests, "
                "errors, artifacts, and unfinished work."
            )
        )
        prompt = f"""
Consolidate the short-term session memory into durable project memory.

Space: {space}
Project: {project}
Session ID: {session_id}
Source Hash: {source_hash}
Space-specific focus: {focus}

Steps:
1. Read validated compact memory for this exact space, project, and session. Do
   not read or request the raw event log.
2. Read existing project memory from the same space and project.
3. Extract only durable information that will help future Cleo sessions. For
   each atomic item, call remember_durable_knowledge with this exact source hash
   and evidence event IDs that occur in the compact source.
4. Preserve accepted facts, decisions, constraints, user preferences,
   corrections, open questions, next actions, and artifact references.
5. Ignore greetings, repeated debugging noise, transient command output, and
   low-value conversational filler.
6. Do not invent facts. Mark uncertainty clearly when needed.
7. Write the formatted project memory file with this exact source hash. Preserve
   existing durable context when producing its narrative sections.
8. Finish by calling complete_memory_consolidation. Report the number of atomic
   memories backed by this source (including idempotent retry results); if it is
   zero, give a concrete no-op reason.

The result should be concise, structured, and useful for future Cleo sessions.
""".strip()
        try:
            result = await self.dreamagent.ainvoke(
                {"messages": [{"role": "user", "content": prompt}]},
                config={"configurable": {"thread_id": session_id}},
            )
            source_state = get_session_source(space, project, session_id)
            if source_state is None or source_state.get("consolidated_hash") != source_hash:
                raise RuntimeError(
                    "DreamAgent returned without completing the memory consolidation protocol"
                )
            return result
        except Exception as exc:
            mark_consolidation_failed(space, project, session_id, source_hash, str(exc))
            raise
