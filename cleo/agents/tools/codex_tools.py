"""Codex 委派工具: 把编码任务交给 Codex harness 并等待完成。

通过 langchain `@tool` 注册到前台 Agent (cleo/agents/cleo.py 的
Agent.toolist), 由 deepagents 框架按 LLM 的 tool call 调用。
"""

from langchain.tools import tool

from cleo.config.settings import settings
from cleo.integrations import CodexAdapter

_adapter = CodexAdapter(
    default_model=settings.active_tools_profile.codex_model,
    project_root=settings.active_directory_profile.root_path,
)


@tool("codex")
async def codex_tool(
    prompt: str,
    project_path: str = ".",
    model: str | None = None,
) -> dict[str, str | None]:
    """Delegate a coding task to Codex and wait for the completed turn.

    Use an absolute project path when Codex should work outside Cleo's current
    directory. The returned thread_id can be passed to codex_reply.

    中文说明: 开启一个新的 Codex 编码会话 (thread) 并阻塞等待本轮完成。

    Args:
        prompt: 交给 Codex 的任务描述; 由 LLM (前台 Agent) 在 tool call
            中生成, 非用户直接传入。
        project_path: Codex 的工作目录; 由 LLM 指定, 默认 "." 即
            Cleo 当前项目根目录。
        model: 可选模型覆盖; 由 LLM 按需指定, 默认使用
            settings.active_tools_profile.codex_model。

    Returns:
        CodexResult.model_dump() dict (thread_id/turn_id/status/response/
        error); 由 langchain tool 框架序列化回 LLM 作为 tool message,
        其中 thread_id 供后续 `codex_reply` 复用。
    """
    return (await _adapter.start(prompt, project_path, model)).model_dump()


@tool("codex_reply")
async def codex_reply_tool(
    thread_id: str,
    prompt: str,
    project_path: str = ".",
) -> dict[str, str | None]:
    """Continue an existing Codex thread and wait for the completed turn.

    中文说明: 在已有 Codex thread 上追加一轮对话 (多轮编码交互)。

    Args:
        thread_id: 目标 Codex thread ID; 由 LLM 从先前 `codex` 工具的
            返回值中获取并传入。
        prompt: 追加的指令内容; 由 LLM 在 tool call 中生成。
        project_path: 工作目录; 由 LLM 指定, 默认 "."。

    Returns:
        CodexResult.model_dump() dict; 由 langchain 框架作为 tool
        message 回传给 LLM, 供其组织最终回复。
    """
    return (await _adapter.reply(thread_id, prompt, project_path)).model_dump()
