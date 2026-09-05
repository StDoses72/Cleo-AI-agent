"""Expose the same cross-space reader used by productivity's MCP server."""

from pathlib import Path

from langchain.tools import tool

from cleo.memory.reader import TOOL_NAMES, MemoryReader


def create_memory_tools(memory_root: str | Path, index_path: str | Path | None = None):
    reader = MemoryReader(memory_root, index_path)
    return [tool(name)(getattr(reader, name)) for name in TOOL_NAMES]
