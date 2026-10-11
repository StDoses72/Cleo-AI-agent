"""Local Windows controller logic with a fake Win32 layer (never touches the real desktop)."""

import asyncio
import base64
import io
from contextlib import contextmanager

import pytest
from PIL import Image

from cleo.computer.host import HostController, HostError, Monitor, Win32, parse_keys


class FakeApi:
    def __init__(self):
        self.events = []
        self.monitors_list = [
            Monitor(0, r"\\.\DISPLAY1", (0, 0, 3840, 2160), (0, 0, 3840, 2088), True, 144, 1),
            Monitor(1, r"\\.\DISPLAY2", (-1920, 0, 0, 1080), (-1920, 0, 0, 1040), False, 96, 2),
        ]
        self.cursor_position = (100, 100)
        self.tick = 5
        self.user_tick = 0
        self.front = {"hwnd": 10, "pid": 7, "title": "Notepad", "monitor": 1}
        self.owners = {}

    @contextmanager
    def dpi_aware(self):
        yield

    def monitors(self):
        return self.monitors_list

    def grab(self, box):
        return Image.new("RGB", (box[2] - box[0], box[3] - box[1]), "white")

    def cursor(self):
        return self.cursor_position

    def last_input(self):
        return self.tick

    def user_activity(self):
        return self.user_tick

    def _input(self, *event):
        self.events.append(event)
        self.tick += 1

    def move(self, x, y):
        self._input("move", x, y)
        self.cursor_position = (x, y)

    def button(self, name, down):
        self._input("button", name, down)

    def wheel(self, delta, horizontal):
        self._input("wheel", delta, horizontal)

    def key(self, vk, down):
        self._input("key", vk, down)

    def unicode(self, units):
        self._input("unicode", tuple(units))

    def pid_at(self, x, y):
        return self.owners.get((x, y), 99)

    def foreground(self):
        return self.front

    def windows(self):
        return [
            {"hwnd": 10, "title": "Notepad - 无标题", "pid": 7, "rect": (100, 100, 900, 700)},
            {"hwnd": 11, "title": "Cleo", "pid": 42, "rect": (0, 0, 500, 500)},
        ]

    def activate(self, hwnd):
        self._input("activate", hwnd)
        return True


def controller(api=None, sleep=lambda _seconds: None):
    return HostController(api or FakeApi(), platform="win32", sleep=sleep)


def run(host, op, **args):
    return asyncio.run(host.run(op, args))


def test_screenshots_scale_each_display_and_report_physical_transforms():
    host = controller()
    shot = run(host, "screenshot")
    assert (shot["width"], shot["height"], shot["display"]) == (1600, 900, 0)
    assert shot["transform"] == {"x": 0, "y": 0, "sx": 2.4, "sy": 2.4}
    assert Image.open(io.BytesIO(base64.b64decode(shot["image"]))).size == (1600, 900)
    notepad = next(item for item in shot["windows"] if item["title"].startswith("Notepad"))
    assert notepad["rect"] == [42, 42, 375, 292] and notepad["foreground"] is True
    assert shot["cursor"] == [42, 42]
    left = run(host, "screenshot", display=1)
    assert left["transform"]["x"] == -1920 and (left["width"], left["height"]) == (1600, 900)
    everything = run(host, "screenshot", display="all")
    assert everything["transform"]["x"] == -1920 and everything["width"] == 1600
    with pytest.raises(HostError, match="没有序号为 5"):
        run(host, "screenshot", display=5)


def test_input_requires_the_same_display_layout_and_no_user_activity():
    api = FakeApi()
    host = controller(api)
    shot = run(host, "screenshot")
    common = {"signature": shot["signature"], "baseline": shot["baseline"]}
    result = run(host, "click", x=500, y=400, clicks=2, **common)
    assert api.events == [
        ("move", 500, 400),
        ("button", "left", True),
        ("button", "left", False),
        ("button", "left", True),
        ("button", "left", False),
    ]
    assert result["baseline"]["tick"] == api.tick
    api.monitors_list[0].dpi = 96
    with pytest.raises(HostError, match="已变化"):
        run(host, "click", x=1, y=1, **common)
    api.monitors_list[0].dpi = 144
    api.events.clear()
    api.tick += 1  # the user pressed a key after the last AI action
    api.user_tick += 1
    assert run(
        host, "click", x=1, y=1, signature=shot["signature"], baseline=result["baseline"]
    ) == {"user_activity": True}
    api.cursor_position = (900, 900)
    assert run(host, "move", x=1, y=1, baseline={"tick": api.tick, "cursor": [1, 1]}) == {
        "user_activity": True
    }
    assert api.events == []


