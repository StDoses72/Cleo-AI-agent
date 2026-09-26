"""Optional Windows-MCP connection, with independent backward-compatible settings."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Literal
from weakref import WeakKeyDictionary

from fastmcp import Client
from fastmcp.client.transports import StdioTransport
from pydantic import BaseModel, ConfigDict, Field


class ComputerSettings(BaseModel):
    model_config = ConfigDict(extra="allow")
    schema_version: int = 1
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


def server_configuration(path: Path | None) -> dict:
    """Purpose: Attach tools to any harness. Input: independent config. Output: stdio MCP entry."""
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
    return {
        "cleo_computer": {
            "command": sys.executable,
            "args": ["-I", "-c", bootstrap, "--config", str(path)],
        }
    }


def select_runtime(runtime: str, path: Path) -> ComputerSettings:
    """Purpose: Persist a desktop choice atomically, preserving unrelated settings.

    Input: Built-in runtime and configuration path. Output: saved settings.
    """
    if runtime not in {"isolated", "host"}:
        raise ValueError("请选择独立桌面或本机桌面。")
    if runtime == "host" and sys.platform != "win32":
        raise ValueError("本机桌面目前仅支持 Windows。")
    settings = read_settings(path)
    if settings.command:
        raise ValueError("当前配置了自定义电脑工具；请先在 computer-use.json 中移除 command。")
    settings.runtime = runtime
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name, suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(settings.model_dump(), output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return settings


def desktop_target(settings: ComputerSettings) -> str:
    """Purpose: Describe the actual tool destination. Input: settings. Output: model guidance."""
    if settings.command:
        return "当前使用用户配置的自定义电脑工具连接；先查看工具返回的环境再操作。"
    if settings.runtime == "host":
        return ("当前操作用户的真实 Windows 本机桌面，可以打开和切换浏览器及其他应用，"
                "使用实际鼠标和键盘；操作不局限于 Cleo 窗口或右侧面板。"
                "用户需要登录或手动输入时，先停止操作并等待用户告知继续。")
    return ("当前操作右侧的独立 Linux 桌面，不要改用主机浏览器或主机键鼠操作。"
            "用户接管时等待交回控制。")


class ComputerConnection:
    """One persistent upstream session keeps Snapshot labels valid between tool calls."""

    def __init__(self, settings: ComputerSettings):
        """Purpose: Prepare lazy stdio transport. Input: settings. Output: unstarted connection."""
        command = settings.command or sys.executable
        args = (
            settings.args
            if settings.command
            else [
                "-m",
                "uv",
                "tool",
                "run",
                "--python",
                "3.14",
                "--from",
                "windows-mcp==0.8.5",
                "windows-mcp",
                "serve",
            ]
        )
        self.settings = settings
        self.transport = StdioTransport(
            command=command,
            args=args,
            env={**os.environ, "PYTHONUTF8": "1", "ANONYMIZED_TELEMETRY": "false"},
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
    """Purpose: Reuse one desktop snapshot per task. Input: session/config. Output: live adapter."""
    path = path or config_path()
    settings = read_settings(path)
    if sys.platform != "win32":
        raise ValueError("Windows-MCP 仅支持 Windows；当前平台可以继续使用普通聊天。")
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


async def invoke(
    session: str, name: str | None = None, arguments: dict | None = None, path: Path | None = None
) -> list[dict]:
    """Purpose: Preserve text and vision results. Input: tool call. Output: content blocks."""
    try:
        settings = read_settings(path)
        if settings.runtime == "isolated" and not settings.command:
            from cleo.computer_desktop.runtime import invoke as invoke_desktop
            blocks = await invoke_desktop(path or config_path(), name, arguments)
            if name is None:
                blocks.append({"type": "text", "text": desktop_target(settings)})
            return blocks
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
                {"type": "text", "text": desktop_target(settings)},
            ]
        blocks = []
        for block in result.content:
            if block.type == "text":
                blocks.append({"type": "text", "text": block.text})
            elif block.type == "image":
                blocks.append({"type": "image", "base64": block.data, "mime_type": block.mime_type})
        if result.is_error:
            blocks.insert(0, {"type": "text", "text": "Windows-MCP 操作失败，未确认完成。"})
        return blocks
    except Exception as exc:
        return [
            {
                "type": "text",
                "text": f"电脑操作未完成：{exc or '连接超时'}。"
                "请在 Cleo 的电脑面板检查所选操作环境后重试；可继续普通聊天。",
            }
        ]
