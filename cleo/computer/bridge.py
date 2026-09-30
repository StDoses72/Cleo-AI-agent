"""Client for the desktop app's computer broker (built-in browser and local computer).

The broker runs in Cleo's Electron process. Its address and random token are in a descriptor
file readable only by the current user; ``CLEO_COMPUTER_BRIDGE`` (or ``--bridge``) names that
file. One connection carries one request, and closing it cancels the request.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

ENVIRONMENT = "CLEO_COMPUTER_BRIDGE"
# Long enough for a user takeover (10 minutes) or an authorization prompt, plus margin.
REQUEST_TIMEOUT = 11 * 60
UNAVAILABLE = (
    "电脑操作需要在运行中的 Cleo 桌面应用里使用：内置浏览器和本机电脑模式由桌面应用提供。"
    "请在 Cleo 桌面应用中发送任务；普通聊天不受影响。"
)


class BridgeError(Exception):
    """The broker rejected the request or could not be reached; nothing was done."""


def descriptor_path(explicit: str | Path | None = None) -> Path | None:
    value = explicit or os.environ.get(ENVIRONMENT)
    return Path(value) if value else None


def read_descriptor(path: Path | None) -> dict:
    if path is None:
        raise BridgeError(UNAVAILABLE)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BridgeError(UNAVAILABLE) from exc
    if (
        not isinstance(data, dict)
        or data.get("version") != 1
        or not data.get("address")
        or not data.get("token")
    ):
        raise BridgeError(UNAVAILABLE)
    return data


async def _open(descriptor: dict):
    limit = 64 * 1024 * 1024
    address = str(descriptor["address"])
    if descriptor.get("transport") == "unix":
        return await asyncio.open_unix_connection(address, limit=limit)
    if sys.platform != "win32":
        raise BridgeError(UNAVAILABLE)
    loop = asyncio.get_running_loop()
    if not hasattr(loop, "create_pipe_connection"):
        raise BridgeError("当前事件循环不支持本地管道，无法连接 Cleo 桌面应用。")
    for attempt in range(40):
        reader = asyncio.StreamReader(limit=limit)
        protocol = asyncio.StreamReaderProtocol(reader)
        try:
            transport, _ = await loop.create_pipe_connection(
                lambda protocol=protocol: protocol, address
            )
        except FileNotFoundError as exc:
            raise BridgeError(UNAVAILABLE) from exc
        except OSError as exc:
            # ERROR_PIPE_BUSY: every server instance is momentarily in use.
            if getattr(exc, "winerror", None) == 231 and attempt < 39:
                await asyncio.sleep(0.05)
                continue
            raise BridgeError(UNAVAILABLE) from exc
        return reader, asyncio.StreamWriter(transport, protocol, reader, loop)
    raise BridgeError(UNAVAILABLE)


async def request(
    payload: dict, *, bridge: str | Path | None = None, timeout: float = REQUEST_TIMEOUT
) -> list[dict]:
    """Purpose: Send one tools/call request. Input: operation payload. Output: content blocks."""
    descriptor = read_descriptor(descriptor_path(bridge))
    message = {**payload, "token": descriptor["token"], "id": secrets.token_hex(8)}
    reader, writer = await _open(descriptor)
    try:
        writer.write((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (OSError, RuntimeError):
            pass
    if not line:
        raise BridgeError("Cleo 桌面应用中断了电脑操作连接，操作结果未知。请重新截图确认。")
    reply = json.loads(line)
    if not reply.get("ok"):
        raise BridgeError(str(reply.get("error") or "电脑操作失败。"))
    content = reply.get("content")
    if not isinstance(content, list):
        raise BridgeError("电脑操作返回了无效结果。")
    return content
