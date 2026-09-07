"""Expose Cleo's existing tools to official subscription runtimes over stdio."""

import argparse
import asyncio
import json
from pathlib import Path

from fastmcp import FastMCP
from fastmcp.tools import Tool, ToolResult
from langchain_core.tools import BaseTool
from pydantic import Field


def agent_tools(mode: str, project_path: str):
    if mode == "dream":
        from cleo.agents.tools import dream_agent_tools as dream

        return [
            dream.read_compact_memory,
            dream.read_project_memory,
            dream.read_global_persona,
            dream.remember_durable_knowledge,
            dream.remember_global_persona_trait,
            dream.write_memory_to_markdown,
            dream.complete_memory_consolidation,
        ]
    from langchain_core.tools import tool

    from cleo.agents.cleo import chat_tools
    from cleo.config.settings import settings

    @tool
    def read_file(path: str) -> str:
        """Read UTF-8 text in the project, or /.cleo/ for Cleo guidance and skills."""
        if path.startswith("/.cleo/"):
            root = settings.active_directory_profile.root_path.resolve()
            relative = path[len("/.cleo/") :]
        else:
            root = Path(project_path).resolve()
            relative = path.lstrip("/")
        target = (root / relative).resolve()
        if not target.is_relative_to(root):
            raise ValueError("File is outside the selected root")
        return target.read_text(encoding="utf-8")

    return [*chat_tools(Path(project_path)), read_file]


class AgentTool(Tool):
    agent_tool: BaseTool = Field(exclude=True)
    mode: str = Field(exclude=True)
    scope: dict[str, str] = Field(exclude=True)

    async def run(self, arguments: dict) -> ToolResult:
        if self.mode == "dream":
            for key, value in self.scope.items():
                if key in arguments and arguments[key] != value:
                    raise ValueError(f"DreamAgent cannot change its {key}")
        item = self.agent_tool
        arguments = dict(arguments)
        if "runtime" in item.get_input_schema().model_fields:
            from langchain.tools import ToolRuntime

            arguments["runtime"] = ToolRuntime(
                state={},
                context=None,
                config={"configurable": {"thread_id": self.scope.get("session_id", "local")}},
                stream_writer=lambda _event: None,
                tool_call_id=None,
                store=None,
            )
        result = await item.ainvoke(arguments)
        return ToolResult(
            content=result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
        )


def create_server(mode: str, project_path: str, scope: dict[str, str]) -> FastMCP:
    server = FastMCP("cleo-tools")
    for item in agent_tools(mode, project_path):
        server.add_tool(AgentTool(
            name=item.name,
            description=item.description,
            parameters=item.tool_call_schema.model_json_schema(),
            agent_tool=item,
            mode=mode,
            scope=scope,
        ))
    return server


async def run(args) -> None:
    server = create_server(args.mode, args.project_path, json.loads(args.scope))
    await server.run_async(transport="stdio", show_banner=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["chat", "dream"], required=True)
    parser.add_argument("--project-path", required=True)
    parser.add_argument("--scope", default="{}")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
