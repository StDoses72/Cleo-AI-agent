from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import InMemorySaver

from config.settings import settings
from core.memory.compaction import load_validated_compact
from core.memory.paths import DEFAULT_MEMORY_SPACE
from core.memory.state import (
    get_session_source,
    mark_consolidation_failed,
    mark_consolidation_started,
    needs_consolidation,
)
from core.usage import ContextWindowUsage
from tools.codex_tools import codex_reply_tool, codex_tool
from tools.dream_agent_tools import (
    complete_memory_consolidation,
    list_all_project_names,
    list_all_session_ids,
    read_compact_memory,
    read_project_memory,
    remember_durable_knowledge,
    write_memory_to_markdown,
)
from tools.memory_tools import (
    create_conversation_history_search_tool,
    create_project_memory_search_tool,
)
from tools.shell_tools import run_shell_command

SYSTEM_PROMPT = """
You are Cleo, a personal AI assistant.

Your job is to help the user think clearly, plan calmly, and get practical
work done. Be warm, direct, and useful. Adapt to the user's language and tone,
ask only the questions needed to avoid risky assumptions, and otherwise move
the task forward with reasonable judgment.

Core behavior:
- Treat the user's latest message as the highest-priority instruction.
- Prefer concrete next steps, concise explanations, and finished artifacts.
- Separate verified facts from assumptions, guesses, and recommendations.
- When you need project context, inspect the available files before making
  claims about them.
- When you are unsure, say what is uncertain and offer a useful way to verify it.
- Keep private or sensitive information out of generated memory and artifacts.
- Be a helpful generalist. If a request falls outside available skills or local
  context, answer from general model knowledge and clearly state that limitation.
- Do not pretend to have completed actions you have not performed.

Long-term project memory is stored in
`memory/<space>/projects/<project_name>/`.
It is not automatically injected into your prompt. When a task depends on
project history, user preferences, previous decisions, unresolved questions,
or prior artifacts, inspect the project memory yourself before answering.
Useful locations include:
- `/memory/<space>/projects/<project_name>/MEMORY.md` for concise context.
- `/memory/<space>/projects/<project_name>/decisions.md` for decisions.
- `/memory/<space>/projects/<project_name>/open_questions.md` for open items.
- `/memory/<space>/projects/<project_name>/artifacts.md` for artifacts.

If the current project is unclear, inspect the active space's `projects/`
directory or ask the user which project to use. Treat project memory as
reference material: prefer the user's latest message and verified file/tool
evidence when they conflict with memory.

Two project-bound retrieval tools are available:
- `search_long_term_memory` finds stable, evidence-backed facts and decisions.
- `search_conversation_history` finds details from earlier compact threads.
Use the first for durable knowledge and the second for how or why something was
discussed. Do not treat either source as stronger than the user's latest message
or current files.

You have a local `run_shell_command` tool for shell commands, scripts, and
diagnostics. Use it when shell access helps complete the user's task, and
prefer clear, targeted commands over broad or noisy command sequences.
Avoid credential exposure and destructive filesystem changes unless the user
explicitly asks for them and the intent is clear.

The tool starts in the configured project root by default, but it can run in
other working directories when needed. User-provided input files may be Windows
absolute paths; pass those paths exactly as provided when a script needs them.
Do not rewrite Windows paths to `/workspace`.
""".strip()

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


class Agent:
    def __init__(
        self,
        system_prompt: str = SYSTEM_PROMPT,
        project: str = "general",
        space: str = DEFAULT_MEMORY_SPACE,
    ) -> None:
        self.root_dir = Path(__file__).resolve().parent.parent
        self.project = project
        self.space = space
        self.model_name = active_profile.model
        self.context_usage = ContextWindowUsage(
            window_tokens=active_profile.max_tokens,
        )
        self.backend = FilesystemBackend(
            root_dir=str(self.root_dir),
            virtual_mode=True,
        )
        self.toolist = [
            run_shell_command,
            codex_tool,
            codex_reply_tool,
            create_project_memory_search_tool(space, project),
            create_conversation_history_search_tool(space, project),
        ]
        self.deepagent = create_deep_agent(
            model=init_chat_model(
                model=active_profile.model,
                model_provider=active_profile.provider,
                api_key=active_profile.api_key.get_secret_value(),
                temperature=active_profile.temperature,
                base_url=active_profile.base_url,
            ),
            checkpointer=InMemorySaver(),
            system_prompt=system_prompt,
            tools=self.toolist,
            interrupt_on=None,
            backend=self.backend,
            skills=["/skills"],
            memory=["/memory/MEMORY_POLICY.md"],
        )

    async def stream_text(
        self,
        message: str,
        thread_id: str = "local",
        loaded_info: list | None = None,
        images: list[dict[str, str]] | None = None,
    ) -> AsyncIterator[str]:
        image_inputs = list(images or [])

        user_message = {
            "role": "user",
            "content": _build_user_content(message, image_inputs),
        }
        messages = [user_message] if loaded_info is None else [*loaded_info, user_message]

        async for chunk in self.deepagent.astream(
            {"messages": messages},
            config={"configurable": {"thread_id": thread_id}},
            stream_mode="messages",
        ):
            self._capture_usage(chunk)
            text = _extract_text_delta(chunk)
            if text:
                yield text

    def _capture_usage(self, chunk: Any) -> None:
        message = chunk[0] if isinstance(chunk, tuple) and chunk else chunk
        usage = getattr(message, "usage_metadata", None)
        if not isinstance(usage, Mapping):
            response_metadata = getattr(message, "response_metadata", None)
            token_usage = (
                response_metadata.get("token_usage")
                if isinstance(response_metadata, Mapping)
                else None
            )
            usage = token_usage if isinstance(token_usage, Mapping) else None
        if not usage:
            return

        input_tokens = _usage_int(usage, "input_tokens", "prompt_tokens")
        output_tokens = _usage_int(usage, "output_tokens", "completion_tokens")
        total_tokens = _usage_int(usage, "total_tokens")
        if total_tokens is None and (input_tokens is not None or output_tokens is not None):
            total_tokens = (input_tokens or 0) + (output_tokens or 0)
        self.context_usage.update(
            used_tokens=total_tokens,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )


def _build_user_content(message: str, images: list[dict[str, str]]) -> str | list[dict[str, str]]:
    if not images:
        return message

    content: list[dict[str, str]] = [{"type": "text", "text": message}]
    for index, image in enumerate(images, start=1):
        name = image.get("name") or f"image-{index}"
        content.append({"type": "text", "text": f"Image {index}: {name}"})
        content.append(
            {
                "type": "image",
                "base64": image["base64"],
                "mime_type": image.get("mime_type", "image/jpeg"),
            }
        )
    return content


def _extract_text_delta(chunk: Any) -> str:
    message = chunk[0] if isinstance(chunk, tuple) and chunk else chunk
    if getattr(message, "type", None) != "AIMessageChunk":
        return ""

    content = getattr(message, "content", "")
    if isinstance(content, str) and content:
        return content

    parts: list[str] = []
    blocks = content if isinstance(content, list) else getattr(message, "content_blocks", [])
    for block in blocks:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and block.get("type") in {"text", "text_delta"}:
            parts.append(str(block.get("text", "")))
    return "".join(parts)


def _usage_int(usage: Mapping[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, int):
            return value
    return None


class DreamAgent:
    # This remains a small background agent for memory consolidation.
    def __init__(self, system_prompt: str = DREAM_AGENT_SYSTEM_PROMPT) -> None:
        self.root_dir = Path(__file__).resolve().parent.parent
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
