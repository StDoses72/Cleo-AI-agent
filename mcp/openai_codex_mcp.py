"""Expose the synchronous Codex SDK through a small stdio MCP server."""

from __future__ import annotations

import os
from pathlib import Path

from fastmcp import FastMCP
from openai_codex import ApprovalMode, Codex, Sandbox, TurnResult

mcp = FastMCP("cleo-codex")


def _required_text(value: str, field_name: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError(f"{field_name} cannot be empty")
    return value


def _project_directory(project_path: str) -> str:
    path = Path(project_path).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"Project directory does not exist: {path}")
    return os.path.normcase(str(path))


def _response(thread_id: str, result: TurnResult) -> dict[str, str | None]:
    return {
        "thread_id": thread_id,
        "turn_id": result.id,
        "status": result.status.value,
        "response": result.final_response,
        "error": result.error.message if result.error is not None else None,
    }


@mcp.tool(name="codex")
def codex(
    prompt: str,
    project_path: str,
    model: str | None = None,
) -> dict[str, str | None]:
    """Run a complete Codex turn in a new thread and return its final result."""
    prompt = _required_text(prompt, "prompt")
    project_path = _project_directory(project_path)
    if model is not None:
        model = _required_text(model, "model")

    with Codex() as client:
        thread = client.thread_start(
            approval_mode=ApprovalMode.deny_all,
            cwd=project_path,
            model=model,
            sandbox=Sandbox.workspace_write,
        )
        result = thread.run(
            prompt,
            approval_mode=ApprovalMode.deny_all,
            cwd=project_path,
            sandbox=Sandbox.workspace_write,
        )

    return _response(thread.id, result)


@mcp.tool(name="codex-reply")
def codex_reply(
    thread_id: str,
    prompt: str,
    project_path: str,
) -> dict[str, str | None]:
    """Run a complete follow-up turn on an existing Codex thread."""
    thread_id = _required_text(thread_id, "thread_id")
    prompt = _required_text(prompt, "prompt")
    project_path = _project_directory(project_path)

    with Codex() as client:
        thread = client.thread_resume(
            thread_id,
            approval_mode=ApprovalMode.deny_all,
            cwd=project_path,
            sandbox=Sandbox.workspace_write,
        )
        result = thread.run(
            prompt,
            approval_mode=ApprovalMode.deny_all,
            cwd=project_path,
            sandbox=Sandbox.workspace_write,
        )

    return _response(thread.id, result)


def main() -> None:
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
