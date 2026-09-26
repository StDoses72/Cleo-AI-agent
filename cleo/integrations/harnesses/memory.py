"""Process-local MCP configuration. Never registers servers in user/project files."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, replace
from pathlib import Path

from acp.schema import McpServerStdio
from openai_codex import CodexConfig

from cleo.harnesses.context import ContextBinding


@dataclass(frozen=True)
class MemoryMcp:
    root: Path
    index_path: Path | None = None
    context: ContextBinding | None = None
    computer_config_path: Path | None = None

    def for_context(self, binding: ContextBinding) -> MemoryMcp:
        return replace(self, context=binding)

    @property
    def context_args(self) -> list[str]:
        if self.context is None:
            raise ValueError("No context is bound")
        return [
            *self.args,
            "--context-session",
            self.context.session_id,
            "--context-snapshot",
            self.context.snapshot_id,
        ]

    @property
    def args(self) -> list[str]:
        # Bootstrap from an absolute source root even in unrelated project directories.
        source_root = str(Path(__file__).resolve().parents[3])
        bootstrap = (
            f"import sys; sys.path.insert(0, {source_root!r}); "
            "from cleo.mcp.memory_server import main; main()"
        )
        args = ["-I", "-c", bootstrap, "--memory-root", str(self.root.expanduser().resolve())]
        if self.index_path is not None:
            args.extend(["--session-index-path", str(self.index_path.expanduser().resolve())])
        return args

    def codex_config(self, *, approval_mode: str = "deny_all") -> CodexConfig:
        """Purpose: Match owned desktop tool grants to the session's native approval policy.

        Input: Bound settings and approval mode. Output: Process-local Codex MCP overrides.
        Native user/auto review requests must not be bypassed by the deny-all desktop grant.
        """
        from cleo.integrations.computer import read_settings, server_configuration
        computer = tuple(
            f"mcp_servers.{name}.{key}={json.dumps(value)}"
            for name, config in server_configuration(self.computer_config_path).items()
            for key, value in config.items()
        )
        computer_permissions = ()
        if computer:
            settings = read_settings(self.computer_config_path)
            if not settings.command:
                # Both built-in destinations use these two explicitly selected desktop tools.
                # Keep native review policies and unrelated/custom MCP permissions unchanged.
                computer_permissions = tuple(
                    f'mcp_servers.cleo_computer.tools.{name}.approval_mode='
                    + json.dumps("approve" if approval_mode == "deny_all" else "prompt")
                    for name in ("computer_tools", "computer_call")
                )
        prefix = "mcp_servers.cleo_memory"
        context = (
            ()
            if self.context is None
            else (
                f"mcp_servers.cleo_context.command={json.dumps(sys.executable)}",
                f"mcp_servers.cleo_context.args={json.dumps(self.context_args)}",
                "mcp_servers.cleo_context.enabled=true",
                "mcp_servers.cleo_context.required=true",
            )
        )
        return CodexConfig(
            config_overrides=(
                f"{prefix}.command={json.dumps(sys.executable)}",
                f"{prefix}.args={json.dumps(self.args)}",
                f"{prefix}.enabled=true",
                f"{prefix}.required=true",
                *context,
                *computer,
                *computer_permissions,
            )
        )

    def claude_servers(self) -> dict:
        """Purpose: Compose local tools. Input: bound settings. Output: Claude stdio entries."""
        from cleo.integrations.computer import server_configuration
        servers = {"cleo_memory": {"type": "stdio", "command": sys.executable, "args": self.args}}
        if self.context is not None:
            servers["cleo_context"] = {
                "type": "stdio",
                "command": sys.executable,
                "args": self.context_args,
            }
        return {**servers, **server_configuration(self.computer_config_path)}

    def acp_servers(self) -> list[McpServerStdio]:
        """Purpose: Compose local tools. Input: bound settings. Output: ACP stdio entries."""
        from cleo.integrations.computer import server_configuration
        return [McpServerStdio(name="cleo_memory", command=sys.executable, args=self.args, env=[]),
                *(McpServerStdio(name=name, env=[], **config)
                  for name, config in server_configuration(self.computer_config_path).items())]
