import os
import json
from pathlib import Path
from pydantic import BaseModel,Field,SecretStr
from typing import Optional
from enum import Enum
from dotenv import find_dotenv, load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent

load_dotenv(find_dotenv())


def _parse_csv_env(value: str | None, default: list[str]) -> list[str]:
    if value is None:
        return default
    return [item.strip() for item in value.split(",") if item.strip()]


def _parse_bool_env(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}

class AgentProfile(BaseModel):
    profile_name: str
    api_key: SecretStr
    model_name: str
    provider: str
    base_url: str
    max_tokens: int = Field(default=100000,lt=0)
    temperature: float = Field(default=0.7,gt=0,le=1)

class DirectoryProfile(BaseModel):
    root_dir = PROJECT_ROOT
    DATA_DIR = PROJECT_ROOT / "data"
    SKILLS_DIR = PROJECT_ROOT / "skills"
    WORKSPACE_DIR = PROJECT_ROOT / "workspace"
    MEMORY_DIR = PROJECT_ROOT / "memory"
    MEMORY_AGENT_PATH = MEMORY_DIR / "AGENT.md"
    MEMORY_PROJECTS_DIR = MEMORY_DIR / "projects"
    THREAD_OBJECTS_DIR = MEMORY_DIR / "thread_objects"
    THREAD_REGISTRY_PATH = MEMORY_DIR / "threads.jsonl"
    RUNTIME_STATE_PATH = DATA_DIR / "runtime.json"
    SANDBOX_ROOT: str = str(PROJECT_ROOT).resolve()
    SHELL_AUDIT_LOG_PATH: str = str(PROJECT_ROOT / "data" / "shell_audit.log").resolve()

class ShellProfile(BaseModel):
    SHELL_REQUIRE_ALLOWLIST:Optional[bool] = True
    SHELL_ENFORCE_SANDBOX:Optional[bool] = True
    SHELL_REQUIRE_APPROVAL:Optional[bool] = False
    SHELL_TIMEOUT_SECONDS:int = 30
    SHELL_MAX_OUTPUT_CHARS:int = 12000
    SHELL_ALLOWED_COMMANDS: list[str] = ["python", "python.exe", "py", "py.exe"]
    SHELL_DENIED_PATTERNS: list[str] = [
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


class SettingsModel(BaseModel):
    agent_profile: AgentProfile
    directory_profile: DirectoryProfile
    shell_profile: ShellProfile




def load_settings()->SettingsModel:
    agent_profile_path = PROJECT_ROOT / "config" / "cleo.json"
    if not agent_profile_path.exists():
        agent_profile_path.mkdir(parents=True,exist_ok=True)
        default_config = {
                            "active_profiles": None,
                            "profiles": {
                                "default_placeholder": {
                                    "provider": None,
                                    "model": None,
                                    "temperature": None,
                                    "max_tokens": None,
                                    "api_key": None,
                                    "base_url": None
                                }
                            }
                        }
        with open(agent_profile_path,encoding="utf-8") as f:
            json.dump(default_config,f,ensure_ascii=False,indent="\t")
        raise FileNotFoundError(f"Created default config at {agent_profile_path}. Please fill in your API key, model and other related information for normally using the agent.")
    with open(PROJECT_ROOT / "config" / "cleo.json",encoding="utf-8") as f:
        agent_profile = json.load(f)
    active_profiles = agent_profile["active_profiles"]
    setting_profiles = agent_profile["profiles"][active_profiles]
    return 

settings:SettingsModel = load_settings()


class Settings:
    def __init__(self) -> None:
        self.TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
        self.PROFILE_DIR = PROJECT_ROOT / "config" / "cleo.json"
        self.DATA_DIR = PROJECT_ROOT / "data"
        self.SKILLS_DIR = PROJECT_ROOT / "skills"
        self.WORKSPACE_DIR = PROJECT_ROOT / "workspace"
        self.MEMORY_DIR = PROJECT_ROOT / "memory"
        self.MEMORY_AGENT_PATH = self.MEMORY_DIR / "AGENT.md"
        self.MEMORY_PROJECTS_DIR = self.MEMORY_DIR / "projects"
        self.THREAD_OBJECTS_DIR = self.MEMORY_DIR / "thread_objects"
        self.THREAD_REGISTRY_PATH = self.MEMORY_DIR / "threads.jsonl"
        self.RUNTIME_STATE_PATH = self.DATA_DIR / "runtime.json"

        self.SHELL_SANDBOX_ROOT = Path(
            os.getenv("SHELL_SANDBOX_ROOT") or str(PROJECT_ROOT)
        ).resolve()
        self.SHELL_AUDIT_LOG_PATH = Path(
            os.getenv("SHELL_AUDIT_LOG_PATH")
            or str(PROJECT_ROOT / "data" / "shell_audit.log")
        ).resolve()
        self.SHELL_REQUIRE_ALLOWLIST = _parse_bool_env(
            os.getenv("SHELL_REQUIRE_ALLOWLIST"),
            True,
        )
        self.SHELL_ENFORCE_SANDBOX = _parse_bool_env(
            os.getenv("SHELL_ENFORCE_SANDBOX"),
            True,
        )
        self.SHELL_REQUIRE_APPROVAL = _parse_bool_env(
            os.getenv("SHELL_REQUIRE_APPROVAL"),
            False,
        )
        self.SHELL_TIMEOUT_SECONDS = int(os.getenv("SHELL_TIMEOUT_SECONDS", "30"))
        self.SHELL_MAX_OUTPUT_CHARS = int(os.getenv("SHELL_MAX_OUTPUT_CHARS", "12000"))
        self.SHELL_ALLOWED_COMMANDS = _parse_csv_env(
            os.getenv("SHELL_ALLOWED_COMMANDS"),
            ["python", "python.exe", "py", "py.exe"],
        )
        self.SHELL_DENIED_PATTERNS = _parse_csv_env(
            os.getenv("SHELL_DENIED_PATTERNS"),
            [
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
            ],
        )


settings = Settings()
