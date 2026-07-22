import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _config_path() -> Path:
    override = os.environ.get("CLEO_CONFIG_PATH")
    if not override:
        return PROJECT_ROOT / "config" / "cleo.json"

    candidate = Path(override).expanduser()
    if not candidate.is_absolute():
        candidate = PROJECT_ROOT / candidate
    return candidate.resolve()


CONFIG_PATH = _config_path()

DEFAULT_ALLOWED_COMMANDS = ["python", "git"]
PLATFORM_ALLOWED_COMMANDS = {
    "nt": ["python", "python.exe", "py", "py.exe", "powershell", "powershell.exe", "git"],
    "posix": ["python", "python3", "sh", "bash", "git"],
}
DEFAULT_DENIED_PATTERNS = [
    "&&",
    "||",
    ";",
    "|",
    ">",
    "<",
    "`",
    "$(",
    "../",
    "..\\",
    " rm ",
    " rmdir ",
    " del ",
    " erase ",
    " format ",
    " shutdown ",
    " restart-computer ",
    " powershell -enc",
    " certutil -decode",
]


def _resolve_path(path: Path | str | None, default: Path, base: Path = PROJECT_ROOT) -> Path:
    candidate = Path(path) if path is not None else default
    if candidate.is_absolute():
        return candidate.resolve()
    return (base / candidate).resolve()


def _effective_allowed_commands(
    configured: list[str],
    *,
    platform: str | None = None,
) -> list[str]:
    platform_name = platform or os.name
    platform_defaults = PLATFORM_ALLOWED_COMMANDS.get(platform_name, ["python", "git"])
    return list(dict.fromkeys([*configured, *platform_defaults]))


class AgentProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    api_key: SecretStr
    base_url: str | None = None
    max_tokens: int = Field(default=100000, gt=0)
    temperature: float = Field(default=0.7, ge=0, le=2)


class DirectoryProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root_dir: Path = Path(".")
    data_dir: Path = Path("data")
    skills_dir: Path = Path("skills")
    workspace_dir: Path = Path("workspace")
    memory_dir: Path = Path("memory")
    memory_policy_path: Path = Path("memory/MEMORY_POLICY.md")
    session_index_path: Path = Path("memory/sessions.sqlite3")
    session_artifacts_dir: Path = Path("data/session_artifacts")
    runtime_state_path: Path = Path("data/runtime.json")

    def project_path(self, path: Path) -> Path:
        if path.is_absolute():
            return path.resolve()
        return (self.root_path / path).resolve()

    @property
    def root_path(self) -> Path:
        return _resolve_path(self.root_dir, Path("."))

    @property
    def data_path(self) -> Path:
        return self.project_path(self.data_dir)

    @property
    def skills_path(self) -> Path:
        return self.project_path(self.skills_dir)

    @property
    def workspace_path(self) -> Path:
        return self.project_path(self.workspace_dir)

    @property
    def memory_path(self) -> Path:
        return self.project_path(self.memory_dir)

    @property
    def memory_policy_file(self) -> Path:
        return self.project_path(self.memory_policy_path)

    @property
    def session_index_file(self) -> Path:
        return self.project_path(self.session_index_path)

    @property
    def session_artifacts_path(self) -> Path:
        return self.project_path(self.session_artifacts_dir)

    @property
    def runtime_state_file(self) -> Path:
        return self.project_path(self.runtime_state_path)


class ShellProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sandbox_root: Path | None = None
    audit_log_path: Path | None = None
    require_allowlist: bool = False
    enforce_sandbox: bool = False
    require_approval: bool = False
    timeout_seconds: int = Field(default=30, gt=0)
    max_output_chars: int = Field(default=12000, ge=0)
    allowed_commands: list[str] = Field(default_factory=lambda: DEFAULT_ALLOWED_COMMANDS.copy())
    include_platform_defaults: bool = True
    denied_patterns: list[str] = Field(default_factory=list)


class ToolsProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tavily_api_key: SecretStr | None = None
    codex_model: str = Field(default="gpt-5.5", min_length=1)


