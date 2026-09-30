"""Local Windows desktop control for Cleo's "本机电脑" mode.

Only screen capture and user-level input (SendInput) are offered: no shell, file, registry or
process tools, so the command sandbox stays the only way to run commands. Coordinates are
physical virtual-screen pixels, and every operation runs with per-monitor DPI awareness so
capture, cursor and input agree on all displays and scale factors.

Safety rules enforced here, independent of the model:
- actions whose target is a Cleo window (or keyboard input while Cleo is in front) are refused;
- if the user moved the mouse or typed since the last screenshot/action, nothing is sent and the
  broker pauses the AI;
- stop cancels between input steps and releases only keys and buttons this controller pressed.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import io
import sys
import threading
import time
from dataclasses import dataclass

MAX_EDGE = 1600
TYPE_BATCH = 16


class HostError(Exception):
    """The requested local action was refused or failed; nothing is claimed to have happened."""


class UserActivity(HostError):
    """Physical user input interrupted an action; the broker must hand control to the user."""


# --- key names ------------------------------------------------------------------------------

MODIFIER_VK = {
    "ctrl": 0x11,
    "control": 0x11,
    "alt": 0x12,
    "option": 0x12,
    "shift": 0x10,
    "win": 0x5B,
    "windows": 0x5B,
    "meta": 0x5B,
    "cmd": 0x5B,
    "command": 0x5B,
    "super": 0x5B,
}
NAMED_VK = {
    "enter": 0x0D,
    "return": 0x0D,
    "tab": 0x09,
    "esc": 0x1B,
    "escape": 0x1B,
    "backspace": 0x08,
    "delete": 0x2E,
    "del": 0x2E,
    "insert": 0x2D,
    "space": 0x20,
    "up": 0x26,
    "arrowup": 0x26,
    "down": 0x28,
    "arrowdown": 0x28,
    "left": 0x25,
    "arrowleft": 0x25,
    "right": 0x27,
    "arrowright": 0x27,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pgup": 0x21,
    "pagedown": 0x22,
    "pgdn": 0x22,
    "capslock": 0x14,
    "printscreen": 0x2C,
    "contextmenu": 0x5D,
    "menu": 0x5D,
    "plus": 0xBB,
    "equal": 0xBB,
    "minus": 0xBD,
    "comma": 0xBC,
    "period": 0xBE,
    "slash": 0xBF,
    "backslash": 0xDC,
    "semicolon": 0xBA,
    "quote": 0xDE,
    "backquote": 0xC0,
    "bracketleft": 0xDB,
    "bracketright": 0xDD,
}
PUNCTUATION = {
    "-": "minus",
    "=": "equal",
    ",": "comma",
    ".": "period",
    "/": "slash",
    "\\": "backslash",
    ";": "semicolon",
    "'": "quote",
    "`": "backquote",
    "[": "bracketleft",
    "]": "bracketright",
}
EXTENDED_VK = {0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x5B, 0x5C, 0x5D, 0x2C}


def parse_keys(value: str) -> tuple[list[int], int | None]:
    """Purpose: Parse "ctrl+shift+t". Input: shortcut. Output: modifier VKs and main VK."""
    text = str(value or "").strip()
    if not text or len(text) > 60:
        raise HostError("快捷键不能为空，且不超过 60 个字符。")
    parts = [part.strip() for part in text.replace("++", "+plus").split("+") if part.strip()]
    modifiers: list[int] = []
    key: int | None = None
    for part in parts:
        lower = part.lower()
        if lower in MODIFIER_VK:
            if MODIFIER_VK[lower] not in modifiers:
                modifiers.append(MODIFIER_VK[lower])
            continue
        if key is not None:
            raise HostError(f"一个快捷键只能包含一个主键：{text}")
        if part in PUNCTUATION:
            lower = PUNCTUATION[part]
        if lower in NAMED_VK:
            key = NAMED_VK[lower]
        elif len(part) == 1 and part.isalnum() and part.isascii():
            key = ord(part.upper())
        elif lower.startswith("f") and lower[1:].isdigit() and 1 <= int(lower[1:]) <= 24:
            key = 0x6F + int(lower[1:])
        else:
            raise HostError(f"不支持的按键：{part}")
    if key is None and not modifiers:
        raise HostError(f"无法识别的快捷键：{text}")
    return modifiers, key


# --- Win32 access ---------------------------------------------------------------------------


@dataclass
class Monitor:
    index: int
    device: str
    rect: tuple[int, int, int, int]
    work: tuple[int, int, int, int]
    primary: bool
    dpi: int
    handle: int = 0


class PhysicalActivity:
    """Count physical hook events without recording keys, text or pointer positions."""

    def __init__(self):
        """Purpose: Initialize activity tracking. Input: none. Output: zeroed event count."""
        self.count = 0

    def observe(self, flags: int, keyboard: bool):
        """Purpose: Exclude AI input. Input: hook flags/type. Output: event count."""
        injected = 0x10 if keyboard else 0x01  # LLKHF_INJECTED / LLMHF_INJECTED
        if not flags & injected:
            self.count += 1


class Win32:
    """Thin ctypes wrapper; every method expects per-monitor DPI awareness (see ``dpi_aware``)."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        self.ctypes, self.wintypes = ctypes, wintypes
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.shcore = ctypes.WinDLL("shcore")
        self.dwmapi = ctypes.WinDLL("dwmapi")
        user32 = self.user32
        user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.WindowFromPoint.restype = wintypes.HWND
        user32.WindowFromPoint.argtypes = [wintypes.POINT]
        user32.GetAncestor.restype = wintypes.HWND
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.MonitorFromWindow.restype = wintypes.HMONITOR
        user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        user32.IsWindowVisible.argtypes = [wintypes.HWND]
        user32.IsIconic.argtypes = [wintypes.HWND]
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.BringWindowToTop.argtypes = [wintypes.HWND]
        user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        user32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.MapVirtualKeyW.restype = wintypes.UINT
        self.dwmapi.DwmGetWindowAttribute.argtypes = [
            wintypes.HWND,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]

        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [
                ("dx", wintypes.LONG),
                ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ("wVk", wintypes.WORD),
                ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        class HARDWAREINPUT(ctypes.Structure):
            _fields_ = [
                ("uMsg", wintypes.DWORD),
                ("wParamL", wintypes.WORD),
                ("wParamH", wintypes.WORD),
            ]

        class UNION(ctypes.Union):
            _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("u", UNION)]

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        class MONITORINFOEXW(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
                ("szDevice", wintypes.WCHAR * 32),
            ]

        self.INPUT, self.MOUSEINPUT, self.KEYBDINPUT = INPUT, MOUSEINPUT, KEYBDINPUT
        self.LASTINPUTINFO, self.MONITORINFOEXW = LASTINPUTINFO, MONITORINFOEXW
        user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFOEXW)]
        self._physical_activity = PhysicalActivity()
        self._activity_thread = None
        self._activity_ready = threading.Event()
        self._activity_error = ""
        self._activity_thread_id = None

    def user_activity(self) -> int:
        """Purpose: Track genuine user activity. Input: none. Output: physical event generation."""
        if self._activity_thread is None:
            self._activity_thread = threading.Thread(
                target=self._monitor_activity, daemon=True, name="cleo-user-input"
            )
            self._activity_thread.start()
        if (
            not self._activity_ready.wait(3)
            or self._activity_error
            or not self._activity_thread.is_alive()
        ):
            raise HostError("无法监听用户鼠标键盘活动，本机输入已拒绝；请重新启动 Cleo。")
        return self._physical_activity.count

    def _monitor_activity(self):
        """Purpose: Run nonblocking input hooks. Input: Win32 API. Output: physical-only counter."""
        ctypes, wintypes, user32 = self.ctypes, self.wintypes, self.user32
        hooks = []
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentThreadId.restype = wintypes.DWORD
            kernel32.GetModuleHandleW.restype = wintypes.HMODULE
            kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
            self._activity_thread_id = kernel32.GetCurrentThreadId()
            callback_type = ctypes.WINFUNCTYPE(
                ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
            )

            class KeyboardEvent(ctypes.Structure):
                _fields_ = [
                    ("vkCode", wintypes.DWORD),
                    ("scanCode", wintypes.DWORD),
                    ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD),
                    ("extra", ctypes.c_size_t),
                ]

            class MouseEvent(ctypes.Structure):
                _fields_ = [
                    ("point", wintypes.POINT),
                    ("data", wintypes.DWORD),
                    ("flags", wintypes.DWORD),
                    ("time", wintypes.DWORD),
                    ("extra", ctypes.c_size_t),
                ]

            user32.SetWindowsHookExW.argtypes = [
                ctypes.c_int,
                callback_type,
                wintypes.HMODULE,
                wintypes.DWORD,
            ]
            user32.SetWindowsHookExW.restype = wintypes.HANDLE
            user32.CallNextHookEx.argtypes = [
                wintypes.HANDLE,
                ctypes.c_int,
                wintypes.WPARAM,
                wintypes.LPARAM,
            ]
            user32.CallNextHookEx.restype = ctypes.c_ssize_t
            user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
            user32.GetMessageW.argtypes = [
                ctypes.POINTER(wintypes.MSG),
                wintypes.HWND,
                wintypes.UINT,
                wintypes.UINT,
            ]
            user32.PeekMessageW.argtypes = [
                ctypes.POINTER(wintypes.MSG),
                wintypes.HWND,
                wintypes.UINT,
                wintypes.UINT,
                wintypes.UINT,
            ]
            user32.PostThreadMessageW.argtypes = [
                wintypes.DWORD,
                wintypes.UINT,
                wintypes.WPARAM,
                wintypes.LPARAM,
            ]

            def keyboard(code, message, pointer):
                """Purpose: Count keyboard activity. Input: hook event. Output: next hook result."""
                if code == 0:
                    self._physical_activity.observe(
                        ctypes.cast(pointer, ctypes.POINTER(KeyboardEvent)).contents.flags, True
                    )
                return user32.CallNextHookEx(None, code, message, pointer)

            def mouse(code, message, pointer):
                """Purpose: Observe mouse activity. Input: hook event. Output: next hook result."""
                if code == 0:
                    self._physical_activity.observe(
                        ctypes.cast(pointer, ctypes.POINTER(MouseEvent)).contents.flags, False
                    )
                return user32.CallNextHookEx(None, code, message, pointer)

            # Keep callbacks alive on this thread and always forward events; input is never blocked.
            callbacks = [callback_type(keyboard), callback_type(mouse)]
            module = kernel32.GetModuleHandleW(None)
            # WH_KEYBOARD_LL and WH_MOUSE_LL.
            for kind, callback in zip((13, 14), callbacks, strict=True):
                hook = user32.SetWindowsHookExW(kind, callback, module, 0)
                if not hook:
                    raise HostError("用户活动监听注册失败。")
                hooks.append(hook)
            message = wintypes.MSG()
            # Ensure PostThreadMessage can address this thread even during immediate shutdown.
            user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
            self._activity_ready.set()
            while True:
                result = user32.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result == 0:
                    break
                if result == -1:
                    raise HostError("用户活动监听已中断。")
        except Exception as error:
            self._activity_error = str(error)
        finally:
            for hook in hooks:
                user32.UnhookWindowsHookEx(hook)
            self._activity_ready.set()

    def close_activity_monitor(self):
        """Purpose: Release exit-time hooks. Input: none. Output: stopped monitor thread."""
        if self._activity_thread_id is not None:
            self.user32.PostThreadMessageW(self._activity_thread_id, 0x0012, 0, 0)  # WM_QUIT
        if self._activity_thread is not None:
            self._activity_thread.join(timeout=1)

    @contextlib.contextmanager
    def dpi_aware(self):
        previous = self.user32.SetThreadDpiAwarenessContext(self.ctypes.c_void_p(-4))
        try:
            yield
        finally:
            if previous:
                self.user32.SetThreadDpiAwarenessContext(self.ctypes.c_void_p(previous))

    def monitors(self) -> list[Monitor]:
        ctypes, wintypes = self.ctypes, self.wintypes
        found = []
        callback_type = ctypes.WINFUNCTYPE(
            wintypes.BOOL,
            wintypes.HMONITOR,
            wintypes.HDC,
            ctypes.POINTER(wintypes.RECT),
            wintypes.LPARAM,
        )

        def collect(handle, _dc, _rect, _data):
            info = self.MONITORINFOEXW()
            info.cbSize = ctypes.sizeof(info)
            if self.user32.GetMonitorInfoW(handle, ctypes.byref(info)):
                dpi_x, dpi_y = wintypes.UINT(96), wintypes.UINT(96)
                self.shcore.GetDpiForMonitor(handle, 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y))
                monitor, work = info.rcMonitor, info.rcWork
                found.append(
                    Monitor(
                        len(found),
                        info.szDevice,
                        (monitor.left, monitor.top, monitor.right, monitor.bottom),
                        (work.left, work.top, work.right, work.bottom),
                        bool(info.dwFlags & 1),
                        int(dpi_x.value),
                        int(handle or 0),
                    )
                )
            return True

        self.user32.EnumDisplayMonitors(None, None, callback_type(collect), 0)
        found.sort(key=lambda item: (not item.primary, item.rect[0], item.rect[1]))
        for index, item in enumerate(found):
            item.index = index
        return found

    def grab(self, box):
        from PIL import ImageGrab

        return ImageGrab.grab(bbox=box, all_screens=True).convert("RGB")

    def cursor(self) -> tuple[int, int]:
        point = self.wintypes.POINT()
        self.user32.GetCursorPos(self.ctypes.byref(point))
        return point.x, point.y

    def last_input(self) -> int:
        info = self.LASTINPUTINFO()
        info.cbSize = self.ctypes.sizeof(info)
        self.user32.GetLastInputInfo(self.ctypes.byref(info))
        return int(info.dwTime)

    def _send(self, *items):
        array = (self.INPUT * len(items))(*items)
        sent = self.user32.SendInput(len(items), array, self.ctypes.sizeof(self.INPUT))
        if sent != len(items):
            raise HostError(
                "系统拒绝了输入（可能是目标窗口以管理员权限运行，或正在显示安全桌面）。"
            )

    def _mouse(self, flags, dx=0, dy=0, data=0):
        item = self.INPUT(type=0)
        item.u.mi = self.MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)
        return item

    def move(self, x: int, y: int):
        """Purpose: Move via injected input. Input: screen pixels. Output: cursor movement."""
        left, top = self.user32.GetSystemMetrics(76), self.user32.GetSystemMetrics(77)
        width, height = self.user32.GetSystemMetrics(78), self.user32.GetSystemMetrics(79)
        # Target the center of the normalized pixel bin. Avoid SetCursorPos, whose events
        # do not carry SendInput's injected flag and would be mistaken for user activity.
        dx = min(65535, round((x - left + 0.5) * 65536 / max(1, width)))
        dy = min(65535, round((y - top + 0.5) * 65536 / max(1, height)))
        self._send(self._mouse(0x0001 | 0x8000 | 0x4000, dx, dy))

    def button(self, name: str, down: bool):
        flags = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}[
            name
        ]
        self._send(self._mouse(flags[0] if down else flags[1]))

    def wheel(self, delta: int, horizontal: bool):
        self._send(self._mouse(0x1000 if horizontal else 0x0800, data=delta))

    def key(self, vk: int, down: bool):
        item = self.INPUT(type=1)
        flags = (0 if down else 0x0002) | (0x0001 if vk in EXTENDED_VK else 0)
        item.u.ki = self.KEYBDINPUT(vk, self.user32.MapVirtualKeyW(vk, 0), flags, 0, 0)
        self._send(item)

    def unicode(self, units: list[int]):
        items = []
        for unit in units:
            for flags in (0x0004, 0x0004 | 0x0002):
                item = self.INPUT(type=1)
                item.u.ki = self.KEYBDINPUT(0, unit, flags, 0, 0)
                items.append(item)
        self._send(*items)

    def _pid(self, hwnd) -> int:
        pid = self.wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd, self.ctypes.byref(pid))
        return int(pid.value)

    def _title(self, hwnd) -> str:
        length = self.user32.GetWindowTextLengthW(hwnd)
        buffer = self.ctypes.create_unicode_buffer(length + 1)
        self.user32.GetWindowTextW(hwnd, buffer, length + 1)
        return buffer.value

    def pid_at(self, x: int, y: int) -> int:
        hwnd = self.user32.WindowFromPoint(self.wintypes.POINT(x, y))
        root = self.user32.GetAncestor(hwnd, 2) if hwnd else None
        return self._pid(root) if root else 0

    def foreground(self) -> dict:
        hwnd = self.user32.GetForegroundWindow()
        if not hwnd:
            return {"hwnd": 0, "pid": 0, "title": "", "monitor": 0}
        return {
            "hwnd": int(hwnd),
            "pid": self._pid(hwnd),
            "title": self._title(hwnd),
            "monitor": int(self.user32.MonitorFromWindow(hwnd, 2) or 0),
        }

    def windows(self) -> list[dict]:
        ctypes, wintypes = self.ctypes, self.wintypes
        found = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def collect(hwnd, _data):
            if (
                len(found) >= 40
                or not self.user32.IsWindowVisible(hwnd)
                or self.user32.IsIconic(hwnd)
            ):
                return True
            title = self._title(hwnd)
            style = self.user32.GetWindowLongPtrW(hwnd, -20)
            if not title or (style & 0x80 and not style & 0x40000):
                return True
            cloaked = wintypes.INT()
            self.dwmapi.DwmGetWindowAttribute(
                hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)
            )
            if cloaked.value:
                return True
            rect = wintypes.RECT()
            if self.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)):
                self.user32.GetWindowRect(hwnd, ctypes.byref(rect))
            found.append(
                {
                    "hwnd": int(hwnd),
                    "title": title[:120],
                    "pid": self._pid(hwnd),
                    "rect": (rect.left, rect.top, rect.right, rect.bottom),
                }
            )
            return True

        self.user32.EnumWindows(callback_type(collect), 0)
        return found

    def activate(self, hwnd: int) -> bool:
        if self.user32.IsIconic(hwnd):
            self.user32.ShowWindow(hwnd, 9)
        # A synthetic Alt press lets a background process move the foreground (documented rule).
        self.key(0x12, True)
        self.key(0x12, False)
        self.user32.SetForegroundWindow(hwnd)
        self.user32.BringWindowToTop(hwnd)
        return int(self.user32.GetForegroundWindow() or 0) == hwnd


