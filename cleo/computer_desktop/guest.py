"""Private container service: one X desktop, model tools, and authenticated VNC viewers."""

import asyncio
import base64
import contextlib
import hmac
import io
import os
import subprocess
from pathlib import Path

from aiohttp import WSMsgType, web

WIDTH, HEIGHT = 1440, 900
APPLICATIONS = []


def tool(name, description, properties=None, required=None):
    """Purpose: Describe a desktop action. Input: fields. Output: MCP-compatible schema."""
    return {
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties or {},
            "required": required or [],
            "additionalProperties": False,
        },
    }


TOOLS = [
    tool(
        "Snapshot",
        "Inspect the isolated Linux desktop. Returns an image and window titles; "
        "coordinates are in the full 1440×900 image. Requires a vision-capable model.",
        {"use_vision": {"type": "boolean", "default": True}},
    ),
    tool(
        "Click",
        "Click a position in the latest desktop screenshot.",
        {
            "x": {"type": "integer", "minimum": 0, "maximum": WIDTH - 1},
            "y": {"type": "integer", "minimum": 0, "maximum": HEIGHT - 1},
            "button": {"type": "string", "enum": ["left", "middle", "right"]},
            "clicks": {"type": "integer", "minimum": 1, "maximum": 2},
        },
        ["x", "y"],
    ),
    tool(
        "Type",
        "Enter Unicode text in the focused application.",
        {"text": {"type": "string", "maxLength": 20000}},
        ["text"],
    ),
    tool(
        "Shortcut",
        "Press a keyboard shortcut, for example ctrl+l, ctrl+t, Return, Tab.",
        {"keys": {"type": "string", "maxLength": 100}},
        ["keys"],
    ),
    tool(
        "Scroll",
        "Scroll at the current pointer location.",
        {
            "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
            "amount": {"type": "integer", "minimum": 1, "maximum": 20},
        },
        ["direction"],
    ),
    tool(
        "App",
        "Open an application inside the isolated desktop.",
        {"name": {"type": "string", "enum": ["browser", "files", "editor", "terminal"]}},
        ["name"],
    ),
    tool(
        "Wait",
        "Wait briefly for the UI, then take another Snapshot.",
        {"seconds": {"type": "number", "minimum": 0, "maximum": 5}},
    ),
]


