"""Official local runtimes. Credentials stay in each vendor's own login store."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from cleo.config.settings import AgentProfile, settings
from cleo.i18n import tr

if TYPE_CHECKING:
    from acp.schema import McpServerStdio
    from openai_codex import CodexConfig

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
        "docs": "https://code.claude.com/docs/en/setup",
    },
}


def runtime_definitions() -> dict:
    """Localize catalog labels without changing the public runtime registry."""
    result = {name: dict(value) for name, value in RUNTIMES.items()}
    result["codex"]["label"] = tr("subscriptions.codex_chatgpt_sign_in_uses_codex_quota")
    result["claude_code"]["label"] = tr("subscriptions.claude_code_official_cli")
    result["gemini"]["login"] = tr("subscriptions.gemini_choose_sign_in_with_google")
    return result


def _runtime_path() -> str:
    """Include standard CLI installs when launched outside a login shell."""
    paths = [value for value in os.environ.get("PATH", "").split(os.pathsep) if value]
    paths.append(str(Path.home() / ".local" / "bin"))
    if sys.platform == "darwin":
        brew = [Path("/opt/homebrew/bin"), Path("/usr/local/bin")]
        if platform.machine() != "arm64":
            brew.reverse()
        paths.extend(str(path) for path in brew)
    return os.pathsep.join(dict.fromkeys(paths))


def _version_order(name: str) -> tuple[int, ...]:
    """Order version directory names numerically: 2.1.330 is newer than 2.1.99."""
    return tuple(int(part) if part.isdigit() else -1 for part in name.split("."))


def _claude_desktop_clients() -> list[Path]:
    """Purpose: The Claude Code builds the Claude desktop application keeps for itself on macOS.

    Output: runnable clients, the newest version first. The application downloads each version
    into ``claude-code/<version>/<build>/`` under its own support directory and leaves earlier
    ones behind, so the choice is made on every lookup: an update is picked up, and a version
    whose files are gone is passed over.
    """
    root = Path.home() / "Library" / "Application Support" / "Claude" / "claude-code"
    found = []
    try:
        versions = sorted((entry for entry in root.iterdir() if entry.is_dir()),
                          key=lambda entry: _version_order(entry.name), reverse=True)
        for version in versions:
            builds = [entry / "claude.app" / "Contents" / "MacOS" / "claude"
                      for entry in version.iterdir()]
            runnable = [path for path in builds if path.is_file() and os.access(path, os.X_OK)]
            found.extend(sorted(runnable, key=lambda path: path.stat().st_mtime, reverse=True))
    except OSError:
        pass  # No such application, or its directory cannot be read: nothing to offer.
    return found


# Clients a vendor's own application installs outside every command directory, by runtime and
# platform. Each entry was seen on a real installation; issue #200 keeps the record.
# Codex has no entry on purpose: Cleo runs the CLI that ships with its SDK and matches its
# version (ADR 0005), never another application's copy such as the one inside ChatGPT.app.
_VENDOR_CLIENTS = {("claude_code", "darwin"): _claude_desktop_clients}


def executable(profile: AgentProfile) -> str:
    """Purpose: The client program of an account connection.

    Input: the connection. Output: its path. The command is searched on the process path, then
    in the usual install directories. A client the user configured is looked for nowhere else;
    the runtime's own command is also looked for where the vendor's application keeps it.
    """
    configured = profile.executable or (
        os.environ.get("CLEO_CODEX_BIN") if profile.backend == "codex" else None
    )
    command = os.path.expanduser(configured or RUNTIMES[profile.backend]["command"])
    resolved = shutil.which(command)
    if resolved is None:
        resolved = shutil.which(command, path=_runtime_path())
    if resolved is None and not configured:
        clients = _VENDOR_CLIENTS.get((profile.backend, sys.platform), list)()
        resolved = str(clients[0]) if clients else None
    if resolved is None:
        raise FileNotFoundError(tr(
            "subscriptions.value_was_not_found_install_the_client_or_specif",
            p0=command,
        ))
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
    environment = {
        key: value
        for key, value in os.environ.items()
        if key not in excluded and not key.startswith("COPILOT_PROVIDER_")
    }
    environment["PATH"] = _runtime_path()
    return environment


@dataclass(frozen=True)
class AgentMcp:
    profile: AgentProfile
    project_path: Path
    instructions: str
    mode: str = "chat"
    scope: dict[str, str] | None = None

    @property
    def sync_instructions(self) -> str:
        if self.mode != "chat" or self.profile.backend not in {"codex", "claude_code"}:
            return ""
        from cleo.memory.source_settings import sync_instructions
        return sync_instructions(settings.PROFILE_DIR.with_name("memory-sources.json"))

    @property
    def args(self) -> list[str]:
        """Purpose: Start tools with bundled dependencies, independent of the project.
        Input: Runtime mode, project path, and scope on this instance.
        Output: Isolated Python arguments; CLEO_HOME and configuration overrides stay inherited.
        """
        source_root = str(Path(__file__).resolve().parents[2])
        bootstrap = (
            f"import sys; sys.path.insert(0, {source_root!r}); "
            "from cleo.mcp.agent_server import main; main()"
        )
        return [
            "-I",
            "-c",
            bootstrap,
            "--mode",
            self.mode,
            "--project-path",
            str(self.project_path),
            "--scope",
            json.dumps(self.scope or {}),
        ]

    def codex_config(
        self, *, approval_mode: str = "deny_all", computer_client: str | None = None,
    ) -> CodexConfig:
        """Purpose: Match the native provider contract without granting desktop permissions.

        Input: Provider approval policy and unused desktop attribution key. Output: the
        existing tool-scoped configuration; evaluator callers remain deny-all/read-only.
        """
        if approval_mode != "deny_all":
            raise ValueError("Subscription assessments require deny-all approvals")
        from openai_codex import CodexConfig

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
        from acp.schema import McpServerStdio

        return [McpServerStdio(name="cleo-tools", command=sys.executable, args=self.args, env=[])]

    def claude_servers(self) -> dict:
        return {"cleo-tools": {"command": sys.executable, "args": self.args}}


def create_runtime(profile: AgentProfile, mcp: AgentMcp):
    from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider

    if profile.backend == "codex":
        from openai_codex import Sandbox

        from cleo.integrations.harnesses.codex import CodexProvider

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


async def subscription_text(profile, temporary: Path, instructions: str, prompt: str) -> str:
    """Purpose: Ask a subscription runtime one tool-free question in a disposable directory.

    Input: Connection profile, temporary directory, instructions and the data to analyse.
    Output: The reply text. Uses only the transport: RuntimeGraph would initialize the live
    session index.
    """
    # Existing tool-free MCP mode; Codex is read-only and Claude disables native tools.
    mcp = AgentMcp(profile, temporary, instructions, mode="dream_extract")
    provider = create_runtime(profile, mcp)
    session = None
    parts = []

    async def on_event(event):
        from cleo.runtime.task_usage import usage_observer

        observer = usage_observer.get()
        if observer:
            observer(event)
        if event.type == "assistant_message_chunk" and event.text:
            parts.append(event.text)

    try:
        session = await provider.create_session(
            str(temporary), None if profile.model == "default" else profile.model
        )
        reply = await provider.prompt(
            session.id, instructions + "\n\n待分析的数据：\n" + prompt, on_event=on_event
        )
        if reply.status != "completed":
            raise ValueError(reply.error or "只读分析未完成。")
        return reply.response or "".join(parts)
    finally:
        if session is not None:
            await provider.close(session.id)


async def inspect_connection(profile: AgentProfile) -> dict:
    """Check login and enumerate models without sending a model prompt."""
    executable(profile)
    if profile.backend == "codex":
        from openai_codex import AsyncCodex

        from cleo.integrations.codex_home import isolated_codex_config

        config = isolated_codex_config(AgentMcp(profile, Path.cwd(), "").codex_config())
        async with AsyncCodex(config=config) as client:
            account = await client.account()
            payload = account.account.model_dump(mode="json") if account.account else {}
            if payload.get("type") != "chatgpt":
                raise ValueError(
                    tr("subscriptions.sign_in_to_codex_separately_in_cleo_with_a_chatg")
                )
            result = await client.models()
            return {"status": "connected", "models": [m.id for m in result.data]}
    if profile.backend == "claude_code":
        from cleo.integrations.claude_cli import auth_status
        from cleo.integrations.harness_home import claude_environment
        from cleo.integrations.harnesses.claude_models import discover_claude_models

        result = await auth_status(profile)
        models = await discover_claude_models(
            str(settings.active_directory_profile.root_path),
            cli_path=executable(profile), env=claude_environment(runtime_environment()),
        )
        return {**result, "models": [model.id for model in models]}
    # session/new verifies authentication, whereas initialize alone need not do so.
    provider = create_runtime(profile, AgentMcp(profile, Path.cwd(), ""))
    async with asyncio.timeout(45):
        models = await provider.list_models(str(settings.active_directory_profile.root_path))
    return {"status": "connected", "models": [item.id for item in models]}
