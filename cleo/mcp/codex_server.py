"""Expose the async Codex adapter through a stdio MCP server."""

from fastmcp import FastMCP

from cleo.config.settings import settings
from cleo.integrations import CodexAdapter

mcp = FastMCP("cleo-codex")
_adapter = CodexAdapter(
    default_model=settings.active_tools_profile.codex_model,
    project_root=settings.active_directory_profile.root_path,
    memory_root=settings.MEMORY_DIR,
    session_index_path=settings.SESSION_INDEX_PATH,
)


@mcp.tool(name="codex")
async def codex(
    prompt: str,
    project_path: str = ".",
    model: str | None = None,
) -> dict[str, str | None]:
    """Run a complete Codex turn in a new thread and return its final result.

    由 fastmcp 框架注册为名为 ``codex`` 的 MCP tool; MCP client(如其他
    agent)通过 JSON-RPC ``tools/call`` 调用, 参数由 client 按 tool schema
    提供。
    参数:
        prompt: 交给 Codex 的任务描述, 由 MCP client 提供。
        project_path: Codex 工作目录, 由 MCP client 提供, 默认当前目录。
        model: 可选模型 id, 由 MCP client 提供。
    返回:
        ``CodexResult.model_dump()`` 字典(含 thread_id/status/response
        等), 由 fastmcp 序列化为 tool 响应回传给 MCP client; thread_id
        可传给 ``codex-reply`` 继续会话。
    """
    return (await _adapter.start(prompt, project_path, model)).model_dump()


@mcp.tool(name="codex-reply")
async def codex_reply(
    thread_id: str,
    prompt: str,
    project_path: str = ".",
) -> dict[str, str | None]:
    """Run a complete follow-up turn on an existing Codex thread.

    由 fastmcp 框架注册为名为 ``codex-reply`` 的 MCP tool; MCP client 通过
    JSON-RPC ``tools/call`` 调用。
    参数:
        thread_id: ``codex`` 工具上次返回的 thread_id, 由 MCP client 提供。
        prompt: 后续任务描述, 由 MCP client 提供。
        project_path: Codex 工作目录, 由 MCP client 提供。
    返回:
        ``CodexResult.model_dump()`` 字典, 由 fastmcp 序列化后回传给
        MCP client。
    """
    return (await _adapter.reply(thread_id, prompt, project_path)).model_dump()


def main() -> None:
    """以 stdio transport 启动 MCP server(阻塞运行)。

    作为 console script 入口 ``cleo-codex-mcp``(pyproject.toml)及
    ``python -m`` 直接执行的入口被调用; 无参数, 无返回值。
    """
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
