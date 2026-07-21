from langchain.tools import tool

from config.settings import settings
from core.integrations import CodexAdapter

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
    """
    return (await _adapter.start(prompt, project_path, model)).model_dump()


@tool("codex_reply")
async def codex_reply_tool(
    thread_id: str,
    prompt: str,
    project_path: str = ".",
) -> dict[str, str | None]:
    """Continue an existing Codex thread and wait for the completed turn."""
    return (await _adapter.reply(thread_id, prompt, project_path)).model_dump()
