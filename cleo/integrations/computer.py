"""Computer-use tools for every harness: Cleo's built-in browser or the local Windows desktop.

Both built-in targets are served by the running Cleo desktop app (see ``cleo.computer.bridge``);
this module only relays tool calls and never needs Docker. ``computer-use.json`` keeps its old
schema and is read, never rewritten: the target is chosen per task in the desktop UI, and an old
``runtime`` value never grants local-computer control. A user-configured custom MCP ``command``
is still honoured as before.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Literal
from weakref import WeakKeyDictionary

from fastmcp import Client
from fastmcp.client.transports import StdioTransport
from pydantic import BaseModel, ConfigDict, Field

from cleo.computer import bridge


class ComputerSettings(BaseModel):
    model_config = ConfigDict(extra="allow")
    schema_version: int = 1
    # Older versions used this to pick Docker ("isolated") or Windows-MCP ("host"). It is kept
    # for compatibility and only informs the UI; it never authorizes local-computer control.
    runtime: Literal["isolated", "host"] = "isolated"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    timeout_seconds: int = Field(default=120, ge=10, le=600)


def config_path() -> Path:
    """Purpose: Locate isolated settings. Input: Cleo config location. Output: sibling path."""
    from cleo.config.settings import CONFIG_PATH

    return CONFIG_PATH.with_name("computer-use.json")


def read_settings(path: Path | None = None) -> ComputerSettings:
    """Purpose: Preserve old or invalid data. Input: optional path. Output: parsed settings."""
    path = path or config_path()
    if not path.exists():
        return ComputerSettings()
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, dict) or raw.get("schema_version", 1) != 1:
            raise ValueError("unsupported schema")
        return ComputerSettings.model_validate(raw)
    except (ValueError, OSError) as exc:
        raise ValueError(f"电脑操作配置无法读取，已保留原文件：{path}") from exc


def server_configuration(path: Path | None, client_key: str | None = None) -> dict:
    """Purpose: Attach tools to any harness. Input: settings path and the session's client key.

    Output: stdio MCP entry. The key lets the desktop broker map calls to the owning Cleo task;
    the bridge descriptor path (not its secret) comes from the desktop app's environment.
    """
    if path is None:
        return {}
    try:
        read_settings(path)
    except ValueError:
        # A broken optional connection must not prevent ordinary coding sessions.
        return {}
    root = str(Path(__file__).resolve().parents[2])
    bootstrap = (
        f"import sys; sys.path.insert(0, {root!r}); "
        "from cleo.mcp.computer_server import main; main()"
    )
    args = ["-I", "-c", bootstrap, "--config", str(path)]
    if client_key:
        args.extend(["--client-key", client_key])
    if descriptor := os.environ.get(bridge.ENVIRONMENT):
        args.extend(["--bridge", descriptor])
    return {"cleo_computer": {"command": sys.executable, "args": args}}


class ComputerConnection:
    """A user-configured custom computer MCP server (kept for compatibility)."""

    def __init__(self, settings: ComputerSettings):
        """Purpose: Prepare lazy stdio transport. Input: settings. Output: unstarted connection."""
        self.settings = settings
        self.transport = StdioTransport(
            command=settings.command,
            args=settings.args,
            env={**os.environ, "PYTHONUTF8": "1"},
            keep_alive=True,
        )
        self.client = Client(
            self.transport, timeout=settings.timeout_seconds, init_timeout=settings.timeout_seconds
        )
        self.lock = asyncio.Lock()

    async def invoke(self, name: str | None = None, arguments: dict | None = None):
        """Purpose: List or call upstream tools serially. Input: name/args. Output: MCP result."""
        async with self.lock:
            try:
                async with asyncio.timeout(self.settings.timeout_seconds):
                    async with self.client:
                        if name is None:
                            return await self.client.list_tools()
                        return await self.client.call_tool(
                            name, arguments or {}, raise_on_error=False
                        )
            except BaseException:
                await self.transport.disconnect()
                raise

    async def close(self):
        """Purpose: Release the subprocess. Input: none. Output: closed transport."""
        await self.transport.disconnect()


_connections: WeakKeyDictionary = WeakKeyDictionary()


async def connection(session: str, path: Path | None = None) -> ComputerConnection:
    """Purpose: Reuse one custom connection per task. Input: session/config. Output: adapter."""
    path = path or config_path()
    settings = read_settings(path)
    if sys.platform != "win32":
        raise ValueError("自定义电脑工具仅支持 Windows；当前平台可以继续使用普通聊天。")
    sessions = _connections.setdefault(asyncio.get_running_loop(), {})
    key = (str(path.resolve()), session)
    existing = sessions.get(key)
    if existing and existing.settings != settings:
        await existing.close()
        existing = None
    if existing is None:
        existing = sessions[key] = ComputerConnection(settings)
    return existing


async def close_connections() -> None:
    """Purpose: Stop owned MCP processes. Input: none. Output: no live sessions."""
    sessions = _connections.pop(asyncio.get_running_loop(), {})
    for client in sessions.values():
        await client.close()


async def _custom(
    session: str, name: str | None, arguments: dict | None, path: Path | None
) -> list[dict]:
    client = await connection(session, path)
    result = await client.invoke(name, arguments)
    if name is None:
        return [
            {
                "type": "text",
                "text": json.dumps(
                    [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": tool.input_schema,
                        }
                        for tool in result
                    ],
                    ensure_ascii=False,
                ),
            },
            {
                "type": "text",
                "text": "当前使用用户配置的自定义电脑工具连接；先查看工具返回的环境再操作。",
            },
        ]
    blocks = []
    for block in result.content:
        if block.type == "text":
            blocks.append({"type": "text", "text": block.text})
        elif block.type == "image":
            blocks.append({"type": "image", "base64": block.data, "mime_type": block.mime_type})
    if result.is_error:
        blocks.insert(0, {"type": "text", "text": "自定义电脑工具操作失败，未确认完成。"})
    return blocks


async def invoke(
    identity: dict | str,
    name: str | None = None,
    arguments: dict | None = None,
    path: Path | None = None,
    *,
    bridge_file: str | Path | None = None,
) -> list[dict]:
    """Purpose: Relay one tool call to the chosen target. Input: task identity and tool call.

    Output: content blocks. Failures are reported as text and never claimed as success.
    """
    identity = {"thread_id": identity} if isinstance(identity, str) else dict(identity or {})
    try:
        settings = read_settings(path)
        if settings.command:
            session = str(identity.get("thread_id") or identity.get("client_key") or "harness")
            return await _custom(session, name, arguments, path)
        payload = (
            {"op": "tools", "identity": identity}
            if name is None
            else {
                "op": "call",
                "identity": identity,
                "name": name,
                "arguments": arguments or {},
            }
        )
        return await bridge.request(payload, bridge=bridge_file)
    except Exception as exc:  # noqa: BLE001 - the model needs the reason, never a false success
        return [{"type": "text", "text": f"电脑操作未完成：{exc or '连接超时'}"}]
