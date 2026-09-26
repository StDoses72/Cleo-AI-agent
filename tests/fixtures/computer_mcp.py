"""Deterministic stdio desktop stand-in; never touches the real screen."""

from fastmcp import FastMCP
from fastmcp.tools import ToolResult
from mcp.types import ImageContent, TextContent

server = FastMCP("test-desktop")
observed = False


@server.tool()
def Snapshot() -> ToolResult:
    global observed
    observed = True
    return ToolResult(
        content=[
            TextContent(type="text", text="button label 7"),
            ImageContent(type="image", data="aW1hZ2U=", mimeType="image/png"),
        ]
    )


@server.tool()
def Click(label: int) -> str:
    if not observed or label != 7:
        raise ValueError("Snapshot was lost between calls")
    return "clicked label 7"


if __name__ == "__main__":
    server.run(show_banner=False)
