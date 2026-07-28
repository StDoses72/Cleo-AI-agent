"""前台交互 Agent:Cleo 主对话代理,基于 deepagents 构建。

组装 shell/codex/memory 工具与 system prompt, 通过 `Agent.stream_text`
向 CLI 层(cleo/cli/chat.py)流式输出文本增量。
"""

from collections.abc import AsyncIterator, Mapping
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain.chat_models import init_chat_model
from langgraph.checkpoint.memory import InMemorySaver

from cleo.agents.tools.codex_tools import codex_reply_tool, codex_tool
from cleo.agents.tools.memory_tools import (
    create_conversation_history_search_tool,
    create_project_memory_search_tool,
)
from cleo.agents.tools.shell_tools import run_shell_command
from cleo.config.settings import settings
from cleo.memory.paths import DEFAULT_MEMORY_SPACE
from cleo.runtime.usage import ContextWindowUsage

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

active_profile = settings.active_agent_profile


class Agent:
    """Cleo 前台对话 Agent,封装 deepagents 图与工具集。

    由 CLI 层实例化: cleo/cli/application.py:245、cleo/cli/chat.py:237/282/343,
    以及 tests/agents/test_cleo.py。实例属性 `context_usage` 被
    cleo/cli/chat.py:38/73 读取用于渲染 token 用量。
    """

    def __init__(
        self,
        system_prompt: str = SYSTEM_PROMPT,
        project: str = "general",
        space: str = DEFAULT_MEMORY_SPACE,
    ) -> None:
        """初始化模型、backend、工具列表与 deepagent 图。

        Args:
            system_prompt: 系统提示词; 调用方目前均使用默认值 SYSTEM_PROMPT
                (本文件顶部定义), 仅在测试中可能被替换。
            project: 绑定的项目名; 来自 CLI 的 `/project` 选择
                (chat.py/application.py), 用于绑定 memory 检索工具。
            space: 记忆空间名; 来自 CLI runtime 的当前 space,
                默认 DEFAULT_MEMORY_SPACE。
        """
        self.root_dir = settings.active_directory_profile.root_path
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
        self.tool_list = [
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
            tools=self.tool_list,
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
        """以 async generator 形式流式产出 Agent 回复的文本增量。

        底层调用 `deepagent.astream(..., stream_mode="messages")`,
        逐 chunk 提取 AIMessageChunk 的文本并 yield。

        Args:
            message: 用户本轮输入文本; 来自 CLI 输入框
                (cleo/cli/application.py -> chat.py)。
            thread_id: 会话 thread ID, 作为 langgraph checkpointer 的
                thread_id; 由 chat.py 的当前 thread 传入, 默认 "local"。
            loaded_info: 恢复的历史消息列表; 由 chat.py:57/453
                (restored/loaded messages) 传入, None 表示新会话。
            images: 图片附件列表, 每项含 name/base64/mime_type;
                由 chat.py:66/454 的 attachment_list 传入。

        Yields:
            文本增量 str; 由 cleo/cli/chat.py:62-69 消费,
            经 `cli.stream_assistant(text)` 实时渲染到终端。
        """
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
        """从流式 chunk 中提取 token usage 并累计到 `self.context_usage`。

        由 `stream_text` 在每个 chunk 上调用 (本文件)。兼容两种 metadata
        结构: langchain 的 `usage_metadata` 与部分 provider 放在
        `response_metadata.token_usage` 中的 usage。

        Args:
            chunk: `deepagent.astream(stream_mode="messages")` 产出的单项,
                可能是 (message, metadata) tuple 或 message 本身。

        Returns:
            None; 副作用为更新 `self.context_usage`, 最终由 CLI
            (chat.py) 读取并渲染 token 用量。
        """
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
    """构造发给模型的 user message content, 支持多模态图片附件。

    仅被 `Agent.stream_text` 调用 (本文件)。

    Args:
        message: 用户文本; 来自 `stream_text` 的同名参数。
        images: 图片附件 dict 列表 (name/base64/mime_type);
            来自 `stream_text` 的 images 参数 (CLI 附件)。

    Returns:
        无图片时返回纯文本 str; 有图片时返回 OpenAI 风格的 content block
        list, 供 `deepagent.astream` 的 messages 使用。
    """
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
    """从流式 chunk 中提取 AIMessageChunk 的文本增量。

    仅被 `Agent.stream_text` 调用 (本文件)。非 AI 消息 (如 tool
    message) 返回空串, 避免工具输出混入助手文本流。

    Args:
        chunk: `astream(stream_mode="messages")` 的产出项, 可能是
            (message, metadata) tuple 或 message 本身。

    Returns:
        文本增量 str (可能为空串); 由 `stream_text` 过滤后 yield 给 CLI。
    """
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
    """按候选 key 顺序从 usage mapping 中取第一个 int 值。

    仅被 `Agent._capture_usage` 调用 (本文件), 用于兼容不同 provider
    的 token 字段命名 (如 input_tokens vs prompt_tokens)。

    Args:
        usage: token usage mapping (usage_metadata 或 token_usage)。
        *keys: 按优先级排列的候选字段名。

    Returns:
        命中的 int 值; 全部缺失或类型不符时返回 None, 由调用方跳过累计。
    """
    for key in keys:
        value = usage.get(key)
        if isinstance(value, int):
            return value
    return None
