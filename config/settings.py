import os
from pathlib import Path

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


class Settings:
    def __init__(self) -> None:
        self.OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
        self.TAVILY_API_KEY = os.getenv("TAVILY_API_KEY")
        self.MODEL = os.getenv("AI4CASTING_MODEL", "gpt-5.4-mini")
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
