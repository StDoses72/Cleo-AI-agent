"""Build an isolated CLEO_HOME the way the desktop shell would hand one to the backend."""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

SUPPORT = Path(__file__).resolve().parent
FAKE_ACP_AGENT = SUPPORT / "fake_acp_agent.py"
CHAT_API_KEY = "sk-characterization-secret"

AGENTS_MD = "# Characterization home\n\nDeterministic instructions for tests.\n"
MEMORY_POLICY_MD = "# Memory policy\n\nKeep durable facts only.\n"
PERSONA_MD = "# Persona\n"


@dataclass(frozen=True)
class CleoHome:
    root: Path
    home: Path
    workspace: Path
    user_home: Path

    @property
    def config_path(self) -> Path:
        return self.home / "config" / "cleo.json"

    @property
    def harnesses_path(self) -> Path:
        return self.home / "config" / "harnesses.json"

    @property
    def acp_log(self) -> Path:
        return self.root / "acp-requests.jsonl"

    @property
    def memory(self) -> Path:
        return self.home / "memory"

    def env(self) -> dict[str, str]:
        user_home = str(self.user_home)
        return {
            "CLEO_HOME": str(self.home),
            "CLEO_CONFIG_PATH": str(self.config_path),
            "CLEO_HARNESSES_CONFIG_PATH": str(self.harnesses_path),
            "HF_HOME": str(self.root / "models"),
            # Keep the developer's real harness logins and history out of the run.
            "HOME": user_home,
            "USERPROFILE": user_home,
            "CODEX_HOME": str(self.user_home / ".codex"),
            "CLAUDE_CONFIG_DIR": str(self.user_home / ".claude"),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "CHAR_ACP_LOG": str(self.acp_log),
        }


def chat_config(llm_base_url: str) -> dict:
    return {
        "active_profiles": {
            "agent": "fake_chat",
            "dream_agent": None,
            "directory": "default",
            "shell": "default",
            "tools": "default",
        },
        "profiles": {
            "agents": {
                "fake_chat": {
                    "provider": "openai",
                    "model": "fake-chat",
                    "temperature": 0,
                    "max_tokens": 64000,
                    "api_key": CHAT_API_KEY,
                    "base_url": llm_base_url,
                },
            },
            "directories": {
                "default": {
                    "root_dir": ".",
                    "data_dir": "data",
                    "skills_dir": "skills",
                    "workspace_dir": "workspace",
                    "memory_dir": "memory",
                    "memory_policy_path": "memory/MEMORY_POLICY.md",
                    "persona_path": "PERSONA.md",
                    "session_index_path": "memory/sessions.sqlite3",
                    "session_artifacts_dir": "data/session_artifacts",
                    "runtime_state_path": "data/runtime.json",
                }
            },
            "shell": {
                "default": {
                    "sandbox_root": ".",
                    "audit_log_path": "data/shell_audit.log",
                    "require_allowlist": True,
                    "enforce_sandbox": True,
                    "require_approval": False,
                    "timeout_seconds": 30,
                    "max_output_chars": 12000,
                    "allowed_commands": ["python", "git"],
                    "include_platform_defaults": False,
                    "denied_patterns": ["&&", "||", ";", "|"],
                }
            },
            "tools": {
                "default": {
                    "codex_model": "gpt-5.5",
                    "tavily_api_key": None,
                    "browser": {"enabled": False},
                }
            },
        },
    }


def harnesses_config() -> dict:
    return {
        "default_provider": "scripted",
        "providers": {
            "scripted": {
                "type": "acp",
                "enabled": True,
                "options": {
                    "command": sys.executable,
                    "args": ["-u", str(FAKE_ACP_AGENT)],
                    "auto_approve": False,
                },
            },
            # Real SDK harnesses stay registered but are never contacted by these tests.
            "codex": {
                "type": "codex_sdk",
                "enabled": False,
                "model": "gpt-5.5",
                "options": {"approval_mode": "deny_all", "sandbox": "workspace-write"},
            },
        },
    }


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=Cleo Tests", "-c", "user.email=tests@cleo.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", *args],
        cwd=cwd, check=True, capture_output=True,
    )


def build_home(root: Path, llm_base_url: str) -> CleoHome:
    home = root / "home"
    workspace = root / "workspace"
    user_home = root / "user"
    for directory in (home / "config", home / "memory", home / "skills", home / "data",
                      workspace, user_home / ".codex", user_home / ".claude"):
        directory.mkdir(parents=True, exist_ok=True)
    (home / "config" / "cleo.json").write_text(
        json.dumps(chat_config(llm_base_url), indent=2), encoding="utf-8")
    (home / "config" / "harnesses.json").write_text(
        json.dumps(harnesses_config(), indent=2), encoding="utf-8")
    (home / "AGENTS.md").write_text(AGENTS_MD, encoding="utf-8")
    (home / "PERSONA.md").write_text(PERSONA_MD, encoding="utf-8")
    (home / "memory" / "MEMORY_POLICY.md").write_text(MEMORY_POLICY_MD, encoding="utf-8")
    (workspace / "README.md").write_text("# Fixture workspace\n", encoding="utf-8")
    _git(workspace, "init", "-q", "-b", "main")
    _git(workspace, "add", "README.md")
    _git(workspace, "commit", "-q", "-m", "fixture")
    return CleoHome(root=root, home=home, workspace=workspace, user_home=user_home)
