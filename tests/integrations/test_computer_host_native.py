"""Opt-in real local-desktop input test. It sends REAL mouse and keyboard input.

Enable with ``CLEO_TEST_HOST_INPUT=1`` only while nobody is using the computer. The test
refuses to start unless the user has been idle for 10 seconds, sends input only to a window it
creates, verifies the result from that window's own event log, and restores the cursor.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import textwrap
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or os.environ.get("CLEO_TEST_HOST_INPUT") != "1",
    reason="Sends real input; opt in with CLEO_TEST_HOST_INPUT=1 on an idle Windows desktop",
)

APP = textwrap.dedent("""
    import json, sys, tkinter as tk
    log_path, title = sys.argv[1], sys.argv[2]
    log = {"clicks": [], "text": "", "drag": None, "scroll": 0, "keys": []}
    def save():
        log["text"] = entry.get()
        open(log_path, "w", encoding="utf-8").write(json.dumps(log, ensure_ascii=False))
    root = tk.Tk()
    root.title(title)
    root.geometry("640x420+200+200")
    root.attributes("-topmost", True)
    entry = tk.Entry(root, font=("Microsoft YaHei", 14))
    entry.place(x=20, y=20, width=400, height=36)
    canvas = tk.Canvas(root, bg="#ff00ff", width=260, height=160)
    canvas.place(x=20, y=80)
    press = {}
    def pressed(event):
        press.update(x=event.x, y=event.y)
        log["clicks"].append([event.x, event.y])
        save()
    def released(event):
        log["drag"] = [press.get("x"), press.get("y"), event.x, event.y]
        save()
    def wheel(event):
        log["scroll"] += 1 if event.delta < 0 else -1
        save()
    def shortcut(_event):
        log["keys"].append("ctrl+b")
        save()
    canvas.bind("<ButtonPress-1>", pressed)
    canvas.bind("<ButtonRelease-1>", released)
    canvas.bind("<MouseWheel>", wheel)
    root.bind_all("<Control-KeyPress-b>", shortcut)
    entry.bind("<KeyRelease>", lambda e: save())
    root.after(200, save)
    root.mainloop()
""")


def idle_seconds() -> float:
    import ctypes

    class Info(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    info = Info()
    info.cbSize = ctypes.sizeof(info)
    ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info))
    return (ctypes.windll.kernel32.GetTickCount() - info.dwTime) / 1000


def test_real_input_reaches_only_the_test_window(tmp_path):
    import ctypes

    from cleo.computer.host import HostController

    if idle_seconds() < 10:
        pytest.skip("The computer is in use; real input tests run only on an idle desktop.")
    title = f"Cleo host input test {uuid.uuid4().hex[:6]}"
    log_path = tmp_path / "log.json"
    app = subprocess.Popen([sys.executable, "-c", APP, str(log_path), title])
    original = (ctypes.c_long * 2)()
    ctypes.windll.user32.GetCursorPos(original)
    host = HostController()

    def log():
        return json.loads(log_path.read_text(encoding="utf-8"))

    async def scenario():
        for _ in range(50):
            if log_path.exists():
                break
            await asyncio.sleep(0.1)
        await host.run("switch", {"name": title})
        shot = await host.run("screenshot", {})
        window = next(item for item in shot["windows"] if item["title"] == title)
        left, top, right, bottom = window["rect"]
        transform, common = shot["transform"], {"signature": shot["signature"]}

        def physical(x, y):
            return {
                "x": round(transform["x"] + x * transform["sx"]),
                "y": round(transform["y"] + y * transform["sy"]),
            }

        async def act(op, **args):
            result = await host.run(op, {**args, **common, "baseline": state["baseline"]})
            assert not result.get("user_activity"), "someone used the computer during the test"
            state["baseline"] = result["baseline"]

        state = {"baseline": shot["baseline"]}
        # Client-area offsets from the window's image rectangle (title bar ~ 32 px at 100%).
        scale = (right - left) / 656
        entry = physical(left + 120 * scale, top + (32 + 38) * scale)
        canvas = physical(left + 150 * scale, top + (32 + 160) * scale)
        await act("click", **canvas)
        assert len(log()["clicks"]) == 1
        await act("click", **entry)
        await act("type", text="Cleo 你好")
        await asyncio.sleep(0.3)
        assert log()["text"] == "Cleo 你好"
        await act("key", keys="ctrl+b")
        await asyncio.sleep(0.3)
        assert log()["keys"] == ["ctrl+b"]
        start = physical(left + 60 * scale, top + (32 + 120) * scale)
        end = physical(left + 220 * scale, top + (32 + 200) * scale)
        await act("drag", from_x=start["x"], from_y=start["y"], to_x=end["x"], to_y=end["y"])
        await asyncio.sleep(0.3)
        assert log()["drag"] is not None and log()["drag"][2] > log()["drag"][0]
        await act("scroll", **canvas, direction="down", amount=2)
        await asyncio.sleep(0.3)
        assert log()["scroll"] >= 1
        # Stop during a long typing action: input ends early and no key stays pressed.
        await act("click", **entry)
        typing = asyncio.create_task(host.run("type", {"text": "x" * 4000, **common}))
        await asyncio.sleep(0.3)
        report = await host.stop("test")
        with pytest.raises(Exception, match="已停止"):
            await typing
        assert report["settled"] is True
        assert len(log()["text"]) < 4000 + len("Cleo 你好")
        for vk in (0x10, 0x11, 0x12, 0x5B, 0x01):
            assert not ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000

    try:
        asyncio.run(scenario())
    finally:
        ctypes.windll.user32.SetCursorPos(original[0], original[1])
        app.terminate()
        app.wait(10)
