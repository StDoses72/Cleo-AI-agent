import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from cleo.config.settings import settings
from cleo.memory.paths import DEFAULT_MEMORY_SPACE, MEMORY_SPACES, projects_directory

DEFAULT_PROJECT = "general"
MAX_RECENT_THREADS = 5
RUNTIME_SCHEMA_VERSION = 2


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _dedupe_keep_last(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in reversed(values):
        text = _clean_string(value)
        if text is not None and text not in seen:
            seen.add(text)
            result.append(text)
    return list(reversed(result))


def _default_projects() -> dict[str, list[str]]:
    return {
        "non_productivity": [DEFAULT_PROJECT],
        "productivity": [],
    }


def _default_recent_threads() -> dict[str, list[str]]:
    return {space: [] for space in MEMORY_SPACES}


class RuntimeState(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: int = RUNTIME_SCHEMA_VERSION
    current_space: str = DEFAULT_MEMORY_SPACE
    current_project: str | None = None
    current_thread_id: str | None = None
    projects: dict[str, list[str]] = Field(default_factory=_default_projects)
    recent_threads: dict[str, list[str]] = Field(default_factory=_default_recent_threads)

    @field_validator("current_project", "current_thread_id", mode="before")
    @classmethod
    def normalize_optional_string(cls, value: Any) -> str | None:
        return _clean_string(value)

    @model_validator(mode="after")
    def normalize_state(self) -> "RuntimeState":
        if self.current_space not in MEMORY_SPACES:
            self.current_space = DEFAULT_MEMORY_SPACE

        normalized_projects = _default_projects()
        normalized_recent = _default_recent_threads()
        for space in MEMORY_SPACES:
            configured_projects = self.projects.get(space, [])
            projects = _dedupe_keep_last(
                configured_projects if isinstance(configured_projects, list) else []
            )
            if space == DEFAULT_MEMORY_SPACE:
                projects = [project for project in projects if project != DEFAULT_PROJECT]
                projects.insert(0, DEFAULT_PROJECT)
            normalized_projects[space] = projects

            configured_recent = self.recent_threads.get(space, [])
            recent = _dedupe_keep_last(
                configured_recent if isinstance(configured_recent, list) else []
            )
            normalized_recent[space] = recent[-MAX_RECENT_THREADS:]

        if self.current_project is not None:
            active_projects = normalized_projects[self.current_space]
            if self.current_project not in active_projects:
                active_projects.append(self.current_project)

        self.schema_version = RUNTIME_SCHEMA_VERSION
        self.projects = normalized_projects
        self.recent_threads = normalized_recent
        return self


DEFAULT_RUNTIME_STATE = RuntimeState().model_dump()


class Runtime:
    runtime_json_path = settings.RUNTIME_STATE_PATH
    memory_root = settings.MEMORY_DIR

    def __init__(self) -> None:
        self.ensure_runtime_json()
        state = self._load_runtime_state()
        self.current_space = state.current_space
        self.current_project = state.current_project
        self.current_thread_id = state.current_thread_id
        self.projects = state.projects
        self.recent_threads = state.recent_threads
        self.sync_projects_from_disk()

    @classmethod
    def ensure_runtime_json(cls) -> None:
        if cls.runtime_json_path.exists():
            return
        cls.runtime_json_path.parent.mkdir(parents=True, exist_ok=True)
        cls._write_runtime_state(RuntimeState())

    @classmethod
    def _load_runtime_state(cls) -> RuntimeState:
        try:
            with open(cls.runtime_json_path, encoding="utf-8-sig") as source:
                runtime_data = json.load(source)
        except (json.JSONDecodeError, OSError):
            return RuntimeState()
        if not isinstance(runtime_data, dict):
            return RuntimeState()
        try:
            return RuntimeState.model_validate(runtime_data)
        except ValidationError:
            return RuntimeState()

    @classmethod
    def _write_runtime_state(cls, state: RuntimeState) -> None:
        cls.runtime_json_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = cls.runtime_json_path.with_suffix(cls.runtime_json_path.suffix + ".tmp")
        temp_path.write_text(
            json.dumps(state.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(cls.runtime_json_path)

    def update_current_space(self, space: str) -> None:
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        self.current_space = space
        self.update_runtime_json()

    def update_current_thread_id(self, thread_id: str | None) -> None:
        self.current_thread_id = thread_id
        self.update_runtime_json()

    def update_current_project(self, project_name: str | None) -> None:
        self.current_project = project_name
        active_projects = self.projects[self.current_space]
        if project_name is not None and project_name not in active_projects:
            active_projects.append(project_name)
        self.update_runtime_json()

    def append_recent_threads(self, thread_id: str, space: str | None = None) -> None:
        target_space = space or self.current_space
        if target_space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {target_space}")
        recent = self.recent_threads[target_space]
        if thread_id in recent:
            recent.remove(thread_id)
        recent.append(thread_id)
        self.recent_threads[target_space] = recent[-MAX_RECENT_THREADS:]
        self.update_runtime_json()

    def projects_for(self, space: str | None = None) -> list[str]:
        return list(self.projects[space or self.current_space])

    def recent_threads_for(self, space: str | None = None) -> list[str]:
        return list(self.recent_threads[space or self.current_space])

    def sync_projects_from_disk(self) -> None:
        for space in MEMORY_SPACES:
            root = projects_directory(self.memory_root, space)
            root.mkdir(parents=True, exist_ok=True)
            disk_projects = sorted(path.name for path in root.iterdir() if path.is_dir())
            for project_name in disk_projects:
                if project_name not in self.projects[space]:
                    self.projects[space].append(project_name)
        self.update_runtime_json()

    def update_runtime_json(self) -> None:
        self.ensure_runtime_json()
        state = RuntimeState(
            current_space=self.current_space,
            current_project=self.current_project,
            current_thread_id=self.current_thread_id,
            projects=self.projects,
            recent_threads=self.recent_threads,
        )
        self.current_space = state.current_space
        self.current_project = state.current_project
        self.current_thread_id = state.current_thread_id
        self.projects = state.projects
        self.recent_threads = state.recent_threads
        self._write_runtime_state(state)
