"""Create a disposable desktop test page before the real VNC browser smoke test."""

import asyncio
import base64
import json
import os
from pathlib import Path

from cleo.computer_desktop.runtime import desktop_action, docker, identity, invoke

root = Path(os.environ["CLEO_SMOKE_OUTPUT"]).resolve()
root.mkdir(parents=True, exist_ok=True)
config = root / "computer-use.json"


async def main():
    """Purpose: Exercise real guest tools. Input: output env. Output: fixture and connection."""
    await desktop_action(config, "release")
    await desktop_action(config, "start")
    marker = "/home/cleo/.cleo-test-persistence"
    docker("exec", identity(config), "touch", marker)
    await desktop_action(config, "stop")
    assert (await desktop_action(config, "start"))["phase"] == "ready"
    docker("exec", identity(config), "test", "-f", marker)
    docker("exec", identity(config), "xdpyinfo")
    # A responsive HTTP endpoint alone does not prove the restarted X server works.
    assert any(b["type"] == "image" for b in await invoke(config, "Snapshot", {}))
    print("DESKTOP_RESTART_AND_HOME_PERSISTENCE_PASSED")
    await invoke(config, "App", {"name": "browser"})
    await invoke(config, "Wait", {"seconds": 2})
    await invoke(config, "Shortcut", {"keys": "ctrl+l"})
    html = """<!doctype html><html><head><title>Cleo desktop test</title></head>
<body style="background:#163038;color:white;font:24px sans-serif;margin:40px">
<h1>Cleo independent desktop</h1><p>Manual login test</p>
<input autofocus style="font:24px sans-serif;width:450px;padding:10px"
placeholder="Type here" oninput="document.title='Cleo input: '+this.value"></body></html>"""

    url = "data:text/html;base64," + base64.b64encode(html.encode()).decode()
    await invoke(config, "Type", {"text": url})
    await invoke(config, "Shortcut", {"keys": "Return"})
    await invoke(config, "Wait", {"seconds": 2})
    blocks = await invoke(config, "Snapshot", {})
    assert "Cleo desktop test" in blocks[0]["text"], "Browser did not open the test page"
    for b in blocks:
        if b["type"] == "image":
            (root / "guest-desktop.png").write_bytes(base64.b64decode(b["base64"]))
        else:
            print(b["text"])
    (root / "connection.json").write_text(
        json.dumps(await desktop_action(config)), encoding="utf-8"
    )
    print("REAL_GUEST_BROWSER_READY")


asyncio.run(main())
