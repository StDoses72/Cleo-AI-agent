import asyncio
from openai_codex import Codex, Sandbox, AsyncCodex
from fastmcp import FastMCP
from langchain_mcp_adapters.client import MultiServerMCPClient


mcp = FastMCP("cleo-asynccodex")

@mcp.tool
async def codex(

):
    return

@mcp.tool
async def codex_reply():
    return

client = MultiServerMCPClient(
    {
        "codex": {
            "transport": "stdio",
            "command":"python",
            "args":[""],
        },
    }
)
