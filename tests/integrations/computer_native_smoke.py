"""Opt-in real Windows-MCP smoke: discover tools and take one read-only screenshot."""

import asyncio
import json
import tempfile
from pathlib import Path

from cleo.integrations.computer import close_connections, invoke


async def main():
    """Purpose: Verify installation and vision. Input: Windows desktop. Output: counts only."""
    with tempfile.TemporaryDirectory(prefix="cleo-computer-smoke-") as temporary:
        path = Path(temporary) / "computer-use.json"
        path.write_text(json.dumps({"runtime": "host", "timeout_seconds": 300}))
        try:
            tools = await invoke("smoke", path=path)
            names = [item["name"] for item in json.loads(tools[0]["text"])]
            assert "Snapshot" in names and "Click" in names, names
            snapshot = await invoke(
                "smoke", "Snapshot", {"use_vision": True, "use_ui_tree": False}, path
            )
            images = [block for block in snapshot if block["type"] == "image"]
            assert images and len(images[0]["base64"]) > 1000, "No usable screenshot returned"
            print(json.dumps({"tools": len(names), "images": len(images), "status": "passed"}))
        finally:
            await close_connections()


if __name__ == "__main__":
    asyncio.run(main())
