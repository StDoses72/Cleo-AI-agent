from __future__ import annotations

import asyncio
import inspect
import re
from pathlib import Path

import pytest

from cleo.desktop.rpc import RpcMethod, RpcRegistry, wire_error
from cleo.desktop.service import DesktopService

ELECTRON = Path(__file__).resolve().parents[2] / "ui" / "electron"


def _allowed_methods() -> set[str]:
    source = (ELECTRON / "main.mjs").read_text(encoding="utf-8")
    block = re.search(r"const allowedMethods = new Set\(\[(.*?)\]\);", source, re.S)
    assert block, "allowedMethods not found in ui/electron/main.mjs"
    return set(re.findall(r'"([a-z_]+)"', block.group(1)))


def _main_process_calls() -> set[str]:
    names: set[str] = set()
    for path in ELECTRON.rglob("*.mjs"):
        if path.name.endswith(".test.mjs"):
            continue
        source = path.read_text(encoding="utf-8")
        names.update(re.findall(r'\.request\(\s*"([a-z_]+)"', source))
        names.update(re.findall(r'#send\(\s*\w+,\s*"([a-z_]+)"', source))
    return names


def test_registry_serves_exactly_the_public_service_methods() -> None:
    public = {name for name, member in inspect.getmembers(DesktopService)
              if not name.startswith("_") and inspect.iscoroutinefunction(member)}
    assert set(RpcRegistry().names()) == public


def test_renderer_methods_match_the_electron_allow_list() -> None:
    assert set(RpcRegistry().names("renderer")) == _allowed_methods()


def test_main_process_calls_are_registered_and_unused_methods_are_unused() -> None:
    registry = RpcRegistry()
    calls = _main_process_calls()
    assert calls <= set(registry.names())
    assert set(registry.names("main")) <= calls
    assert not set(registry.names("unused")) & (calls | _allowed_methods())


def test_dispatch_rejects_unknown_private_and_missing_handlers() -> None:
    class Target:
        async def load_workspace(self):
            return {"ok": True}

        async def _thread(self):
            raise AssertionError("private methods are never served")

    async def emit(_event):
        return None

    registry = RpcRegistry()
    assert asyncio.run(registry.dispatch(Target(), "load_workspace", {}, emit)) == {"ok": True}
    for name in ("no_such_method", "_thread", "load_memory", "shutdown"):
        with pytest.raises(ValueError, match=f"^unsupported desktop method: {name}$"):
            asyncio.run(registry.dispatch(Target(), name, {}, emit))
    with pytest.raises(TypeError):
        asyncio.run(registry.dispatch(Target(), "load_workspace", {"surprise": True}, emit))


def test_streaming_methods_receive_emit_and_reply_with_null() -> None:
    events = []

    class Target:
        async def stream_turn(self, *, emit, thread_id):
            await emit({"thread": thread_id})
            return "ignored"

    async def emit(event):
        events.append(event)

    result = asyncio.run(RpcRegistry().dispatch(Target(), "stream_turn", {"thread_id": "t"}, emit))
    assert result is None
    assert events == [{"thread": "t"}]


def test_registry_rejects_duplicate_names_and_maps_errors_by_class_name() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        RpcRegistry([RpcMethod("a", "main"), RpcMethod("a", "renderer")])
    assert wire_error(FileNotFoundError("gone")) == {"name": "FileNotFoundError",
                                                     "message": "gone"}
