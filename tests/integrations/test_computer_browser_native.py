"""Opt-in end-to-end test of Cleo's built-in browser in real Electron.

Enable with ``CLEO_TEST_ELECTRON`` pointing at an Electron executable (for example
``ui/node_modules/electron/dist/electron.exe``). The test starts a local website, Cleo's real
computer modules in an Electron harness and the real ``cleo_computer`` MCP server, then drives
the browser only through model tools. It never sends input to the host desktop and checks that
the foreground window does not change while the AI types and clicks.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

import pytest

ELECTRON = os.environ.get("CLEO_TEST_ELECTRON")
pytestmark = pytest.mark.skipif(not ELECTRON, reason="Requires CLEO_TEST_ELECTRON")
ROOT = Path(__file__).resolve().parents[2]
HARNESS = ROOT / "ui/tests/fixtures/computer-harness/main.mjs"

PAGE = """<!doctype html><html><head><title>{title}</title><meta charset="utf-8">
<style>body{{margin:0;font:16px sans-serif}} div,input,button,a{{position:absolute}}
#target{{left:{left}px;top:{top}px;width:90px;height:60px;background:#ff00ff}}
#text{{left:40px;top:260px;width:320px;height:36px}}
#list{{left:420px;top:40px;width:220px;height:160px;overflow:auto;border:1px solid #999}}
#list div{{position:static}} #confirm{{left:40px;top:330px}} #popup{{left:200px;top:330px}}
#file{{left:40px;top:380px}} #dl{{left:300px;top:380px}}</style></head><body>
<div id="target"></div><input id="text"><div id="list"><div style="height:2000px">rows</div></div>
<button id="confirm">confirm</button>
<button id="popup" onclick="window.open('/other')">popup</button>
<input id="file" type="file"><a id="dl" href="/file.txt" download>download</a>
<script>window.hits=0;document.getElementById('target').addEventListener('click',()=>window.hits++);
document.getElementById('confirm').onclick=()=>{{window.confirmed=confirm('继续吗？')}};</script></body></html>"""


class Site(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, body: str, status=200, headers=None):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8" if not self.path.endswith(".txt") else "text/plain",
        )
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        if self.path.startswith("/target"):
            self.reply(PAGE.format(title="target", left=120, top=90))
        elif self.path.startswith("/other"):
            self.reply("<title>other</title><p>second tab</p>"
                       "<script>document.title = 'other:' + Boolean(window.opener)</script>")
        elif self.path == "/file.txt":
            self.reply("downloaded content")
        elif self.path.startswith("/login"):
            self.reply(
                "<title>login</title><form method=post action=/login>"
                "<input id=user name=user style='position:absolute;left:40px;top:40px;"
                "width:200px;height:30px'>"
                "<button id=go style='position:absolute;left:40px;top:100px'>登录</button></form>"
            )
        elif self.path.startswith("/app"):
            user = cookie.get("session")
            welcome = "欢迎 " + user.value if user else "未登录"
            self.reply(f"<title>app</title><h1 id=welcome>{welcome}</h1>")
        else:
            self.reply("<title>home</title>home")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        user = parse_qs(self.rfile.read(length).decode()).get("user", [""])[0]
        # Persistent cookie: must survive a browser restart.
        self.reply(
            "", 303, {"Location": "/app", "Set-Cookie": f"session={user}; Max-Age=86400; Path=/"}
        )


class Harness:
    def __init__(self, tmp: Path):
        """Purpose: Start an owned Electron harness with exception-safe cleanup.

        Input: tmp is the isolated test data directory.
        Output: A connected harness; startup failures reap the owned process tree.
        """
        env = {
            **os.environ,
            "CLEO_HARNESS_USER_DATA": str(tmp / "user-data"),
            "CLEO_HARNESS_WORKSPACE": str(tmp / "workspace"),
            "CLEO_HARNESS_DOWNLOADS": str(tmp / "downloads"),
            "ELECTRON_ENABLE_LOGGING": "0",
        }
        env.pop("ELECTRON_RUN_AS_NODE", None)
        self.lock = threading.Lock()
        self.pending: dict[int, dict] = {}
        self.events: list[dict] = []
        self.counter = 0
        self.descriptor = None
        self.ready = threading.Event()
        self.reader = None
        self.socket = None
        # Electron's main process does not read piped stdin on Windows; the harness prints a
        # loopback test port and token instead.
        self.process = subprocess.Popen(
            [ELECTRON, str(HARNESS)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            encoding="utf-8",
            start_new_session=sys.platform != "win32",
        )
        try:
            self.reader = threading.Thread(target=self.read, daemon=True)
            self.reader.start()
            assert self.ready.wait(60), "Electron harness did not start"
            assert self.descriptor, "computer bridge did not start"
            self.socket = socket.create_connection(("127.0.0.1", self.port))
            threading.Thread(target=self.read_socket, daemon=True).start()
        except BaseException:
            self.close()
            raise

    def read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            self.events.append(message)
            if message.get("event") == "ready":
                self.descriptor = message.get("descriptor")
                self.port, self.token = message.get("port"), message.get("token")
                self.ready.set()

    def read_socket(self):
        buffer = b""
        while True:
            try:
                chunk = self.socket.recv(1 << 20)
            except OSError:
                return
            if not chunk:
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                message = json.loads(line)
                with self.lock:
                    self.pending[message["id"]] = message

    def send(self, cmd: str, timeout=30, **params):
        with self.lock:
            self.counter += 1
            ident = self.counter
        self.socket.sendall(
            (json.dumps({"id": ident, "token": self.token, "cmd": cmd, **params}) + "\n").encode()
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                if ident in self.pending:
                    reply = self.pending.pop(ident)
                    if not reply["ok"]:
                        raise AssertionError(reply["error"])
                    return reply["result"]
            time.sleep(0.02)
        raise TimeoutError(cmd)

    def close(self):
        """Purpose: Stop the owned harness and release its connection and output pipe.

        Input: The process and optional socket created by this instance.
        Output: Graceful exit or bounded tree termination, followed by process reaping.
        """
        if self.socket is not None:
            try:
                if self.process.poll() is None:
                    self.send("quit", timeout=10)
            except Exception:  # noqa: BLE001
                pass
            finally:
                try:
                    self.socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                self.socket.close()
        try:
            self.process.wait(15)
        except subprocess.TimeoutExpired:
            if sys.platform == "win32":
                # Only this Popen PID and its descendants; never kill by executable name.
                system_root = Path(os.environ.get("SystemRoot", "C:/Windows"))
                taskkill = system_root / "System32/taskkill.exe"
                subprocess.run(
                    [str(taskkill), "/PID", str(self.process.pid), "/T", "/F"],
                    capture_output=True,
                    timeout=15,
                    check=False,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                # Popen creates a fresh session, so this group contains only our harness.
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            self.process.wait(10)
        if self.reader is not None and self.reader.ident is not None:
            self.reader.join(timeout=1)
        self.process.stdout.close()


def foreground() -> int:
    if sys.platform != "win32":
        return 0
    import ctypes

    return int(ctypes.windll.user32.GetForegroundWindow() or 0)


def magenta_center(block: dict) -> tuple[int, int]:
    from PIL import Image

    image = Image.open(io.BytesIO(base64.b64decode(block["data"]))).convert("RGB")
    xs, ys = [], []
    pixels = image.load()
    for y in range(0, image.height, 2):
        for x in range(0, image.width, 2):
            r, g, b = pixels[x, y]
            if r > 230 and g < 40 and b > 230:
                xs.append(x)
                ys.append(y)
    assert xs, "magenta target not visible in screenshot"
    return (min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2


def test_fresh_blank_tab_screenshot_returns(tmp_path):
    """The model's required first screenshot must work before any navigation."""
    from cleo.computer.bridge import request

    harness = Harness(tmp_path)
    try:
        async def capture():
            blocks = await request(
                {"op": "call", "identity": {"thread_id": "fresh-blank"},
                 "name": "browser_screenshot", "arguments": {}},
                bridge=harness.descriptor, timeout=3,
            )
            assert any(block["type"] == "image" for block in blocks)

        asyncio.run(capture())
    finally:
        harness.close()