def test_cleo_windows_and_gaps_between_monitors_are_refused():
    api = FakeApi()
    host = controller(api)
    api.owners[(10, 10)] = 42
    with pytest.raises(HostError, match="Cleo"):
        run(host, "click", x=10, y=10, protected_pids=[42])
    api.front = {"hwnd": 11, "pid": 42, "title": "Cleo", "monitor": 1}
    with pytest.raises(HostError, match="前台窗口是 Cleo"):
        run(host, "type", text="secret", protected_pids=[42])
    with pytest.raises(HostError, match="不在任何显示器"):
        run(host, "click", x=-5000, y=10)
    assert api.events == []


def test_typing_uses_unicode_units_and_real_keys_for_line_breaks():
    api = FakeApi()
    run(controller(api), "type", text="a\n你😀")
    assert api.events == [
        ("unicode", (0x61,)),
        ("key", 0x0D, True),
        ("key", 0x0D, False),
        ("unicode", (0x4F60, 0xD83D, 0xDE00)),
    ]


def test_shortcuts_press_and_release_in_order():
    api = FakeApi()
    host = controller(api)
    run(host, "key", keys="ctrl+shift+t")
    assert api.events == [
        ("key", 0x11, True),
        ("key", 0x10, True),
        ("key", 0x54, True),
        ("key", 0x54, False),
        ("key", 0x10, False),
        ("key", 0x11, False),
    ]
    assert host._keys == []
    assert parse_keys("win") == ([0x5B], None)
    with pytest.raises(HostError):
        parse_keys("ctrl+a+b")
    with pytest.raises(HostError):
        parse_keys("hyper+q")


def test_stop_interrupts_a_drag_and_releases_the_button():
    api = FakeApi()
    steps = []

    def sleep(_seconds):
        steps.append(1)
        if len(steps) == 5:
            host._generation += 1  # what a concurrent stop does first

    host = controller(api, sleep)
    with pytest.raises(HostError, match="已停止"):
        run(host, "drag", from_x=10, from_y=10, to_x=400, to_y=300)
    assert api.events[-1] == ("button", "left", False)
    assert host._buttons == []
    report = asyncio.run(host.stop())
    assert report == {"stopped": True, "released": [], "settled": True}


@pytest.mark.parametrize(
    "op,args",
    [
        ("drag", {"from_x": 10, "from_y": 10, "to_x": 400, "to_y": 300}),
        ("type", {"text": "a" * 500}),
        ("launch", {"name": "Notepad"}),
    ],
)
def test_physical_input_during_an_action_pauses_before_the_next_input(op, args):
    api = FakeApi()
    before_pause = []

    def sleep(_seconds):
        if not before_pause:
            before_pause.append(len(api.events))
            api.user_tick += 1

    host = controller(api, sleep)
    shot = run(host, "screenshot")
    assert run(host, op, baseline=shot["baseline"], **args) == {"user_activity": True}
    assert all(event == ("button", "left", False) for event in api.events[before_pause[0] :])
    assert host._buttons == [] and host._keys == []


def test_screenshots_cannot_acknowledge_user_input_but_explicit_handback_can():
    api = FakeApi()
    host = controller(api)
    run(host, "screenshot")
    api.user_tick += 1
    assert run(host, "screenshot") == {"user_activity": True}
    assert run(host, "screenshot") == {"user_activity": True}
    assert run(host, "move", x=5, y=5) == {"user_activity": True}
    assert api.events == []
    baseline = run(host, "mark")["baseline"]
    run(host, "move", x=5, y=5, baseline=baseline)
    assert api.events == [("move", 5, 5)]


