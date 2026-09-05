"""Read-only memory tools; launched with an explicit Cleo root over stdio."""

import argparse

from fastmcp import FastMCP

from cleo.memory.reader import READING_INSTRUCTIONS, TOOL_NAMES, MemoryReader


def create_server(memory_root: str) -> FastMCP:
    reader = MemoryReader(memory_root)
    server = FastMCP("cleo-memory", instructions=READING_INSTRUCTIONS)
    for name in TOOL_NAMES:
        server.tool(
            name=name,
            annotations={"readOnlyHint": True, "openWorldHint": False},
        )(getattr(reader, name))
    return server


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--memory-root", required=True)
    args = parser.parse_args()
    create_server(args.memory_root).run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
