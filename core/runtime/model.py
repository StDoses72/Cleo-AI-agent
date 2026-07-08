import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from config.settings import settings

DEFAULT_PROJECT = "general"
MAX_RECENT_THREADS = 5


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _clean_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    values = [value] if isinstance(value, str) else value
    if not isinstance(values, list):
        return []

    cleaned: list[str] = []
    for item in values:
        text = _clean_string(item)
        if text is not None:
            cleaned.append(text)
    return cleaned


def _dedupe_keep_last(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in reversed(values):
        if value not in seen:
            seen.add(value)
            result.append(value)
    return list(reversed(result))


class RuntimeState(BaseModel):
    model_config = ConfigDict(extra="ignore")

    current_project: str | None = None
    current_thread_id: str | None = None
    projects_list: list[str] = Field(default_factory=lambda: [DEFAULT_PROJECT])
    recent_threads: list[str] = Field(default_factory=list)

    @field_validator("current_project", "current_thread_id", mode="before")
    @classmethod
    def normalize_optional_string(cls, value: Any) -> str | None:
        return _clean_string(value)

    @field_validator("projects_list", "recent_threads", mode="before")
    @classmethod
    def normalize_string_list(cls, value: Any) -> list[str]:
        return _clean_string_list(value)

    @model_validator(mode="after")
    def normalize_state(self) -> "RuntimeState":
        projects = [
            project
            for project in _dedupe_keep_last(self.projects_list)
            if project != DEFAULT_PROJECT
        ]
        projects.insert(0, DEFAULT_PROJECT)
        if self.current_project is not None and self.current_project not in projects:
            projects.append(self.current_project)

        self.projects_list = projects
        self.recent_threads = _dedupe_keep_last(self.recent_threads)[-MAX_RECENT_THREADS:]
        return self


DEFAULT_RUNTIME_STATE = RuntimeState().model_dump()


class Runtime:
    runtime_json_path = settings.RUNTIME_STATE_PATH
    projects_path = settings.MEMORY_PROJECTS_DIR

    def __init__(self) -> None:
        self.ensure_runtime_json()
        state = self._load_runtime_state()
        self.current_project = state.current_project
        self.current_thread_id = state.current_thread_id
        self.projects_list = state.projects_list
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
            with open(cls.runtime_json_path, encoding="utf-8-sig") as f:
                runtime_data = json.load(f)
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
        with open(cls.runtime_json_path, "w", encoding="utf-8") as f:
            json.dump(state.model_dump(), f, ensure_ascii=False, indent=2)

    def update_current_thread_id(self, thread_id: str | None) -> None:
        self.current_thread_id = thread_id
        self.update_runtime_json()

    def update_current_project(self, project_name: str | None) -> None:
        self.current_project = project_name
        if project_name not in self.projects_list and project_name is not None:
            self.projects_list.append(project_name)
        self.update_runtime_json()

    def append_recent_threads(self, thread_id: str) -> None:
        if thread_id not in self.recent_threads:
            self.recent_threads.append(thread_id)
            if len(self.recent_threads) > MAX_RECENT_THREADS:
                self.recent_threads.pop(0)
            self.update_runtime_json()

    def sync_projects_from_disk(self) -> None:
        self.projects_path.mkdir(parents=True, exist_ok=True)
        disk_projects = [
            path.name
            for path in self.projects_path.iterdir()
            if path.is_dir()
        ]
        for project_name in sorted(disk_projects):
            if project_name not in self.projects_list:
                self.projects_list.append(project_name)
        self.update_runtime_json()

    def update_runtime_json(self) -> None:
        self.ensure_runtime_json()
        state = RuntimeState(
            current_project=self.current_project,
            current_thread_id=self.current_thread_id,
            projects_list=self.projects_list,
            recent_threads=self.recent_threads,
        )
        self.current_project = state.current_project
        self.current_thread_id = state.current_thread_id
        self.projects_list = state.projects_list
        self.recent_threads = state.recent_threads
        self._write_runtime_state(state)
