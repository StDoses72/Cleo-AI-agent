"""Drive the unmodified, user-installed Claude Code CLI with its own authentication."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import signal
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from cleo.harnesses.models import AgentEvent, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn


def process_options() -> dict:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


async def stop_process(process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/PID",
            str(process.pid),
            "/T",
            "/F",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        await killer.wait()
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        await asyncio.wait_for(process.wait(), 5)
    except TimeoutError:
        process.kill()
        await process.wait()


async def auth_status(profile) -> dict:
    from cleo.integrations.subscriptions import executable, runtime_environment

    process = await asyncio.create_subprocess_exec(
        executable(profile),
        "auth",
        "status",
        env=runtime_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **process_options(),
    )
    try:
        stdout, _stderr = await asyncio.wait_for(process.communicate(), 20)
        payload = json.loads(stdout)
        if process.returncode or not payload.get("loggedIn"):
            raise ValueError("请先运行 claude auth login，完成 Claude Code 官方登录。")
        return {"status": "connected", "models": []}
    finally:
        await stop_process(process)


class ClaudeCliProvider:
    name = "claude_code"

    def __init__(self, profile, mcp):
        self.profile = profile
        self.mcp = mcp
        self._sessions: dict[str, tuple[str, str | None]] = {}
        self._processes = {}

    async def create_session(self, project_path, model=None):
        identifier = secrets.token_hex(12)
        self._sessions[identifier] = (project_path, None)
        return ProviderSession(identifier)

    async def resume_session(self, native_session_id, project_path, model=None):
        self._sessions[native_session_id] = (project_path, native_session_id)
        return ProviderSession(native_session_id, native_session_id)

    async def prompt(self, session_id, prompt, on_event=None):
        from cleo.integrations.subscriptions import executable, runtime_environment

        cwd, native_id = self._sessions[session_id]
        with TemporaryDirectory(prefix="cleo-claude-") as temporary:
            config = Path(temporary) / "mcp.json"
            instructions = Path(temporary) / "instructions.txt"
            config.write_text(
                json.dumps({"mcpServers": self.mcp.claude_servers()}), encoding="utf-8"
            )
            instructions.write_text(self.mcp.instructions, encoding="utf-8")
            args = [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--tools",
                "",
                "--permission-mode",
                "dontAsk",
                "--allowedTools",
                "mcp__cleo-tools__*",
                "--strict-mcp-config",
                "--mcp-config",
                str(config),
                "--append-system-prompt-file",
                str(instructions),
            ]
            if self.profile.model != "default":
                args.extend(["--model", self.profile.model])
            if native_id:
                args.extend(["--resume", native_id])
            process = await asyncio.create_subprocess_exec(
                executable(self.profile),
                *args,
                cwd=cwd,
                env=runtime_environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                limit=8 * 1024 * 1024,
                **process_options(),
            )
            self._processes[session_id] = process

            # Drain stderr while streaming stdout; never place login tokens in model output.
            async def drain_errors():
                while await process.stderr.read(8192):
                    pass

            errors = asyncio.create_task(drain_errors())
            result = None
            try:
                process.stdin.write(prompt.encode("utf-8"))
                await process.stdin.drain()
                process.stdin.close()
                async for line in process.stdout:
                    payload = json.loads(line)
                    if payload.get("type") == "stream_event":
                        event = payload.get("event", {})
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            await emit_event(
                                on_event,
                                AgentEvent(
                                    provider=self.name,
                                    type="assistant_message_chunk",
                                    text=delta.get("text", ""),
                                ),
                            )
                    elif payload.get("type") == "result":
                        result = payload
                    elif payload.get("type") in {"assistant", "user"}:
                        for block in payload.get("message", {}).get("content", []):
                            if not isinstance(block, dict):
                                continue
                            kind = block.get("type")
                            if kind in {"tool_use", "tool_result"}:
                                await emit_event(
                                    on_event,
                                    AgentEvent(
                                        provider=self.name,
                                        type="tool_call" if kind == "tool_use" else "tool_result",
                                        text=block.get("name"),
                                        data=block,
                                    ),
                                )
                await process.wait()
                if process.returncode or result is None or result.get("is_error"):
                    raise RuntimeError(
                        "Claude Code did not complete the turn. "
                        "Check its login, quota and MCP access."
                    )
                return ProviderTurn(
                    native_session_id=result.get("session_id"),
                    turn_id=result.get("uuid") or secrets.token_hex(12),
                    status="completed",
                    response=result.get("result", ""),
                )
            finally:
                await stop_process(process)
                await errors
                self._processes.pop(session_id, None)

    async def cancel(self, session_id):
        process = self._processes.get(session_id)
        if process:
            await stop_process(process)

    async def close(self, session_id):
        await self.cancel(session_id)
        self._sessions.pop(session_id, None)