def test_activity_hooks_ignore_injected_events_and_release_on_exit(monkeypatch):
    """Purpose: Verify native hook safety. Input: mocked DLLs. Output: physical events only."""
    import ctypes
    import threading
    from ctypes import wintypes

    class NativeFunction:
        def __init__(self, call=lambda *_args: 0):
            self.call = call

        def __call__(self, *args):
            return self.call(*args)

    class FakeDll:
        def __init__(self):
            self.functions = {}

        def __getattr__(self, name):
            return self.functions.setdefault(name, NativeFunction())

    api, kernel = FakeDll(), FakeDll()
    quit_message = threading.Event()
    callbacks, released = {}, []
    kernel.functions["GetCurrentThreadId"] = NativeFunction(lambda: 123)
    kernel.functions["GetModuleHandleW"] = NativeFunction(lambda _name: 1)
    api.functions["SetWindowsHookExW"] = NativeFunction(
        lambda kind, callback, *_args: callbacks.setdefault(kind, callback) and kind
    )
    api.functions["GetMessageW"] = NativeFunction(lambda *_args: quit_message.wait(5) and 0)
    api.functions["PostThreadMessageW"] = NativeFunction(lambda *_args: quit_message.set() or 1)
    api.functions["UnhookWindowsHookEx"] = NativeFunction(
        lambda handle: released.append(handle) or 1
    )
    monkeypatch.setattr(
        ctypes, "WinDLL", lambda name, **_kwargs: kernel if name == "kernel32" else api,
        raising=False,
    )
    monkeypatch.setattr(ctypes, "WINFUNCTYPE", getattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE),
                        raising=False)

    class KeyboardEvent(ctypes.Structure):
        _fields_ = [
            ("vk", wintypes.DWORD),
            ("scan", wintypes.DWORD),
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

    win32 = Win32()
    try:
        assert win32.user_activity() == 0
        for kind, event in [(13, KeyboardEvent(flags=0x10)), (14, MouseEvent(flags=0x01))]:
            callbacks[kind](0, 0, ctypes.addressof(event))
        assert win32.user_activity() == 0
        for kind, event in [(13, KeyboardEvent()), (14, MouseEvent())]:
            callbacks[kind](0, 0, ctypes.addressof(event))
        assert win32.user_activity() == 2
    finally:
        win32.close_activity_monitor()
    assert released == [13, 14]


def test_injected_input_does_not_pause_a_long_action():
    api = FakeApi()
    host = controller(api)
    shot = run(host, "screenshot")
    result = run(host, "type", text="a" * 500, baseline=shot["baseline"])
    assert result["baseline"]["activity"] == 0
    assert sum(len(event[1]) for event in api.events if event[0] == "unicode") == 500


def test_failed_user_activity_hook_registration_refuses_input(monkeypatch):
    """Purpose: Fail closed on listener errors. Input: fake Win32 worker. Output: no host input."""
    import threading

    win32 = Win32.__new__(Win32)
    win32._activity_thread = None
    win32._activity_ready = threading.Event()
    win32._activity_error = ""

    def failed_monitor():
        win32._activity_error = "hook unavailable"
        win32._activity_ready.set()

    monkeypatch.setattr(win32, "_monitor_activity", failed_monitor)
    with pytest.raises(HostError, match="本机输入已拒绝"):
        win32.user_activity()


def test_stop_releases_only_input_that_cleo_pressed():
    api = FakeApi()
    host = controller(api)
    host._keys.append(0x11)
    host._buttons.append("right")
    report = asyncio.run(host.stop())
    assert report["released"] == ["key:0x11", "mouse:right"]
    assert api.events == [("key", 0x11, False), ("button", "right", False)]


def test_operations_queued_before_a_stop_never_run():
    api = FakeApi()
    host = controller(api)
    generation = host._generation
    asyncio.run(host.stop())
    host._active = generation
    with pytest.raises(HostError, match="已停止"):
        host._checkpoint()
    run(host, "move", x=5, y=5)  # a new request after the stop works normally
    assert api.events == [("move", 5, 5)]


def test_launch_and_switch_are_ui_level_and_skip_cleo():
    api = FakeApi()
    host = controller(api)
    run(host, "launch", name="记事本")
    assert api.events[:2] == [("key", 0x5B, True), ("key", 0x5B, False)]
    assert ("unicode", tuple(ord(char) for char in "记事本")) in api.events
    assert api.events[-2:] == [("key", 0x0D, True), ("key", 0x0D, False)]
    api.events.clear()
    assert "Notepad" in run(host, "switch", name="notepad", protected_pids=[42])["detail"]
    with pytest.raises(HostError, match="没有找到"):
        run(host, "switch", name="Cleo", protected_pids=[42])


def test_unsupported_platform_and_unknown_operations():
    with pytest.raises(HostError, match="仅支持 Windows"):
        asyncio.run(HostController(platform="linux").run("screenshot", {}))
    with pytest.raises(HostError, match="不支持的本机操作"):
        run(controller(), "powershell", command="dir")
