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
from cleo.integrations.runtime_diagnostics import StderrCapture, diagnostic_text


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
    """Purpose: Check official login without implying a model turn succeeded.
    Input: Runtime profile selecting the same CLI used for chat.
    Output: Login status or bounded, redacted CLI failure details.
    """
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
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
        try:
            payload = json.loads(stdout)
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict):
            detail = diagnostic_text(stderr.decode("utf-8", errors="replace"))
            raise ValueError(
                f"Claude Code auth status returned invalid JSON (exit_code={process.returncode}). "
                + detail
            )
        if process.returncode or not payload.get("loggedIn"):
            detail = diagnostic_text(stderr.decode("utf-8", errors="replace"))
            raise ValueError(
                f"Claude Code 登录检查未通过 (exit_code={process.returncode}, "
                f"loggedIn={payload.get('loggedIn') is True})。"
                f"请运行 claude auth login 完成官方登录。 {detail}"
            )
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
        """Purpose: Stream one CLI turn and retain evidence when it fails.
        Input: Logical session ID, user prompt and optional event callback.
        Output: Completed turn and reusable native ID, or a redacted diagnostic error.
        """
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

            stderr = StderrCapture()
            errors = asyncio.create_task(stderr.drain(process.stderr))
            result = None
            protocol_error = False
            mcp_status = ""
            try:
                try:
                    process.stdin.write(prompt.encode("utf-8"))
                    await process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    # A CLI that rejects its arguments can close stdin before we write.
                    pass
                finally:
                    process.stdin.close()
                async for line in process.stdout:
                    if not line.strip():
                        continue
                    try:
                        payload = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        protocol_error = True
                        continue
                    if not isinstance(payload, dict):
                        protocol_error = True
                        continue
                    if payload.get("type") == "system" and payload.get("subtype") == "init":
                        for server in payload.get("mcp_servers", []):
                            if isinstance(server, dict) and server.get("name") == "cleo-tools":
                                mcp_status = diagnostic_text(str(server.get("status")), limit=80)
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
                await errors
                if result and isinstance(result.get("session_id"), str):
                    self._sessions[session_id] = (cwd, result["session_id"])
                if process.returncode or result is None or result.get("is_error") or protocol_error:
                    state = "missing" if result is None else (
                        "error" if result.get("is_error") else "success"
                    )
                    evidence = [f"exit_code={process.returncode}", f"result={state}"]
                    if result and result.get("subtype"):
                        evidence.append("subtype=" + diagnostic_text(str(result["subtype"])))
                    if mcp_status:
                        evidence.append("cleo-tools=" + mcp_status)
                    if protocol_error:
                        evidence.append("invalid stream-json")
                    details = []
                    if result and result.get("is_error"):
                        for field in ("errors", "result"):
                            if result.get(field):
                                details.append(diagnostic_text(str(result[field]), prompt=prompt))
                    if text := stderr.text(prompt):
                        details.append("stderr: " + text)
                    raise RuntimeError(
                        "Claude Code did not complete the turn (" + "; ".join(evidence) + "). "
                        + (" ".join(details) or "CLI 未提供错误详情。")
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
