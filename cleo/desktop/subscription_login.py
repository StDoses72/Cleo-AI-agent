"""Short-lived, cancellable login attempts owned by the official runtime."""

import asyncio
import subprocess
from contextlib import suppress
from uuid import uuid4

from cleo.config.settings import AgentProfile
from cleo.integrations.claude_cli import process_options, stop_process
from cleo.integrations.subscriptions import (
    AgentMcp,
    create_runtime,
    executable,
    runtime_environment,
)


class SubscriptionLogins:
    def __init__(self):
        self._attempts: dict[str, dict] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def start(self, profile: AgentProfile, root) -> dict:
        if any(not task.done() for task in self._tasks.values()):
            raise ValueError("请先完成或取消正在进行的登录。")
        self._attempts.clear()
        self._tasks.clear()
        identifier = str(uuid4())
        state = {"id": identifier, "status": "pending", "output": "", "url": None}
        self._attempts[identifier] = state
        self._tasks[identifier] = asyncio.create_task(self._run(profile, root, state))
        return dict(state)

    async def _run(self, profile, root, state):
        try:
            async with asyncio.timeout(300):
                if profile.backend == "codex":
                    from openai_codex import AsyncCodex

                    async with AsyncCodex(
                        config=AgentMcp(profile, root, "").codex_config()
                    ) as client:
                        login = await client.login_chatgpt()
                        state["url"] = login.auth_url
                        try:
                            result = await login.wait()
                            if not result.success:
                                raise ValueError(result.error or "登录失败")
                        except asyncio.CancelledError:
                            await login.cancel()
                            raise
                elif profile.backend == "gemini":
                    provider = create_runtime(profile, AgentMcp(profile, root, ""))
                    connection, manager, _host, response = await provider._connect(str(root))
                    try:
                        methods = response.auth_methods or []
                        method = next((m for m in methods if m.id == "oauth-personal"), None)
                        if method is None:
                            raise ValueError(
                                "此 Gemini CLI 未提供 Google 登录，请在终端运行 gemini。"
                            )
                        state["output"] = "请在官方 CLI 打开的浏览器中完成 Google 登录。"
                        await connection.authenticate(method.id)
                    finally:
                        await manager.__aexit__(None, None, None)
                else:
                    args = ["auth", "login"] if profile.backend == "claude_code" else ["login"]
                    process = await asyncio.create_subprocess_exec(
                        executable(profile),
                        *args,
                        env=runtime_environment(),
                        cwd=str(root),
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        **process_options(),
                    )
                    try:
                        while chunk := await process.stdout.read(1024):
                            state["output"] = (
                                state["output"] + chunk.decode("utf-8", errors="replace")
                            )[-8000:]
                        if await process.wait():
                            raise ValueError("官方登录未完成；可按页面提示在终端登录后验证连接。")
                    finally:
                        await stop_process(process)
                state["status"] = "completed"
        except asyncio.CancelledError:
            state["status"] = "cancelled"
            raise
        except TimeoutError:
            state["status"] = "failed"
            state["output"] = "登录超时，请重新开始官方登录。"
        except (OSError, ValueError, RuntimeError) as exc:
            state["status"] = "failed"
            state["output"] = str(exc)
        except Exception:
            # Protocol errors may include credentials. Only return a fixed login failure.
            state["status"] = "failed"
            state["output"] = "官方登录失败，请检查 CLI 版本并在终端重试。"

    def read(self, identifier):
        return dict(self._attempts[identifier])

    async def cancel(self, identifier):
        task = self._tasks[identifier]
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        return self.read(identifier)

    async def close(self):
        for identifier in self._tasks:
            await self.cancel(identifier)