class HostController:
    """Serializes local actions; stop cancels between input steps and releases held input."""

    def __init__(self, api=None, platform: str = sys.platform, sleep=time.sleep):
        self.platform = platform
        self._api = api
        self._sleep = sleep
        self._lock = threading.Lock()
        # Each stop starts a new generation; operations from an older generation never run.
        self._generation = 0
        self._active = 0
        self._keys: list[int] = []
        self._buttons: list[str] = []
        self._activity_baseline: dict | None = None
        self._pending_user_activity = False

    @property
    def api(self):
        if self.platform != "win32":
            raise HostError("本机电脑模式目前仅支持 Windows。")
        if self._api is None:
            self._api = Win32()
        return self._api

    async def run(self, op: str, arguments: dict) -> dict:
        return await asyncio.to_thread(self._run, op, arguments or {})

    async def stop(self, reason: str = "stop") -> dict:
        return await asyncio.to_thread(self._stop, reason)

    def _run(self, op: str, args: dict) -> dict:
        """Purpose: Serialize guarded actions. Input: operation/args. Output: result or pause."""
        api = self.api
        generation = self._generation
        if not self._lock.acquire(timeout=30):
            raise HostError("本机控制正忙，请稍后重试。")
        try:
            self._active = generation
            with api.dpi_aware():
                if op == "mark":
                    # Only explicit user handback acknowledges activity. A new screenshot
                    # cannot silently erase an interruption that still requires takeover.
                    self._pending_user_activity = False
                    self._activity_baseline = self._baseline()
                    return {"baseline": self._activity_baseline}
                self._activity_baseline = (
                    args.get("baseline") or self._activity_baseline or self._baseline()
                )
                self._checkpoint()
                if op == "screenshot":
                    result = self._screenshot(args)
                    self._checkpoint()
                    self._activity_baseline = result["baseline"]
                    return result
                handler = {
                    "click": self._click,
                    "move": self._move,
                    "drag": self._drag,
                    "scroll": self._scroll,
                    "type": self._type,
                    "key": self._key,
                    "launch": self._launch,
                    "switch": self._switch,
                }.get(op)
                if handler is None:
                    raise HostError(f"不支持的本机操作：{op}")
                self._check_signature(args)
                detail = handler(args)
                self._sleep(0.05)
                self._checkpoint()
                self._activity_baseline = self._baseline()
                return {"baseline": self._activity_baseline, "detail": detail or ""}
        except UserActivity:
            self._release()
            return {"user_activity": True}
        finally:
            self._lock.release()

    def _stop(self, reason: str) -> dict:
        """Purpose: Release AI input. Input: stop reason. Output: release and settlement."""
        self._generation += 1
        acquired = self._lock.acquire(timeout=3)
        try:
            released = self._release()
        finally:
            if acquired:
                self._lock.release()
        if reason == "exit" and self._api is not None:
            close = getattr(self._api, "close_activity_monitor", None)
            if close is not None:
                close()
        return {"stopped": True, "released": released, "settled": acquired}

    def _release(self) -> list[str]:
        if self.platform != "win32" or self._api is None:
            return []
        released = []
        with self._api.dpi_aware():
            for vk in reversed(self._keys):
                with contextlib.suppress(Exception):
                    self._api.key(vk, False)
                released.append(f"key:{vk:#04x}")
            for name in reversed(self._buttons):
                with contextlib.suppress(Exception):
                    self._api.button(name, False)
                released.append(f"mouse:{name}")
        self._keys.clear()
        self._buttons.clear()
        return released

    def _checkpoint(self):
        """Purpose: Guard further input. Input: current guards. Output: exception on pause."""
        if self._generation != self._active:
            raise HostError("本机操作已停止。")
        if self._pending_user_activity or self._user_active(self._activity_baseline):
            self._pending_user_activity = True
            raise UserActivity("检测到用户输入，本机操作已暂停。")

    # --- observation --------------------------------------------------------------------------

    def _signature(self, monitors: list[Monitor]) -> str:
        text = ";".join(f"{m.rect}:{m.dpi}:{m.primary}" for m in monitors)
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    def _check_signature(self, args: dict):
        expected = args.get("signature")
        if expected and expected != self._signature(self.api.monitors()):
            raise HostError("显示器布局、分辨率或缩放已变化，坐标已过期。请重新截图。")

    def _baseline(self) -> dict:
        """Purpose: Observe activity. Input: Win32 state. Output: baseline excluding AI input."""
        return {
            "tick": self.api.last_input(),
            "cursor": list(self.api.cursor()),
            "activity": self.api.user_activity(),
        }

    def _user_active(self, baseline) -> bool:
        """Purpose: Detect user input. Input: prior baseline. Output: activity since baseline."""
        if not isinstance(baseline, dict):
            return False
        if "activity" in baseline:
            return self.api.user_activity() != baseline["activity"]
        cursor = self.api.cursor()
        expected = baseline.get("cursor") or cursor
        moved = abs(cursor[0] - expected[0]) > 3 or abs(cursor[1] - expected[1]) > 3
        return moved or self.api.last_input() != baseline.get("tick")

    def _screenshot(self, args: dict) -> dict:
        monitors = self.api.monitors()
        if not monitors:
            raise HostError("没有找到可用的显示器。")
        display = args.get("display")
        foreground = self.api.foreground()
        if display == "all":
            box = (
                min(m.rect[0] for m in monitors),
                min(m.rect[1] for m in monitors),
                max(m.rect[2] for m in monitors),
                max(m.rect[3] for m in monitors),
            )
            label = "all"
        else:
            if isinstance(display, int) and not isinstance(display, bool):
                if not 0 <= display < len(monitors):
                    raise HostError(f"没有序号为 {display} 的显示器（共 {len(monitors)} 个）。")
                chosen = monitors[display]
            else:
                chosen = next(
                    (m for m in monitors if m.handle and m.handle == foreground["monitor"]),
                    monitors[0],
                )
            box, label = chosen.rect, chosen.index
        width, height = box[2] - box[0], box[3] - box[1]
        scale = min(1.0, MAX_EDGE / max(width, height))
        image_width, image_height = max(1, round(width * scale)), max(1, round(height * scale))
        image = self.api.grab(box)
        if image.size != (image_width, image_height):
            from PIL import Image

            image = image.resize((image_width, image_height), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=False)
        sx, sy = width / image_width, height / image_height

        def to_image(x, y):
            return [round((x - box[0]) / sx), round((y - box[1]) / sy)]

        def rect_to_image(rect):
            left, top = to_image(max(rect[0], box[0]), max(rect[1], box[1]))
            right, bottom = to_image(min(rect[2], box[2]), min(rect[3], box[3]))
            return [left, top, right, bottom] if right > left and bottom > top else None

        windows = []
        for window in self.api.windows():
            rect = rect_to_image(window["rect"])
            if rect is None:
                continue
            windows.append(
                {
                    "title": window["title"],
                    "rect": rect,
                    "foreground": window["hwnd"] == foreground["hwnd"],
                }
            )
            if len(windows) >= 20:
                break
        cursor_x, cursor_y = self.api.cursor()
        cursor = (
            to_image(cursor_x, cursor_y)
            if box[0] <= cursor_x < box[2] and box[1] <= cursor_y < box[3]
            else None
        )
        displays = [
            {
                "display": m.index,
                "primary": m.primary,
                "scale": round(m.dpi / 96, 2),
                "rect_in_image": rect_to_image(m.rect),
                "captured": label in ("all", m.index),
            }
            for m in monitors
        ]
        return {
            "image": base64.b64encode(output.getvalue()).decode("ascii"),
            "width": image_width,
            "height": image_height,
            "display": label,
            "transform": {"x": box[0], "y": box[1], "sx": sx, "sy": sy},
            "displays": displays,
            "windows": windows,
            "cursor": cursor,
            "foreground": foreground["title"][:120],
            "signature": self._signature(monitors),
            "baseline": self._baseline(),
        }

    # --- input --------------------------------------------------------------------------------

    def _point(self, args: dict, prefix: str = "") -> tuple[int, int]:
        try:
            x, y = int(args[f"{prefix}x"]), int(args[f"{prefix}y"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HostError("坐标无效。") from exc
        if not any(
            m.rect[0] <= x < m.rect[2] and m.rect[1] <= y < m.rect[3] for m in self.api.monitors()
        ):
            raise HostError("坐标不在任何显示器范围内，请重新截图。")
        return x, y

    def _guard_point(self, args: dict, x: int, y: int):
        protected = {int(pid) for pid in args.get("protected_pids") or [] if isinstance(pid, int)}
        if protected and self.api.pid_at(x, y) in protected:
            raise HostError("目标位置是 Cleo 自身的窗口或状态条，本机控制不能操作 Cleo。")

    def _guard_foreground(self, args: dict):
        protected = {int(pid) for pid in args.get("protected_pids") or [] if isinstance(pid, int)}
        if protected and self.api.foreground()["pid"] in protected:
            raise HostError("当前前台窗口是 Cleo，本机控制不会向 Cleo 输入。请先切换到目标应用。")

    def _press_button(self, name: str):
        self._buttons.append(name)
        self.api.button(name, True)

    def _release_button(self, name: str):
        self.api.button(name, False)
        if name in self._buttons:
            self._buttons.remove(name)

    def _click(self, args: dict):
        x, y = self._point(args)
        self._guard_point(args, x, y)
        button = args.get("button", "left")
        if button not in ("left", "right", "middle"):
            raise HostError("button 无效。")
        clicks = args.get("clicks", 1)
        if clicks not in (1, 2):
            raise HostError("clicks 只能是 1 或 2。")
        self.api.move(x, y)
        for index in range(clicks):
            self._checkpoint()
            self._press_button(button)
            self._release_button(button)
            if index + 1 < clicks:
                self._sleep(0.06)

    def _move(self, args: dict):
        x, y = self._point(args)
        self.api.move(x, y)

    def _drag(self, args: dict):
        start = self._point(args, "from_")
        end = self._point(args, "to_")
        self._guard_point(args, *start)
        self._guard_point(args, *end)
        self.api.move(*start)
        self._press_button("left")
        try:
            steps = 20
            for step in range(1, steps + 1):
                self._checkpoint()
                self.api.move(
                    round(start[0] + (end[0] - start[0]) * step / steps),
                    round(start[1] + (end[1] - start[1]) * step / steps),
                )
                self._sleep(0.015)
        finally:
            if "left" in self._buttons:
                self._release_button("left")

    def _scroll(self, args: dict):
        x, y = self._point(args)
        self._guard_point(args, x, y)
        direction = args.get("direction")
        if direction not in ("up", "down", "left", "right"):
            raise HostError("direction 无效。")
        amount = args.get("amount", 3)
        if not isinstance(amount, int) or not 1 <= amount <= 20:
            raise HostError("amount 必须在 1–20 之间。")
        self.api.move(x, y)
        for _ in range(amount):
            self._checkpoint()
            if direction in ("up", "down"):
                self.api.wheel(120 if direction == "up" else -120, False)
            else:
                self.api.wheel(120 if direction == "right" else -120, True)
            self._sleep(0.02)

    def _press_combo(self, modifiers: list[int], key: int | None):
        pressed = []
        try:
            for vk in modifiers:
                self._checkpoint()
                self._keys.append(vk)
                pressed.append(vk)
                self.api.key(vk, True)
            if key is not None:
                self._checkpoint()
                self._keys.append(key)
                self.api.key(key, True)
                self.api.key(key, False)
                self._keys.remove(key)
        finally:
            for vk in reversed(pressed):
                with contextlib.suppress(Exception):
                    self.api.key(vk, False)
                if vk in self._keys:
                    self._keys.remove(vk)

    def _type_text(self, text: str):
        units: list[int] = []

        def flush():
            if units:
                self._checkpoint()
                self.api.unicode(list(units))
                units.clear()
                self._sleep(0.004)

        for char in text:
            if char == "\r":
                continue
            if char in "\n\t":
                flush()
                self._press_combo([], 0x0D if char == "\n" else 0x09)
                continue
            encoded = char.encode("utf-16-le")
            units.extend(
                int.from_bytes(encoded[i : i + 2], "little") for i in range(0, len(encoded), 2)
            )
            if len(units) >= TYPE_BATCH:
                flush()
        flush()

    def _type(self, args: dict):
        text = args.get("text")
        if not isinstance(text, str) or len(text) > 20000:
            raise HostError("text 无效。")
        self._guard_foreground(args)
        self._type_text(text)

    def _key(self, args: dict):
        self._guard_foreground(args)
        self._press_combo(*parse_keys(args.get("keys", "")))

    def _launch(self, args: dict):
        name = args.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise HostError("应用名称无效。")
        self._press_combo([MODIFIER_VK["win"]], None)
        self._sleep(0.8)
        self._checkpoint()
        self._type_text(name.strip())
        self._sleep(1.0)
        self._checkpoint()
        self._press_combo([], 0x0D)
        return f"已通过开始菜单搜索启动“{name.strip()}”；请截图确认应用是否已打开。"

    def _switch(self, args: dict):
        name = args.get("name")
        if not isinstance(name, str) or not name.strip():
            raise HostError("窗口名称无效。")
        protected = {int(pid) for pid in args.get("protected_pids") or [] if isinstance(pid, int)}
        needle = name.strip().casefold()
        for window in self.api.windows():
            if window["pid"] in protected or needle not in window["title"].casefold():
                continue
            if not self.api.activate(window["hwnd"]):
                raise HostError(f"系统没有允许切换到“{window['title']}”，请截图后点击该窗口。")
            return f"已切换到窗口“{window['title']}”。"
        raise HostError(f"没有找到标题包含“{name.strip()}”的窗口。")


_controller: HostController | None = None


def controller() -> HostController:
    global _controller
    if _controller is None:
        _controller = HostController()
    return _controller
