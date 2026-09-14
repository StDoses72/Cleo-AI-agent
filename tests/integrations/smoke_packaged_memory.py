"""Exercise the packaged memory MCP handshake without a model or user data."""
import argparse
import asyncio
import json
import subprocess
import tempfile
from pathlib import Path

from fastmcp import Client
from fastmcp.client.transports import StdioTransport


async def main():
    """Purpose: Verify packaged MCP starts from a source checkout.
    Input: Bundled Python executable on the command line.
    Output: Successful tool-list handshake, or the real child exception.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("python")
    args = parser.parse_args()
    executable = str(Path(args.python).resolve())
    with tempfile.TemporaryDirectory(prefix="cleo-memory-handshake-") as temporary:
        root = Path(temporary)
        cwd = root / "source"
        cwd.mkdir()
        generated = subprocess.run(
            [executable, "-I", "-c",
             "import json; from pathlib import Path; "
             "from cleo.integrations.harnesses.memory import MemoryMcp; "
             "print(json.dumps(MemoryMcp(Path('memory')).args))"],
            cwd=cwd, capture_output=True, text=True, check=True,
        )
        transport = StdioTransport(command=executable, args=json.loads(generated.stdout),
                                   cwd=str(cwd), keep_alive=False)
        async with asyncio.timeout(25):
            async with Client(transport) as client:
                tools = await client.list_tools()
                assert any(tool.name == "read_thread" for tool in tools)
        print("Packaged memory MCP handshake passed.")


if __name__ == "__main__":
    asyncio.run(main())
