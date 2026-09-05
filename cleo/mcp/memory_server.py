"""Read-only memory tools; launched with an explicit Cleo root over stdio."""

import argparse

from fastmcp import FastMCP

from cleo.memory.reader import READING_INSTRUCTIONS, TOOL_NAMES, MemoryReader


def create_server(memory_root: str, index_path: str | None = None) -> FastMCP:
    reader = MemoryReader(memory_root, index_path)
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
    parser.add_argument("--session-index-path")
    args = parser.parse_args()
    create_server(args.memory_root, args.session_index_path).run(
        transport="stdio", show_banner=False,
    )


if __name__ == "__main__":
    main()
