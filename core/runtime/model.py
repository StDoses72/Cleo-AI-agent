from pathlib import Path
import json

from config.settings import settings

class Runtime():
    runtime_json_path = settings.RUNTIME_STATE_PATH
    projects_path = settings.MEMORY_PROJECTS_DIR

    def __init__(self):
        with open(self.runtime_json_path, "r", encoding="utf-8-sig") as f:
            runtime_data = json.load(f)
        self.current_project = runtime_data.get("current_project")
        self.current_thread_id = runtime_data.get("current_thread_id")
        self.projects_list = runtime_data.get("projects_list", [])
        self.recent_threads = runtime_data.get("recent_threads", [])
        self.sync_projects_from_disk()

    def update_current_thread_id(self, thread_id: str) -> None:
        self.current_thread_id = thread_id
        self.update_runtime_json()

    def update_current_project(self, project_name: str) -> None:
        self.current_project = project_name
        if project_name not in self.projects_list and project_name is not None:
            self.projects_list.append(project_name)
        self.update_runtime_json()

    def append_recent_threads(self, thread_id: str) -> None:
        if thread_id not in self.recent_threads:
            self.recent_threads.append(thread_id)
            if len(self.recent_threads) > 5:  # Keep only the 5 most recent threads
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
        with open(Runtime.runtime_json_path, "r", encoding="utf-8-sig") as f:
            runtime_data = json.load(f)
        runtime_data["current_project"] = self.current_project
        runtime_data["current_thread_id"] = self.current_thread_id
        runtime_data["projects_list"] = self.projects_list
        runtime_data["recent_threads"] = self.recent_threads
        with open(Runtime.runtime_json_path, "w", encoding="utf-8") as f:
            json.dump(runtime_data, f, ensure_ascii=False, indent=2)
