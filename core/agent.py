from collections.abc import Iterator
from pathlib import Path
from typing import Any
import os

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver

from langchain.agents import create_agent

from config.settings import settings
from tools.shell_tools import run_shell_command
from tools.dream_agent_tools import read_memory_from_json, list_all_thread_ids, list_all_project_names, read_project_memory, write_memory_to_markdown


SYSTEM_PROMPT = """
You are AI4Casting, a casting-focused AI agent system built by 适创科技.

Your job is to help with casting process analysis, defect reasoning,
process planning, report drafting, supplier/manufacturing review, and
technical knowledge organization. Prefer grounded, inspectable work:
read the repository and available files before making claims, keep
assumptions explicit, and write reusable artifacts into the project
workspace when useful. When the user ask you for question that is not in your skills,
you need to claim that you are responding based on your training data and model builtin knowledge,
and suggest the user to ask a human expert for clarification or provide more context for better assistance.

When addressing with casting related tasks, follow these guidelines:
- First identify the casting process when possible: sand casting, die casting,
  investment casting, permanent mold, lost foam, centrifugal casting, or another
  process.
- Ask for or inspect available context before making a diagnosis:
  alloy, part geometry, wall thickness, gating/runner/riser design, mold material,
  pouring temperature, fill time, solidification behavior, heat treatment, and
  inspection results.
- Separate observed evidence from inferred causes.
- When multiple root causes are plausible, rank them and explain what evidence
  would confirm or reject each one.
- Prefer actionable recommendations that can be tested in production or simulation.

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
user's Windows absolute path exactly as provided, for example
`D:\\Supremium\\part.stl`. Do not rewrite Windows paths to `/workspace`.
""".strip()

DREAM_AGENT_SYSTEM_PROMPT = """
You are AI4Casting DreamAgent, a background memory consolidation agent.

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
            model=ChatOpenAI(
                model=settings.MODEL,
                temperature=0.2,
                api_key=settings.OPENAI_API_KEY,
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

    def stream_text(self, message: str, thread_id: str = "local", loaded_info:list|None = None) -> Iterator[str]:
        if loaded_info is None:
            for chunk in self.deepagent.stream(
                {"messages": [{"role": "user", "content": message}]},
                config={"configurable": {"thread_id": thread_id}},
                stream_mode="messages",
            ):
                text = _extract_text_delta(chunk)
                if text:
                    yield text
        else:
            for chunk in self.deepagent.stream(
                {"messages": [*loaded_info, {"role": "user", "content": message}]},
                config={"configurable": {"thread_id": thread_id}},
                stream_mode="messages",
            ):
                text = _extract_text_delta(chunk)
                if text:
                    yield text


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
        self.model = ChatOpenAI(
                model=settings.MODEL,
                temperature=0.2,
                api_key=settings.OPENAI_API_KEY,
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
3. Extract only durable information that will help future AI4Casting agents.
4. Preserve important facts, decisions, user preferences, corrections, open questions, next actions, and artifact references.
5. Ignore greetings, repeated debugging noise, transient command output, and low-value conversational filler.
6. Do not invent facts. Mark uncertainty clearly when needed.
7. Write one formatted long-term project memory file using the memory writing tool.

The result should be concise, structured, and useful for future AI4Casting sessions.
""".strip()
        return self.dreamagent.invoke(
            {"messages": [{"role": "user", "content": prompt}]},
            config={"configurable": {"thread_id": thread_id}},
        )
        
        
        
