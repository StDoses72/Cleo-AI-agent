"""Expose the async Codex adapter through a stdio MCP server."""

from fastmcp import FastMCP

from config.settings import settings
from core.integrations import CodexAdapter

mcp = FastMCP("cleo-codex")
_adapter = CodexAdapter(
    default_model=settings.active_tools_profile.codex_model,
    project_root=settings.active_directory_profile.root_path,
)


@mcp.tool(name="codex")
async def codex(
    prompt: str,
    project_path: str = ".",
    model: str | None = None,
) -> dict[str, str | None]:
    """Run a complete Codex turn in a new thread and return its final result."""
    return (await _adapter.start(prompt, project_path, model)).model_dump()


@mcp.tool(name="codex-reply")
async def codex_reply(
    thread_id: str,
    prompt: str,
    project_path: str = ".",
) -> dict[str, str | None]:
    """Run a complete follow-up turn on an existing Codex thread."""
    return (await _adapter.reply(thread_id, prompt, project_path)).model_dump()


def main() -> None:
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
