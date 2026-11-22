"""Time a fixed desktop flow on the real local-computer controller, before and after #160.

The flow is the representative one from issue #160 without a model in the loop: screenshot,
launch Notepad through Start search, look again, type Chinese text, select it, scroll, then
clear it and close Notepad. ``--launch legacy`` replays the pre-#160 launch (fixed 0.8 s and
1.0 s pauses, return before the window exists, so an agent then waits and looks again);
``--launch current`` uses the controller as shipped. Each step's wall time is printed as JSON,
with the extra wait-and-look round trip that a legacy launch costs an agent counted separately.

This sends REAL mouse and keyboard input. Run it only on an idle desktop you are not using:

    python scripts/bench_desktop_computer.py --launch legacy --runs 3
    python scripts/bench_desktop_computer.py --launch current --runs 3
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time

from cleo.computer import host as host_module
from cleo.computer.host import MODIFIER_VK, HostController

TEXT = "会议记录\n三种电脑操作模式按 #160 推进"


def legacy_launch(self: HostController, args: dict):
    """The pre-#160 launch: fixed pauses, returning before the app window is known."""
    name = args["name"].strip()
    self._press_combo([MODIFIER_VK["win"]], None)
    self._sleep(0.8)
    self._checkpoint()
    self._type_text(name)
    self._sleep(1.0)
    self._checkpoint()
    self._press_combo([], 0x0D)
    return "legacy"


async def flow(controller: HostController, app: str, legacy: bool) -> list[dict]:
    steps: list[dict] = []

    async def step(label: str, op: str, **args):
        started = time.perf_counter()
        result = await controller.run(op, args)
        steps.append({"step": label, "seconds": round(time.perf_counter() - started, 3)})
        if result.get("user_activity"):
            raise SystemExit(
                "User input detected; the run was abandoned. Leave the mouse and keyboard alone."
            )
        return result

    shot = await step("screenshot", "screenshot")
    await step("launch", "launch", name=app, signature=shot["signature"])
    if legacy:
        # Without the window in hand an agent waits for the app and looks again.
        started = time.perf_counter()
        await asyncio.sleep(1.0)
        await controller.run("screenshot", {})
        steps.append({"step": "agent wait + screenshot (legacy only)",
                      "seconds": round(time.perf_counter() - started, 3)})
    shot = await step("screenshot after launch", "screenshot")
    sign = {"signature": shot["signature"]}
    await step("type Chinese text", "type", text=TEXT, **sign)
    await step("select all", "key", keys="ctrl+a", **sign)
    middle = (shot["width"] // 2, shot["height"] // 2)
    transform = shot["transform"]
    x = round(transform["x"] + middle[0] * transform["sx"])
    y = round(transform["y"] + middle[1] * transform["sy"])
    await step("scroll", "scroll", x=x, y=y, direction="down", amount=2, **sign)
    await step("clear text", "key", keys="delete", **sign)
    await step("close app", "key", keys="alt+f4", **sign)
    return steps


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--launch", choices=["legacy", "current"], required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--app", default="Notepad")
    args = parser.parse_args()
    if sys.platform != "win32":
        raise SystemExit("The local-computer controller supports Windows only.")
    controller = host_module.controller()
    if args.launch == "legacy":
        HostController._launch = legacy_launch
    runs = []
    for _ in range(args.runs):
        runs.append(asyncio.run(flow(controller, args.app, args.launch == "legacy")))
        time.sleep(1.5)
    totals = [sum(item["seconds"] for item in run) for run in runs]
    labels = [item["step"] for item in runs[0]]
    median = {label: statistics.median(run[index]["seconds"] for run in runs)
              for index, label in enumerate(labels)}
    print(json.dumps({"launch": args.launch, "runs": args.runs,
                      "median_total_seconds": round(statistics.median(totals), 3),
                      "median_step_seconds": median}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
