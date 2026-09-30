"""Opt-in, read-only smoke of the local Windows controller: capture and geometry only.

Sends no mouse or keyboard input. Prints display geometry, the screenshot size and the
image-to-screen transform so multi-monitor and DPI setups can be checked by hand.
"""

import asyncio
import json

from cleo.computer.host import HostController


async def main():
    """Purpose: Verify capture on this machine. Input: Windows desktop. Output: geometry only."""
    host = HostController()
    report = []
    for display in [None, "all"]:
        shot = await host.run("screenshot", {"display": display})
        assert len(shot["image"]) > 1000, "No usable screenshot returned"
        report.append({"display": shot["display"], "image": [shot["width"], shot["height"]],
                       "transform": shot["transform"], "displays": shot["displays"],
                       "windows": len(shot["windows"])})
    print(json.dumps({"status": "passed", "captures": report}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
