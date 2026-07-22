from __future__ import annotations

from pathlib import Path

MEMORY_SPACES = ("non_productivity", "productivity")
DEFAULT_MEMORY_SPACE = "non_productivity"


def validate_space(space: str) -> str:
    value = str(space).strip()
    if value not in MEMORY_SPACES:
        raise ValueError(f"unsupported memory space: {value}")
    return value


def validate_name(value: str, field_name: str) -> str:
    name = str(value).strip()
    if not name or any(part in name for part in ("/", "\\", "..")):
        raise ValueError(f"{field_name} must be a name, not a path")
    return name


def space_directory(memory_root: Path, space: str) -> Path:
    return Path(memory_root) / validate_space(space)


def projects_directory(memory_root: Path, space: str) -> Path:
    return space_directory(memory_root, space) / "projects"


def project_directory(memory_root: Path, space: str, project: str) -> Path:
    return projects_directory(memory_root, space) / validate_name(project, "project")


def sessions_directory(memory_root: Path, space: str, project: str) -> Path:
    return project_directory(memory_root, space, project) / "sessions"


def session_directory(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    return sessions_directory(memory_root, space, project) / validate_name(
        session_id,
        "session_id",
    )


def manifest_path(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    return session_directory(memory_root, space, project, session_id) / "manifest.json"


def events_path(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    return session_directory(memory_root, space, project, session_id) / "events.jsonl"


def compact_path(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    return session_directory(memory_root, space, project, session_id) / "compact.json"


def memory_database_path(memory_root: Path, space: str) -> Path:
    return space_directory(memory_root, space) / "memory.sqlite3"


def memory_state_path(memory_root: Path, space: str) -> Path:
    return space_directory(memory_root, space) / "memory_state.json"
