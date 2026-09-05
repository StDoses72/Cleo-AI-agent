"""Process-local MCP configuration. Never registers servers in user/project files."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

from acp.schema import McpServerStdio
from openai_codex import CodexConfig


@dataclass(frozen=True)
class MemoryMcp:
    root: Path
    index_path: Path | None = None

    @property
    def args(self) -> list[str]:
        # Bootstrap from an absolute source root even in unrelated project directories.
        source_root = str(Path(__file__).resolve().parents[3])
        bootstrap = (
            f"import sys; sys.path.insert(0, {source_root!r}); "
            "from cleo.mcp.memory_server import main; main()"
        )
        args = ["-c", bootstrap, "--memory-root", str(self.root.expanduser().resolve())]
        if self.index_path is not None:
            args.extend(["--session-index-path", str(self.index_path.expanduser().resolve())])
        return args

    def codex_config(self) -> CodexConfig:
        prefix = "mcp_servers.cleo_memory"
        return CodexConfig(
            config_overrides=(
                f"{prefix}.command={json.dumps(sys.executable)}",
                f"{prefix}.args={json.dumps(self.args)}",
                f"{prefix}.enabled=true",
                f"{prefix}.required=true",
            )
        )

    def claude_servers(self) -> dict:
        return {"cleo_memory": {"type": "stdio", "command": sys.executable, "args": self.args}}

    def acp_servers(self) -> list[McpServerStdio]:
        return [McpServerStdio(name="cleo_memory", command=sys.executable, args=self.args, env=[])]
