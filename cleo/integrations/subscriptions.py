"""Official local runtimes. Credentials stay in each vendor's own login store."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from acp.schema import McpServerStdio
from openai_codex import CodexConfig, Sandbox

from cleo.config.settings import AgentProfile, settings
from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider
from cleo.integrations.harnesses.codex import CodexProvider

RUNTIMES = {
    "codex": {
        "label": "Codex（ChatGPT 登录，使用 Codex 额度）",
        "command": "codex",
        "args": [],
        "login": "codex login",
        "docs": "https://learn.chatgpt.com/docs/auth",
    },
    "gemini": {
        "label": "Google · Gemini CLI",
        "command": "gemini",
        "args": [
            "--acp",
            "--approval-mode",
            "default",
            "--allowed-tools",
            "mcp_cleo-tools_*",
            "--allowed-mcp-server-names",
            "cleo-tools",
        ],
        "login": "gemini（选择 Sign in with Google）",
        "docs": "https://geminicli.com/docs/get-started/authentication/",
    },
    "copilot": {
        "label": "GitHub Copilot",
        "command": "copilot",
        "args": [
            "--acp",
            "--stdio",
            "--allow-tool=cleo-tools",
            "--deny-tool=shell",
            "--deny-tool=write",
        ],
        "login": "copilot login",
        "docs": "https://docs.github.com/en/copilot/how-tos/copilot-cli",
    },
    "grok": {
        "label": "Grok · Grok Build",
        "command": "grok",
        "args": [
            "--allow",
            "mcp__cleo-tools__*",
            "--permission-mode",
            "dontAsk",
            "--deny",
            "Bash",
            "--deny",
            "Edit",
            "agent",
            "stdio",
        ],
        "login": "grok login",
        "docs": "https://docs.x.ai/build/overview",
    },
    "claude_code": {
        "label": "Claude Code（官方 CLI）",
        "command": "claude",
        "args": [],
        "login": "claude auth login",
        "docs": "https://code.claude.com/docs/en/authentication",
    },
}


def executable(profile: AgentProfile) -> str:
    command = (
        profile.executable
        or (os.environ.get("CLEO_CODEX_BIN") if profile.backend == "codex" else None)
        or RUNTIMES[profile.backend]["command"]
    )
    resolved = shutil.which(command)
    if resolved is None:
        raise FileNotFoundError(f"未找到 {command}。请先安装官方 CLI，或填写可执行文件路径。")
    return resolved


def runtime_environment() -> dict[str, str]:
    # Prevent an inherited API key/BYOK setting from selecting a billed API by accident.
    excluded = {
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "XAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GENAI_USE_GCA",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
    return {
        key: value
        for key, value in os.environ.items()
        if key not in excluded and not key.startswith("COPILOT_PROVIDER_")
    }


@dataclass(frozen=True)
class AgentMcp:
    profile: AgentProfile
    project_path: Path
    instructions: str
    mode: str = "chat"
    scope: dict[str, str] | None = None

    @property
    def args(self) -> list[str]:
        source_root = str(Path(__file__).resolve().parents[2])
        bootstrap = (
            f"import sys; sys.path.insert(0, {source_root!r}); "
            "from cleo.mcp.agent_server import main; main()"
        )
        return [
            "-c",
            bootstrap,
            "--mode",
            self.mode,
            "--project-path",
            str(self.project_path),
            "--scope",
            json.dumps(self.scope or {}),
        ]

    def codex_config(self) -> CodexConfig:
        return CodexConfig(
            codex_bin=executable(self.profile),
            env=runtime_environment(),
            config_overrides=(
                'forced_login_method="chatgpt"',
                f"developer_instructions={json.dumps(self.instructions)}",
                f"mcp_servers.cleo-tools.command={json.dumps(sys.executable)}",
                f"mcp_servers.cleo-tools.args={json.dumps(self.args)}",
                "mcp_servers.cleo-tools.required=true",
            ),
        )

    def acp_servers(self) -> list[McpServerStdio]:
        return [McpServerStdio(name="cleo-tools", command=sys.executable, args=self.args, env=[])]

    def claude_servers(self) -> dict:
        return {"cleo-tools": {"command": sys.executable, "args": self.args}}


def create_runtime(profile: AgentProfile, mcp: AgentMcp):
    if profile.backend == "codex":
        return CodexProvider(
            None if profile.model == "default" else profile.model,
            sandbox=Sandbox.read_only,
            memory_mcp=mcp,
        )
    if profile.backend == "claude_code":
        from cleo.integrations.claude_cli import ClaudeCliProvider

        return ClaudeCliProvider(profile, mcp)
    preset = RUNTIMES[profile.backend]
    args = list(preset["args"])
    if profile.model != "default":
        # Older ACP agents lack session/config_options; the CLI flag still selects the model.
        args = ["--model", profile.model, *args]
    return AcpProvider(
        profile.backend,
        AcpAgentSpec(
            command=executable(profile),
            args=tuple(args),
            env=runtime_environment(),
            replace_env=True,
        ),
        memory_mcp=mcp,
    )


async def inspect_connection(profile: AgentProfile) -> dict:
    """Check login and enumerate models without sending a model prompt."""
    executable(profile)
    if profile.backend == "codex":
        from openai_codex import AsyncCodex

        config = AgentMcp(profile, Path.cwd(), "").codex_config()
        async with AsyncCodex(config=config) as client:
            account = await client.account()
            payload = account.account.model_dump(mode="json") if account.account else {}
            if payload.get("type") != "chatgpt":
                raise ValueError("请先使用 ChatGPT 账号登录 Codex（API Key 登录不适用）。")
            result = await client.models()
            return {"status": "connected", "models": [m.id for m in result.data]}
    if profile.backend == "claude_code":
        from cleo.integrations.claude_cli import auth_status

        return await auth_status(profile)
    # session/new verifies authentication, whereas initialize alone need not do so.
    provider = create_runtime(profile, AgentMcp(profile, Path.cwd(), ""))
    async with asyncio.timeout(45):
        models = await provider.list_models(str(settings.active_directory_profile.root_path))
    return {"status": "connected", "models": [item.id for item in models]}
