from collections.abc import Iterator
from pathlib import Path
from typing import Any
import json

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langchain.chat_models import init_chat_model

from langchain.agents import create_agent

from config.settings import settings
from tools.shell_tools import run_shell_command
from tools.dream_agent_tools import read_memory_from_json, list_all_thread_ids, list_all_project_names, read_project_memory, write_memory_to_markdown


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

Long-term project memory is stored in `memory/projects/<project_name>/`.
It is not automatically injected into your prompt. When a task depends on
project history, user preferences, previous decisions, unresolved questions,
or prior artifacts, inspect the project memory yourself before answering.
Useful locations include:
- `/memory/projects/<project_name>/AGENT.md` for concise project context.
- `/memory/projects/<project_name>/decisions.md` for accepted decisions.
- `/memory/projects/<project_name>/open_questions.md` for unresolved items.
- `/memory/projects/<project_name>/artifacts.md` for important generated files.
- `/memory/projects/<project_name>/dreams/` for memory consolidation proposals.

If the current project is unclear, inspect `/memory/projects/` to see available
project names or ask the user which project to use. Treat project memory as
reference material: prefer the user's latest message and verified file/tool
evidence when they conflict with memory.

You have a restricted `run_shell_command` tool for project-local scripts.
Use it only when a skill or user task requires script execution. Prefer
specific project scripts over ad hoc commands, and never use it for secrets,
credentials, destructive filesystem changes, or commands outside the project
sandbox.

The shell sandbox constrains the command working directory to this project.
It does not mean user-provided input files must live in the virtual
filesystem. When a trusted project script asks for an input file, pass the
user's Windows absolute path exactly as provided. 
Do not rewrite Windows paths to `/workspace`.
""".strip()

DREAM_AGENT_SYSTEM_PROMPT = """
You are Cleo DreamAgent, a background memory consolidation agent.

Your job is to read short-term conversation records and convert them into durable project memory.
You do not answer the user directly, what you get are mostly pre-setted prompt rather than actual human user input.
You do not continue the conversation, what you do is to call the tools given to you to save the memory into files for future retrieval, 
and propose updates to the long-term memory based on the new information you get. 
You only extract, organize, and propose memory updates.

Core principles:
- Preserve facts, decisions, constraints, user preferences, corrections, open questions, and next actions.
- Prefer durable project knowledge over conversational chatter.
- Do not store vague praise, greetings, temporary wording, or low-value back-and-forth.
- Do not invent facts. If something is uncertain, mark it as uncertain.
- Separate observed facts from inferred conclusions.
- Keep project memory concise, inspectable, and useful for future agents.
- Treat user corrections as high-priority memory.
- Treat implementation decisions as durable only when the user accepted them or the codebase already reflects them.
""".strip()


with open(settings.PROFILE_DIR, "r", encoding="utf-8") as f:
    profile_data = json.load(f)

active_profile_name = profile_data.get("active_profiles")

if not active_profile_name:
    raise ValueError("No active profile specified in the configuration.")

actiev_profile = profile_data["profiles"].get(active_profile_name)

if not actiev_profile:
    raise ValueError(f"Active profile '{active_profile_name}' not found in the configuration.")


class Agent:
    def __init__(self, system_prompt: str = SYSTEM_PROMPT) -> None:
        self.root_dir = Path(__file__).resolve().parent.parent
        self.backend = FilesystemBackend(
            root_dir=str(self.root_dir),
            virtual_mode=True,
        )
        self.toolist = [run_shell_command]
        interrupt_on = (
            {"run_shell_command": True}
            if settings.SHELL_REQUIRE_APPROVAL
            else None
        )
        self.deepagent = create_deep_agent(
            model=init_chat_model(
                model=actiev_profile["model"],
                model_provider=actiev_profile["provider"],
                api_key=actiev_profile["api_key"],
                temperature=actiev_profile["temperature"],
                base_url=actiev_profile.get("base_url", None),
            ),
            checkpointer=InMemorySaver(),
            system_prompt=system_prompt,
            tools=self.toolist,
            interrupt_on=interrupt_on,
            backend=self.backend,
            skills=["/skills"],
            memory=["/memory/AGENT.md"],
        )

    # The `invoke` method is not used in this implementation, but it can be defined for one-shot interactions if needed
    # or be used in the future for non-streaming responses.
    
    # def invoke(self, message: str, thread_id: str = "local") -> Any:
    #     return self.deepagent.invoke(
    #         {"messages": [{"role": "user", "content": message}]},
    #         config={"configurable": {"thread_id": thread_id}},
    #     )

    def stream_text(
        self,
        message: str,
        thread_id: str = "local",
        loaded_info: list | None = None,
        images: list[dict[str, str]] | None = None,
    ) -> Iterator[str]:
        image_inputs = list(images or [])

        user_message = {
            "role": "user",
            "content": _build_user_content(message, image_inputs),
        }
        messages = [user_message] if loaded_info is None else [*loaded_info, user_message]

        for chunk in self.deepagent.stream(
            {"messages": messages},
            config={"configurable": {"thread_id": thread_id}},
            stream_mode="messages",
        ):
            text = _extract_text_delta(chunk)
            if text:
                yield text


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


class DreamAgent: # This is an in-progress class for main agentic system's memory management, not yet integrated into the main workflow.
    def __init__(self,system_prompt: str = DREAM_AGENT_SYSTEM_PROMPT) -> None:
        self.root_dir = Path(__file__).resolve().parent.parent
        self.toolist = [read_memory_from_json, list_all_thread_ids, list_all_project_names, read_project_memory, write_memory_to_markdown]
        self.model = init_chat_model(
                model=actiev_profile["model"],
                model_provider=actiev_profile["provider"],
                api_key=actiev_profile["api_key"],
                temperature=actiev_profile["temperature"],
                base_url=actiev_profile.get("base_url", None),
            )
        self.system_prompt = system_prompt
        self.dreamagent = create_agent(model=self.model,tools=self.toolist,system_prompt=self.system_prompt)

    def invoke(self, thread_id: str, project: str = "general") -> Any:
        prompt = f"""
Consolidate the short-term thread memory into durable project memory.

Thread ID: {thread_id}
Project: {project}

Steps:
1. Use the available tools to read the saved thread messages for this thread.
2. Use the available tools to read existing project memory for this project.
3. Extract only durable information that will help future Cleo sessions.
4. Preserve important facts, decisions, user preferences, corrections, open questions, next actions, and artifact references.
5. Ignore greetings, repeated debugging noise, transient command output, and low-value conversational filler.
6. Do not invent facts. Mark uncertainty clearly when needed.
7. Write one formatted long-term project memory file using the memory writing tool.

The result should be concise, structured, and useful for future Cleo sessions.
""".strip()
        return self.dreamagent.invoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={"configurable": {"thread_id": thread_id}},
        )
        
        
        