async def command(*args, data=None):
    """Purpose: Run an X11 utility without a shell. Input: argv/stdin. Output: bounded text."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(data), 10)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise ValueError(err.decode(errors="replace")[:500] or "Desktop action failed")
    return out.decode(errors="replace")[:8000]


def screenshot():
    """Purpose: Capture only the guest X server. Input: DISPLAY. Output: in-memory PNG."""
    from PIL import Image
    from Xlib import X, display

    capture = display.Display()
    try:
        frame = capture.screen().root.get_image(0, 0, WIDTH, HEIGHT, X.ZPixmap, 0xFFFFFFFF)
        image = Image.frombytes("RGB", (WIDTH, HEIGHT), frame.data, "raw", "BGRX")
        output = io.BytesIO()
        image.save(output, format="PNG")
        return base64.b64encode(output.getvalue()).decode()
    finally:
        capture.close()


class Desktop:
    """Manual control and agent actions share a lock; manual viewers use a separate VNC port."""

    def __init__(self):
        """Purpose: Own a guest session. Input: environment token. Output: paused-free desktop."""
        self.token = os.environ["CLEO_DESKTOP_TOKEN"]
        self.mode = "agent"
        self.lock = asyncio.Lock()
        self.controllers = {}

    def authorize(self, request, websocket=False):
        """Purpose: Reject unrelated clients.
        Input: authenticated request.
        Output: access or 401."""
        supplied = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if websocket:
            supplied = request.query.get("token", "")
        if not hmac.compare_digest(supplied, self.token):
            raise web.HTTPUnauthorized()

    async def status(self, request):
        """Purpose: Report shared state. Input: request. Output: desktop mode and geometry."""
        self.authorize(request)
        return web.json_response({"mode": self.mode, "width": WIDTH, "height": HEIGHT})

    async def control(self, request):
        """Purpose: Transfer ownership after active input finishes. Input: mode. Output: state."""
        self.authorize(request)
        mode = (await request.json()).get("mode")
        if mode not in {"agent", "user"}:
            raise web.HTTPBadRequest(text="Invalid control mode")
        async with self.lock:
            # Revoke interactive sockets before allowing a subsequent agent action.
            if mode == "agent":
                for ws, drained in tuple(self.controllers.items()):
                    # A pong shares the input connection's ordering: all earlier key events
                    # must reach the VNC writer before handoff closes the interactive socket.
                    drained.clear()
                    with contextlib.suppress(TimeoutError, ConnectionError):
                        await ws.ping(b"handoff")
                        await asyncio.wait_for(drained.wait(), 2)
                    await ws.close()
                await asyncio.sleep(0.15)
            self.mode = mode
        return web.json_response({"mode": self.mode, "width": WIDTH, "height": HEIGHT})

    async def tools(self, request):
        """Purpose: Describe guest tools. Input: request. Output: schemas without host tools."""
        self.authorize(request)
        return web.json_response(TOOLS)

    async def text(self, request):
        """Purpose: Send manual Unicode input without model events.
        Input: text.
        Output: sent flag."""
        self.authorize(request)
        args = await request.json()
        async with self.lock:
            if self.mode != "user":
                raise web.HTTPConflict(text="请先接管桌面。")
            await self.execute("Type", {"text": args.get("text", "")})
        return web.json_response({"sent": True})

    async def action(self, request):
        """Purpose: Serialize model actions and exclude manual login.
        Input: tool.
        Output: blocks."""
        self.authorize(request)
        payload = await request.json()
        async with self.lock:
            if self.mode != "agent":
                raise web.HTTPConflict(text="用户正在操作；等待交回控制后再继续。")
            try:
                blocks = await self.execute(payload.get("name"), payload.get("arguments") or {})
            except (ValueError, KeyError, TypeError) as exc:
                raise web.HTTPBadRequest(text=str(exc)[:500]) from exc
        return web.json_response(blocks)

    async def execute(self, name, args):
        """Purpose: Execute a discovered action in Xvfb. Input: name/args. Output: model content."""
        if name == "Snapshot":
            titles = await command(
                "sh", "-c", "wmctrl -l 2>/dev/null || xdotool getwindowfocus getwindowname"
            )
            return [
                {"type": "text", "text": f"独立 Linux 桌面 {WIDTH}×{HEIGHT}。窗口：{titles}"},
                {
                    "type": "image",
                    "base64": await asyncio.to_thread(screenshot),
                    "mime_type": "image/png",
                },
            ]
        if name == "Click":
            x, y = int(args["x"]), int(args["y"])
            clicks = int(args.get("clicks", 1))
            if not (0 <= x < WIDTH and 0 <= y < HEIGHT and clicks in (1, 2)):
                raise ValueError("Click is outside the desktop")
            button = {"left": "1", "middle": "2", "right": "3"}[args.get("button", "left")]
            await command(
                "xdotool",
                "mousemove",
                "--sync",
                str(x),
                str(y),
                "click",
                "--repeat",
                str(clicks),
                "--delay",
                "100",
                button,
            )
        elif name == "Type":
            text = args["text"]
            if not isinstance(text, str) or len(text) > 20000:
                raise ValueError("Invalid text")
            # xclip forks its selection owner; detach output so communicate can finish.
            await command(
                "sh", "-c", "xclip -selection clipboard >/dev/null 2>&1", data=text.encode()
            )
            await command("xdotool", "key", "--clearmodifiers", "ctrl+v")
        elif name == "Shortcut":
            keys = args["keys"]
            if not isinstance(keys, str) or not keys or len(keys) > 100 or keys.startswith("-"):
                raise ValueError("Invalid shortcut")
            await command("xdotool", "key", "--clearmodifiers", keys)
        elif name == "Scroll":
            amount = int(args.get("amount", 3))
            if not 1 <= amount <= 20:
                raise ValueError("Invalid scroll amount")
            button = {"up": "4", "down": "5", "left": "6", "right": "7"}[args["direction"]]
            await command("xdotool", "click", "--repeat", str(amount), button)
        elif name == "App":
            launch(args["name"])
        elif name == "Wait":
            seconds = float(args.get("seconds", 1))
            if not 0 <= seconds <= 5:
                raise ValueError("Invalid wait duration")
            await asyncio.sleep(seconds)
        else:
            raise ValueError("Unknown isolated desktop tool; call computer_tools again")
        return [{"type": "text", "text": "操作已发送到独立桌面。请用 Snapshot 核对结果。"}]

    async def websocket(self, request):
        """Purpose: Stream VNC within loopback-only transport.
        Input: viewer.
        Output: live desktop."""
        self.authorize(request, websocket=True)
        interactive = request.match_info["kind"] == "control"
        async with self.lock:
            if interactive and self.mode != "user":
                raise web.HTTPForbidden(text="Take control before sending desktop input")
            ws = web.WebSocketResponse(max_msg_size=8 * 1024 * 1024, autoping=False)
            await ws.prepare(request)
            reader, writer = await asyncio.open_connection(
                "127.0.0.1", 5901 if interactive else 5900
            )
            if interactive:
                self.controllers[ws] = asyncio.Event()

        async def receive():
            """Purpose: Forward guest pixels. Input: VNC socket. Output: websocket frames."""
            while data := await reader.read(65536):
                await ws.send_bytes(data)
            await ws.close()

        task = asyncio.create_task(receive())
        try:
            async for message in ws:
                if message.type == WSMsgType.BINARY:
                    writer.write(message.data)
                    await writer.drain()
                elif message.type == WSMsgType.PONG and message.data == b"handoff":
                    if ws in self.controllers:
                        self.controllers[ws].set()
                elif message.type == WSMsgType.PING:
                    await ws.pong(message.data)
        finally:
            self.controllers.pop(ws, None)
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, ConnectionError):
                await task
            writer.close()
            await writer.wait_closed()
        return ws


def launch(name):
    """Purpose: Open an application on the guest display. Input: app name. Output: child process."""
    apps = {
        "browser": [
            "chromium",
            "--no-sandbox",
            "--no-first-run",
            "--disable-dev-shm-usage",
            "--password-store=basic",
            "--start-maximized",
        ],
        "files": ["pcmanfm"],
        "editor": ["mousepad"],
        "terminal": ["xterm"],
    }
    APPLICATIONS[:] = [child for child in APPLICATIONS if child.poll() is None]
    APPLICATIONS.append(
        subprocess.Popen(apps[name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    )


async def startup(app):
    """Purpose: Start a private X session.
    Input: app lifecycle.
    Output: managed desktop children."""
    # This container exclusively owns its browser home. Only stale process locks are removed;
    # cookies, saved sessions, preferences, and downloads remain in the named home volume.
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        (Path.home() / ".config/chromium" / name).unlink(missing_ok=True)
    # /tmp belongs exclusively to this container, but survives docker stop/start.
    # A killed X server can leave a socket and PID lock that block the next session.
    for name in ("/tmp/.X99-lock", "/tmp/.X11-unix/X99"):
        Path(name).unlink(missing_ok=True)
    commands = [["Xvfb", ":99", "-screen", "0", f"{WIDTH}x{HEIGHT}x24", "-nolisten", "tcp", "-ac"]]
    children = []
    app["children"] = children
    for argv in commands:
        children.append(
            subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        )
    for _ in range(100):
        try:
            await command("xdpyinfo")
            break
        except ValueError:
            await asyncio.sleep(0.1)
    else:
        raise RuntimeError("The isolated X server did not start")
    for argv in [
        ["openbox"],
        ["tint2"],
        [
            "x11vnc",
            "-display",
            ":99",
            "-localhost",
            "-rfbport",
            "5900",
            "-nopw",
            "-forever",
            "-shared",
            "-viewonly",
            "-quiet",
        ],
        [
            "x11vnc",
            "-display",
            ":99",
            "-localhost",
            "-rfbport",
            "5901",
            "-nopw",
            "-forever",
            "-shared",
            "-quiet",
        ],
    ]:
        children.append(
            subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        )
    await asyncio.sleep(0.5)
    launch("browser")


async def cleanup(app):
    """Purpose: Reap owned processes. Input: app. Output: stopped guest session."""
    for child in APPLICATIONS:
        if child.poll() is None:
            child.terminate()
    for child in APPLICATIONS:
        try:
            await asyncio.to_thread(child.wait, timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
    for child in reversed(app.get("children", [])):
        if child.poll() is None:
            child.terminate()
        try:
            await asyncio.to_thread(child.wait, timeout=1)
        except subprocess.TimeoutExpired:
            child.kill()


def create_app(start_desktop=True):
    """Purpose: Assemble an authenticated guest service. Input: lifecycle flag. Output: app."""
    desktop = Desktop()
    app = web.Application(client_max_size=1024 * 1024)
    app["desktop"] = desktop
    app.add_routes(
        [
            web.get("/status", desktop.status),
            web.get("/tools", desktop.tools),
            web.post("/control", desktop.control),
            web.post("/action", desktop.action),
            web.post("/text", desktop.text),
            web.get("/vnc/{kind:view|control}", desktop.websocket),
        ]
    )
    if start_desktop:
        app.on_startup.append(startup)
        app.on_cleanup.append(cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), port=8765, access_log=None, print=None)
