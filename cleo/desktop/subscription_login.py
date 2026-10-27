"""Short-lived, cancellable login attempts owned by the official runtime."""

import asyncio
import subprocess
from contextlib import suppress
from uuid import uuid4

from cleo.config.settings import AgentProfile
from cleo.i18n import tr
from cleo.integrations.claude_cli import process_options, stop_process
from cleo.integrations.harness_home import claude_environment
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
            raise ValueError(tr(
                "subscription_login.complete_or_cancel_the_sign_in_already_in_progre",
            ))
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

                    from cleo.integrations.codex_home import isolated_codex_config

                    async with AsyncCodex(
                        config=isolated_codex_config(AgentMcp(profile, root, "").codex_config())
                    ) as client:
                        login = await client.login_chatgpt()
                        state["url"] = login.auth_url
                        try:
                            result = await login.wait()
                            if not result.success:
                                raise ValueError(result.error or tr(
                                    "subscription_login.sign_in_failed",
                                ))
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
                                tr(
                                    "subscription_login.this_gemini_cli_does_not_offer_google_sign_in_ru",
                                )
                            )
                        state["output"] = tr(
                            "subscription_login.complete_google_sign_in_in_the_browser_opened_by",
                        )
                        await connection.authenticate(method.id)
                    finally:
                        await manager.__aexit__(None, None, None)
                else:
                    claude = profile.backend == "claude_code"
                    args = ["auth", "login"] if claude else ["login"]
                    environment = runtime_environment()
                    process = await asyncio.create_subprocess_exec(
                        executable(profile),
                        *args,
                        # Claude signs in to Cleo's own directory, used by every Claude entry.
                        env=claude_environment(environment) if claude else environment,
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
                            raise ValueError(tr(
                                "subscription_login.official_sign_in_is_incomplete_follow_the_page_s",
                            ))
                    finally:
                        await stop_process(process)
                state["status"] = "completed"
        except asyncio.CancelledError:
            state["status"] = "cancelled"
            raise
        except TimeoutError:
            state["status"] = "failed"
            state["output"] = tr(
                "subscription_login.sign_in_timed_out_start_official_sign_in_again",
            )
        except (OSError, ValueError, RuntimeError) as exc:
            state["status"] = "failed"
            state["output"] = str(exc)
        except Exception:
            # Protocol errors may include credentials. Only return a fixed login failure.
            state["status"] = "failed"
            state["output"] = tr(
                "subscription_login.official_sign_in_failed_check_the_cli_version_an",
            )

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