class ActiveProfiles(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent: str
    directory: str = "default"
    shell: str = "default"
    tools: str = "default"


class ProfileRegistry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agents: dict[str, AgentProfile]
    directories: dict[str, DirectoryProfile] = Field(
        default_factory=lambda: {"default": DirectoryProfile()}
    )
    shell: dict[str, ShellProfile] = Field(default_factory=lambda: {"default": ShellProfile()})
    tools: dict[str, ToolsProfile] = Field(default_factory=lambda: {"default": ToolsProfile()})


class SettingsModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    active_profiles: ActiveProfiles
    profiles: ProfileRegistry

    @model_validator(mode="after")
    def validate_active_profiles(self) -> "SettingsModel":
        missing: list[str] = []
        if self.active_profiles.agent not in self.profiles.agents:
            missing.append(f"agent:{self.active_profiles.agent}")
        if self.active_profiles.directory not in self.profiles.directories:
            missing.append(f"directory:{self.active_profiles.directory}")
        if self.active_profiles.shell not in self.profiles.shell:
            missing.append(f"shell:{self.active_profiles.shell}")
        if self.active_profiles.tools not in self.profiles.tools:
            missing.append(f"tools:{self.active_profiles.tools}")
        if missing:
            raise ValueError(f"Active profile(s) not found: {', '.join(missing)}")
        return self

    @property
    def active_agent_profile(self) -> AgentProfile:
        return self.profiles.agents[self.active_profiles.agent]

    @property
    def active_directory_profile(self) -> DirectoryProfile:
        return self.profiles.directories[self.active_profiles.directory]

    @property
    def active_shell_profile(self) -> ShellProfile:
        return self.profiles.shell[self.active_profiles.shell]

    @property
    def active_tools_profile(self) -> ToolsProfile:
        return self.profiles.tools[self.active_profiles.tools]

    @property
    def PROFILE_DIR(self) -> Path:
        return CONFIG_PATH

    @property
    def TAVILY_API_KEY(self) -> str | None:
        key = self.active_tools_profile.tavily_api_key
        return key.get_secret_value() if key else None

    @property
    def DATA_DIR(self) -> Path:
        return self.active_directory_profile.data_path

    @property
    def SKILLS_DIR(self) -> Path:
        return self.active_directory_profile.skills_path

    @property
    def WORKSPACE_DIR(self) -> Path:
        return self.active_directory_profile.workspace_path

    @property
    def MEMORY_DIR(self) -> Path:
        return self.active_directory_profile.memory_path

    @property
    def MEMORY_POLICY_PATH(self) -> Path:
        return self.active_directory_profile.memory_policy_file

    @property
    def SESSION_INDEX_PATH(self) -> Path:
        return self.active_directory_profile.session_index_file

    @property
    def SESSION_ARTIFACTS_DIR(self) -> Path:
        return self.active_directory_profile.session_artifacts_path

    @property
    def RUNTIME_STATE_PATH(self) -> Path:
        return self.active_directory_profile.runtime_state_file

    @property
    def SHELL_SANDBOX_ROOT(self) -> Path:
        return _resolve_path(
            self.active_shell_profile.sandbox_root,
            Path("."),
            self.active_directory_profile.root_path,
        )

    @property
    def SHELL_AUDIT_LOG_PATH(self) -> Path:
        return _resolve_path(
            self.active_shell_profile.audit_log_path,
            Path("data/shell_audit.log"),
            self.active_directory_profile.root_path,
        )

    @property
    def SHELL_REQUIRE_ALLOWLIST(self) -> bool:
        return self.active_shell_profile.require_allowlist

    @property
    def SHELL_ENFORCE_SANDBOX(self) -> bool:
        return self.active_shell_profile.enforce_sandbox

    @property
    def SHELL_REQUIRE_APPROVAL(self) -> bool:
        return self.active_shell_profile.require_approval

    @property
    def SHELL_TIMEOUT_SECONDS(self) -> int:
        return self.active_shell_profile.timeout_seconds

    @property
    def SHELL_MAX_OUTPUT_CHARS(self) -> int:
        return self.active_shell_profile.max_output_chars

    @property
    def SHELL_ALLOWED_COMMANDS(self) -> list[str]:
        configured = self.active_shell_profile.allowed_commands
        if not self.active_shell_profile.include_platform_defaults:
            return configured
        return _effective_allowed_commands(configured)

    @property
    def SHELL_DENIED_PATTERNS(self) -> list[str]:
        return self.active_shell_profile.denied_patterns


def _default_config() -> dict[str, Any]:
    return {
        "active_profiles": {
            "agent": "moonshot_openai_compatible",
            "directory": "default",
            "shell": "default",
            "tools": "default",
        },
        "profiles": {
            "agents": {
                "moonshot_openai_compatible": {
                    "provider": "openai",
                    "model": "kimi-k2.6",
                    "temperature": 0.7,
                    "max_tokens": 100000,
                    "api_key": "YOUR_MOONSHOT_API_KEY",
                    "base_url": "https://api.moonshot.cn/v1",
                }
            },
            "directories": {
                "default": {
                    "root_dir": ".",
                    "data_dir": "data",
                    "skills_dir": "skills",
                    "workspace_dir": "workspace",
                    "memory_dir": "memory",
                    "memory_policy_path": "memory/MEMORY_POLICY.md",
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
                    "allowed_commands": DEFAULT_ALLOWED_COMMANDS,
                    "include_platform_defaults": True,
                    "denied_patterns": DEFAULT_DENIED_PATTERNS,
                }
            },
            "tools": {
                "default": {
                    "tavily_api_key": None,
                    "codex_model": "gpt-5.5",
                }
            },
        },
    }


def _create_default_config(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_default_config(), f, ensure_ascii=False, indent="\t")


def load_settings(config_path: Path = CONFIG_PATH) -> SettingsModel:
    if not config_path.exists():
        _create_default_config(config_path)
        raise FileNotFoundError(
            f"Created default config at {config_path}. "
            "Please fill in your API key, model, and related profile settings."
        )

    with open(config_path, encoding="utf-8") as f:
        raw_config = json.load(f)

    return SettingsModel.model_validate(raw_config)


settings: SettingsModel = load_settings()