def test_built_in_browser_end_to_end(tmp_path):
    from fastmcp import Client
    from fastmcp.client.transports import StdioTransport

    from cleo.integrations.computer import server_configuration

    server = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    (tmp_path / "workspace").mkdir()
    (tmp_path / "workspace" / "report.txt").write_text("upload me", encoding="utf-8")
    from PIL import Image

    Image.new("RGB", (2, 2), color="red").save(tmp_path / "workspace" / "preview.png")
    (tmp_path / "workspace" / "site").mkdir()
    (tmp_path / "workspace" / "site" / "index.html").write_text(
        '<title>预览页</title><link rel="stylesheet" href="site.css"><p>preview</p>',
        encoding="utf-8",
    )
    (tmp_path / "workspace" / "site" / "site.css").write_text(
        "body { color: rgb(255, 0, 0); }", encoding="utf-8"
    )
    (tmp_path / "outside.txt").write_text("secret", encoding="utf-8")
    config = tmp_path / "computer-use.json"
    report: dict = {}
    before = foreground()
    harness = Harness(tmp_path)
    try:
        image_url = harness.send("fileUrl", root=str(tmp_path / "workspace"), path="preview.png")
        image_loaded = harness.send(
            "uiEval", script="new Promise(resolve => { const image = new Image(); "
            "image.onload = () => resolve(image.naturalWidth); "
            "image.onerror = () => resolve(0); "
            f"image.src = {json.dumps(image_url)}; " + "})",
        )
        assert image_loaded == 2, "Workspace images must render in Cleo's UI session"
        report["ui_image_preview"] = True
        key = "0123456789abcdef0123456789abcdef"
        harness.send("owner", key=key, thread="thread-smoke")
        harness.send("turn", thread="thread-smoke", running=True)
        os.environ["CLEO_COMPUTER_BRIDGE"] = harness.descriptor
        entry = server_configuration(config, key)["cleo_computer"]
        assert "--bridge" in entry["args"] and "--client-key" in entry["args"]

        async def scenario():
            transport = StdioTransport(
                command=entry["command"], args=entry["args"], cwd=str(tmp_path), keep_alive=False
            )
            async with Client(transport, timeout=120) as client:

                async def call(name, **arguments):
                    result = await client.call_tool(
                        "computer_call", {"name": name, "arguments": arguments}
                    )
                    texts = [block.text for block in result.content if block.type == "text"]
                    images = [
                        {"data": block.data} for block in result.content if block.type == "image"
                    ]
                    return texts, images

                def payload(texts):
                    return json.loads(texts[0])

                catalog = await client.call_tool("computer_tools", {})
                assert (
                    "browser_screenshot" in catalog.content[0].text
                    and "内置浏览器" in catalog.content[1].text
                )
                texts, _ = await call("desktop_screenshot")
                assert "内置浏览器" in texts[0], (
                    texts
                )  # host tools unavailable without authorization

                texts, images = await call("browser_screenshot")
                assert images, "The real MCP channel must screenshot before navigation"
                assert payload(texts)["target"]["mode"] == "browser"
                report["first_blank_screenshot"] = True

                texts, _ = await call("browser_tabs", action="new", url=f"{base}/target")
                await asyncio.sleep(1.0)
                texts, images = await call("browser_screenshot")
                shot = payload(texts)
                tab, sid = shot["target"]["tab_id"], shot["screenshot"]["screenshot_id"]
                assert (shot["screenshot"]["width"], shot["screenshot"]["height"]) == (900, 640)
                x, y = magenta_center(images[0])
                await call("browser_click", tab_id=tab, screenshot_id=sid, x=x, y=y)
                assert harness.send("eval", script="window.hits") == 1
                report["screenshot_click"] = True

                read_texts, read_images = await call("browser_read", tab_id=tab)
                read = payload(read_texts)
                assert read_images, "Element coordinates must be paired with an actual screenshot"
                stale_texts, _ = await call(
                    "browser_click", tab_id=tab, screenshot_id=sid, x=x, y=y
                )
                assert "最新截图" in stale_texts[0], stale_texts
                assert harness.send("eval", script="window.hits") == 1
                sid = read["screenshot_id"]
                report["latest_screenshot"] = True
                box = next(
                    item
                    for item in read["elements"]
                    if item["tag"] == "input" and item["type"] == "text"
                )
                await call(
                    "browser_click",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    x=box["x"],
                    y=box["y"],
                )
                await call(
                    "browser_type",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    text="你好，Cleo",
                )
                assert (
                    harness.send("eval", script="document.getElementById('text').value")
                    == "你好，Cleo"
                )
                await call(
                    "browser_key", tab_id=tab, screenshot_id=read["screenshot_id"], keys="ctrl+a"
                )
                await call(
                    "browser_key", tab_id=tab, screenshot_id=read["screenshot_id"], keys="Backspace"
                )
                assert harness.send("eval", script="document.getElementById('text').value") == ""
                report["type_and_shortcuts"] = True

                await call(
                    "browser_scroll",
                    tab_id=tab,
                    screenshot_id=sid,
                    x=520,
                    y=120,
                    direction="down",
                    amount=3,
                )
                assert harness.send("eval", script="document.getElementById('list').scrollTop") > 0
                report["scroll"] = True

                # Zoom invalidates old coordinates; a new screenshot maps again correctly.
                harness.send("zoom", factor=1.5)
                texts, _ = await call("browser_click", tab_id=tab, screenshot_id=sid, x=x, y=y)
                assert "过期" in texts[0], texts
                texts, images = await call("browser_screenshot")
                zoomed = payload(texts)["screenshot"]["screenshot_id"]
                zx, zy = magenta_center(images[0])
                # The page origin stays fixed, so at 150% the target appears at 1.5x its position.
                assert abs(zx - x) > 20 and abs(zx - x * 1.5) <= 4, (x, zx)
                await call("browser_click", tab_id=tab, screenshot_id=zoomed, x=zx, y=zy)
                assert harness.send("eval", script="window.hits") == 2
                harness.send("zoom", factor=1.0)
                report["zoom"] = True

                # Resizing the panel also invalidates coordinates.
                harness.send("viewport", rect={"x": 20, "y": 60, "width": 700, "height": 500})
                texts, _ = await call("browser_click", tab_id=tab, screenshot_id=zoomed, x=10, y=10)
                assert "过期" in texts[0], texts
                texts, images = await call("browser_screenshot")
                small = payload(texts)["screenshot"]
                assert (small["width"], small["height"]) == (700, 500)
                sx, sy = magenta_center(images[0])
                await call(
                    "browser_click", tab_id=tab, screenshot_id=small["screenshot_id"], x=sx, y=sy
                )
                assert harness.send("eval", script="window.hits") == 3
                report["resize"] = True

                # JavaScript dialogs are handled through tools, never native windows.
                read = payload((await call("browser_read", tab_id=tab))[0])
                button = next(item for item in read["elements"] if item["label"] == "confirm")
                texts, _ = await call(
                    "browser_click",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    x=button["x"],
                    y=button["y"],
                )
                assert "对话框" in texts[0], texts
                await call("browser_dialog", tab_id=tab, accept=True)
                await asyncio.sleep(0.3)
                assert harness.send("eval", script="window.confirmed") is True
                report["dialog"] = True

                # Uploads are limited to the task workspace.
                file_input = next(item for item in read["elements"] if item["type"] == "file")
                await call(
                    "browser_click",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    x=file_input["x"],
                    y=file_input["y"],
                )
                await asyncio.sleep(0.5)
                texts, _ = await call(
                    "browser_upload", tab_id=tab, paths=[str(tmp_path / "outside.txt")]
                )
                assert "工作目录" in texts[0], texts
                await call("browser_upload", tab_id=tab, paths=["report.txt"])
                assert (
                    harness.send("eval", script="document.getElementById('file').files[0].name")
                    == "report.txt"
                )
                report["upload"] = True

                download = next(item for item in read["elements"] if item["label"] == "download")
                await call(
                    "browser_click",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    x=download["x"],
                    y=download["y"],
                )
                await asyncio.sleep(1.5)
                state = harness.send("state")
                assert state["browser"]["downloads"][0]["state"] == "completed"
                assert (
                    Path(state["browser"]["downloads"][0]["path"]).read_text()
                    == "downloaded content"
                )
                report["download"] = True

                # A popup opens as a new tab; old coordinates cannot be sent to it.
                popup = next(item for item in read["elements"] if item["label"] == "popup")
                await call(
                    "browser_click",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    x=popup["x"],
                    y=popup["y"],
                )
                await asyncio.sleep(1.0)
                tabs = payload((await call("browser_tabs", action="list"))[0])["tabs"]
                active = next(item for item in tabs if item["active"])
                assert active["tab_id"] != tab and "/other" in active["url"]
                # Login popups opened with window.open rely on window.opener; the new tab keeps it.
                assert active["title"] == "other:true", active
                texts, _ = await call(
                    "browser_click", tab_id=tab, screenshot_id=read["screenshot_id"], x=5, y=5
                )
                assert "不是当前显示的标签页" in texts[0] or "过期" in texts[0], texts
                await call("browser_tabs", action="close", tab_id=active["tab_id"])
                await call("browser_tabs", action="switch", tab_id=tab)
                report["tabs"] = True

                # Workspace HTML previews load relative resources; remote pages cannot read them.
                harness.send("preview", root=str(tmp_path / "workspace"), path="site/index.html")
                await asyncio.sleep(1.0)
                assert harness.send("eval", script="document.title") == "预览页"
                assert (
                    harness.send("eval", script="getComputedStyle(document.body).color")
                    == "rgb(255, 0, 0)"
                )
                secret_url = harness.send(
                    "fileUrl", root=str(tmp_path / "workspace"), path="report.txt"
                )
                # Opening a preview is a user action during the AI task:
                # the AI waits until the user hands control back.
                assert harness.send("state")["control"]["browser"] == "user"
                harness.send("handback")
                await call("browser_tabs", action="switch", tab_id=tab)
                probe = f"fetch({json.dumps(secret_url)})"
                blocked = harness.send(
                    "eval", script=probe + ".then(r => r.text()).catch(() => 'blocked')"
                )
                assert blocked == "blocked", blocked
                preview_tab = next(
                    item
                    for item in payload((await call("browser_tabs", action="list"))[0])["tabs"]
                    if "预览页" in item["title"]
                )
                await call("browser_tabs", action="close", tab_id=preview_tab["tab_id"])
                await call("browser_tabs", action="switch", tab_id=tab)
                report["workspace_preview"] = True

                # Local files and schemes other than http(s) are refused.
                texts, _ = await call(
                    "browser_navigate", tab_id=tab, url="file:///C:/Windows/win.ini"
                )
                assert "不支持" in texts[0], texts
                assert (
                    harness.send("eval", script="typeof require + typeof process")
                    == "undefinedundefined"
                )
                report["security"] = True

                # Takeover: queued AI input never runs; after handback a new screenshot is required.
                texts, images = await call("browser_screenshot")
                sid = payload(texts)["screenshot"]["screenshot_id"]
                x, y = magenta_center(images[0])
                harness.send("takeover")
                pending = asyncio.create_task(
                    call("browser_click", tab_id=tab, screenshot_id=sid, x=x, y=y)
                )
                await asyncio.sleep(1.0)
                assert not pending.done(), "AI input must wait while the user controls the browser"
                harness.send("handback")
                texts, _ = await pending
                assert "交回" in texts[0] or "过期" in texts[0], texts
                assert harness.send("eval", script="window.hits") == 3
                report["takeover"] = True

                # Stop cancels an in-flight action promptly and reports completion.
                started = time.monotonic()
                waiting = asyncio.create_task(call("browser_wait", seconds=10))
                await asyncio.sleep(0.5)
                stopped = harness.send("stop")
                texts, _ = await waiting
                assert time.monotonic() - started < 5 and "停止" in texts[0], texts
                assert stopped["settled"] is True
                harness.send("turn", thread="thread-smoke", running=True)
                report["stop"] = True

                # Every step so far was an AI action:
                # Cleo must not have taken focus or the foreground.
                assert not harness.send("focused")["windowFocused"], (
                    "AI actions must not focus Cleo"
                )
                if sys.platform == "win32" and before:
                    report["foreground_unchanged"] = foreground() == before
                    assert report["foreground_unchanged"], (
                        "AI browser actions must not change the foreground window"
                    )
                # Screenshots and clicks keep working while Cleo is minimized.
                harness.send("minimize")
                await asyncio.sleep(0.8)
                texts, images = await call("browser_screenshot")
                sid = payload(texts)["screenshot"]["screenshot_id"]
                x, y = magenta_center(images[0])
                await call("browser_click", tab_id=tab, screenshot_id=sid, x=x, y=y)
                assert harness.send("eval", script="window.hits") == 4
                harness.send("restore")
                report["minimized"] = True

                # Host authorization cannot be granted by the model; cross-target ids are refused.
                texts, _ = await call("browser_screenshot")
                sid = payload(texts)["screenshot"]["screenshot_id"]
                harness.send("mode", thread="thread-smoke", mode="host", confirmed=True)
                texts, _ = await call("desktop_click", screenshot_id=sid, x=1, y=1)
                assert "来自内置浏览器" in texts[0], texts
                harness.send("mode", thread="thread-smoke", mode="browser")
                request = asyncio.create_task(call("request_desktop_control", reason="测试"))
                await asyncio.sleep(0.5)
                harness.send("authorize", granted=False)
                texts, _ = await request
                assert "拒绝" in texts[0], texts
                assert harness.send("state")["threads"]["thread-smoke"]["mode"] == "browser"
                report["authorization"] = True

                # Log in; the persistent profile must keep the session after restart.
                await call("browser_navigate", tab_id=tab, url=f"{base}/login")
                await asyncio.sleep(0.8)
                read = payload((await call("browser_read", tab_id=tab))[0])
                box = next(item for item in read["elements"] if item["tag"] == "input")
                await call(
                    "browser_click",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    x=box["x"],
                    y=box["y"],
                )
                await call(
                    "browser_type",
                    tab_id=tab,
                    screenshot_id=read["screenshot_id"],
                    text="cleo",
                    submit=True,
                )
                await asyncio.sleep(1.0)
                assert (
                    harness.send("eval", script="document.getElementById('welcome')?.textContent")
                    == "欢迎 cleo"
                )
                report["login"] = True

        asyncio.run(scenario())
    finally:
        harness.close()
    # Exit releases the bridge: the descriptor with its token is removed.
    assert not Path(harness.descriptor).exists()
    report["bridge_released"] = True

    # Restart with the same profile: the login cookie persists.
    harness = Harness(tmp_path)
    try:
        key = "fedcba9876543210fedcba9876543210"
        harness.send("owner", key=key, thread="thread-smoke")
        harness.send("turn", thread="thread-smoke", running=True)
        os.environ["CLEO_COMPUTER_BRIDGE"] = harness.descriptor
        entry = server_configuration(config, key)["cleo_computer"]

        async def restart():
            transport = StdioTransport(
                command=entry["command"], args=entry["args"], cwd=str(tmp_path), keep_alive=False
            )
            async with Client(transport, timeout=120) as client:
                await client.call_tool(
                    "computer_call",
                    {"name": "browser_tabs", "arguments": {"action": "new", "url": f"{base}/app"}},
                )
                await asyncio.sleep(1.0)

        asyncio.run(restart())
        assert (
            harness.send("eval", script="document.getElementById('welcome')?.textContent")
            == "欢迎 cleo"
        )
        report["login_persisted"] = True
    finally:
        harness.close()
        os.environ.pop("CLEO_COMPUTER_BRIDGE", None)
        server.shutdown()
    print(json.dumps(report, ensure_ascii=False))
