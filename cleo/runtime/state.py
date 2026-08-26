"""运行时状态(runtime state)持久化: 管理当前 memory space / project / thread 及最近线程列表。"""

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from cleo.memory.paths import DEFAULT_MEMORY_SPACE, MEMORY_SPACES, projects_directory

DEFAULT_PROJECT = "general"
MAX_RECENT_THREADS = 5
RUNTIME_SCHEMA_VERSION = 3


def _clean_string(value: Any) -> str | None:
    """清洗字符串输入: 去首尾空白, 空串或非字符串归一为 None。

    参数:
        value: 任意来源的原始值, 来自 runtime.json 反序列化结果或
            Pydantic validator 的输入(见 normalize_optional_string)。
    返回:
        清洗后的非空字符串, 或 None; 被 RuntimeState 字段校验器与
        _dedupe_keep_last 消费。
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _dedupe_keep_last(values: list[str]) -> list[str]:
    """列表去重并保留最后一次出现的位置(keep-last 语义)。

    参数:
        values: 原始字符串列表, 来自 runtime.json 中的 projects /
            recent_threads 配置(见 normalize_state)。
    返回:
        去重、去空白后的列表; 被 RuntimeState.normalize_state 用于
        规范化 projects 与 recent_threads。
    """
    seen: set[str] = set()
    result: list[str] = []
    for value in reversed(values):
        text = _clean_string(value)
        if text is not None and text not in seen:
            seen.add(text)
            result.append(text)
    return list(reversed(result))


def _default_projects() -> dict[str, list[str]]:
    """构造 projects 字段默认值: non_productivity 空间预置 general 项目。

    返回:
        按 memory space 划分的项目名列表字典; 作为 RuntimeState.projects
        的 default_factory, 并在 normalize_state 中作为规范化基底。
    """
    return {
        "non_productivity": [DEFAULT_PROJECT],
        "productivity": [],
    }


def _default_recent_threads() -> dict[str, list[str]]:
    """构造 recent_threads 字段默认值: 每个 memory space 一个空列表。

    返回:
        以 space 为键的空列表字典; 作为 RuntimeState.recent_threads 的
        default_factory 及 normalize_state 的规范化基底。
    """
    return {space: [] for space in MEMORY_SPACES}


def _default_project_paths() -> dict[str, dict[str, str]]:
    return {space: {} for space in MEMORY_SPACES}


def _default_removed_projects() -> dict[str, list[str]]:
    return {space: [] for space in MEMORY_SPACES}


class RuntimeState(BaseModel):
    """runtime.json 的 Pydantic schema: 描述并校验磁盘上的运行时状态。

    字段来自 settings.RUNTIME_STATE_PATH 指向的 JSON 文件, 由
    Runtime._load_runtime_state / _write_runtime_state 读写; 实例被
    Runtime.__init__ 与 update_runtime_json 消费以同步内存状态。
    """

    model_config = ConfigDict(extra="ignore")

    schema_version: int = RUNTIME_SCHEMA_VERSION
    current_space: str = DEFAULT_MEMORY_SPACE
    current_project: str | None = None
    current_thread_id: str | None = None
    projects: dict[str, list[str]] = Field(default_factory=_default_projects)
    recent_threads: dict[str, list[str]] = Field(default_factory=_default_recent_threads)
    project_paths: dict[str, dict[str, str]] = Field(default_factory=_default_project_paths)
    removed_projects: dict[str, list[str]] = Field(default_factory=_default_removed_projects)

    @field_validator("current_project", "current_thread_id", mode="before")
    @classmethod
    def normalize_optional_string(cls, value: Any) -> str | None:
        """字段级 before-validator: 将可选字符串字段清洗为 str | None。

        参数:
            value: runtime.json 反序列化出的原始字段值, 由 Pydantic 在
                model_validate 时传入。
        返回:
            清洗后的字符串或 None, 交由 Pydantic 完成后续类型校验。
        """
        return _clean_string(value)

    @model_validator(mode="after")
    def normalize_state(self) -> "RuntimeState":
        """模型级 after-validator: 对整体状态做规范化(normalization)。

        修正非法 current_space、projects/recent_threads 去重、默认项目置顶、
        recent_threads 截断至 MAX_RECENT_THREADS, 并保证 current_project
        出现在当前 space 的项目列表中。由 Pydantic 在每次 model_validate /
        构造时自动调用; 返回自身供 Runtime 读取规范化后的字段。
        """
        if self.current_space not in MEMORY_SPACES:
            self.current_space = DEFAULT_MEMORY_SPACE

        normalized_projects = _default_projects()
        normalized_recent = _default_recent_threads()
        normalized_paths = _default_project_paths()
        normalized_removed = _default_removed_projects()
        for space in MEMORY_SPACES:
            configured_removed = self.removed_projects.get(space, [])
            removed_projects = _dedupe_keep_last(
                configured_removed if isinstance(configured_removed, list) else []
            )
            if space == DEFAULT_MEMORY_SPACE:
                removed_projects = [
                    project for project in removed_projects if project != DEFAULT_PROJECT
                ]
            removed = set(removed_projects)
            normalized_removed[space] = removed_projects

            configured_projects = self.projects.get(space, [])
            projects = _dedupe_keep_last(
                configured_projects if isinstance(configured_projects, list) else []
            )
            if space == DEFAULT_MEMORY_SPACE:
                projects = [project for project in projects if project != DEFAULT_PROJECT]
                projects.insert(0, DEFAULT_PROJECT)
            projects = [project for project in projects if project not in removed]
            normalized_projects[space] = projects

            configured_recent = self.recent_threads.get(space, [])
            recent = _dedupe_keep_last(
                configured_recent if isinstance(configured_recent, list) else []
            )
            normalized_recent[space] = recent[-MAX_RECENT_THREADS:]

            configured_paths = self.project_paths.get(space, {})
            if isinstance(configured_paths, dict):
                for raw_name, raw_path in configured_paths.items():
                    name = _clean_string(raw_name)
                    path = _clean_string(raw_path)
                    if name is not None and path is not None and name not in removed:
                        normalized_paths[space][name] = path

        if self.current_project in normalized_removed[self.current_space]:
            self.current_project = None
        if self.current_project is not None:
            active_projects = normalized_projects[self.current_space]
            if self.current_project not in active_projects:
                active_projects.append(self.current_project)

        self.schema_version = RUNTIME_SCHEMA_VERSION
        self.projects = normalized_projects
        self.recent_threads = normalized_recent
        self.project_paths = normalized_paths
        self.removed_projects = normalized_removed
        return self


class Runtime:
    """运行时状态门面(facade): 内存中持有当前状态并负责落盘到 runtime.json。

    由 CLI 各入口实例化: cleo/cli/application.py(main 流程)、
    cleo/cli/chat.py、cleo/cli/lifecycle.py、cleo/cli/productivity.py;
    这些调用方通过 update_* / append_recent_threads 修改状态,
    通过 projects_for 读取状态渲染交互界面。
    """

    def __init__(self) -> None:
        """初始化 Runtime: 绑定配置路径, 确保 runtime.json 存在并载入状态。

        runtime_json_path / memory_root 在实例化时才读取 settings
        (class body 不再于 import 期二次绑定配置, 运行期可替换、
        测试可注入); 状态来源为 settings.RUNTIME_STATE_PATH 指向的
        JSON 文件(缺失或损坏时回退默认值); 完成后实例属性被 CLI
        各命令直接读取。
        """
        from cleo.config.settings import settings

        self.runtime_json_path = settings.RUNTIME_STATE_PATH
        self.memory_root = settings.MEMORY_DIR
        self.ensure_runtime_json()
        state = self._load_runtime_state()
        self.current_space = state.current_space
        self.current_project = state.current_project
        self.current_thread_id = state.current_thread_id
        self.projects = state.projects
        self.recent_threads = state.recent_threads
        self.project_paths = state.project_paths
        self.removed_projects = state.removed_projects
        self.sync_projects_from_disk()

    def ensure_runtime_json(self) -> None:
        """若 runtime.json 不存在则写入默认状态文件。

        由 Runtime.__init__ 与 update_runtime_json 调用; 无返回值,
        副作用是创建 self.runtime_json_path 及其父目录。
        """
        if self.runtime_json_path.exists():
            return
        self.runtime_json_path.parent.mkdir(parents=True, exist_ok=True)
        self._write_runtime_state(RuntimeState())

    def _load_runtime_state(self) -> RuntimeState:
        """从 runtime.json 读取并校验运行时状态。

        读取 self.runtime_json_path; JSON 损坏、IO 错误、结构非法或
        校验失败时静默回退为默认 RuntimeState。
        返回:
            规范化后的 RuntimeState, 由 Runtime.__init__ 消费以填充实例属性。
        """
        try:
            with open(self.runtime_json_path, encoding="utf-8-sig") as source:
                runtime_data = json.load(source)
        except (json.JSONDecodeError, OSError):
            return RuntimeState()
        if not isinstance(runtime_data, dict):
            return RuntimeState()
        try:
            return RuntimeState.model_validate(runtime_data)
        except ValidationError:
            return RuntimeState()

    def _write_runtime_state(self, state: RuntimeState) -> None:
        """以原子写(tmp + replace)方式把状态持久化到 runtime.json。

        参数:
            state: 待写入的 RuntimeState, 来自 ensure_runtime_json 的默认值
                或 update_runtime_json 中重建的当前状态。
        无返回值; 写入结果由后续的 _load_runtime_state 读取。
        """
        self.runtime_json_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.runtime_json_path.with_suffix(self.runtime_json_path.suffix + ".tmp")
        temp_path.write_text(
            json.dumps(state.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(self.runtime_json_path)

    def update_current_space(self, space: str) -> None:
        """切换当前 memory space 并立即落盘。

        参数:
            space: 目标 memory space, 由 CLI 调用方根据用户命令传入, 见
                cleo/cli/application.py(启动/恢复流程)与
                cleo/cli/chat.py、cleo/cli/productivity.py 的切换命令。
        无返回值; 非法 space 抛出 ValueError。
        """
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        self.current_space = space
        self.update_runtime_json()

    def update_current_thread_id(self, thread_id: str | None) -> None:
        """更新当前活跃 thread id 并落盘(None 表示清空)。

        参数:
            thread_id: 新会话/恢复会话的 id 或 None, 来自
                cleo/cli/chat.py(新建、恢复、退出会话)与
                cleo/cli/productivity.py(各 productivity 会话操作)。
        无返回值; 状态经 update_runtime_json 写入 runtime.json。
        """
        self.current_thread_id = thread_id
        self.update_runtime_json()

    def update_current_project(self, project_name: str | None) -> None:
        """更新当前项目并落盘; 新项目会自动登记进当前 space 的项目列表。

        参数:
            project_name: 目标项目名或 None, 来自 cleo/cli/application.py
                的启动参数及 cleo/cli/chat.py、cleo/cli/productivity.py
                的会话切换/清理逻辑。
        无返回值; projects 列表的变更随 update_runtime_json 一并持久化。
        """
        self.current_project = project_name
        active_projects = self.projects[self.current_space]
        if project_name is not None:
            self.removed_projects[self.current_space] = [
                project
                for project in self.removed_projects[self.current_space]
                if project != project_name
            ]
        if project_name is not None and project_name not in active_projects:
            active_projects.append(project_name)
        self.update_runtime_json()

    def register_project(self, space: str, project_name: str, project_path: str) -> None:
        """Persist the local directory used by one project in either memory space."""
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        name = _clean_string(project_name)
        path = _clean_string(project_path)
        if name is None or path is None:
            raise ValueError("project name and path must not be empty")
        if name not in self.projects[space]:
            self.projects[space].append(name)
        self.project_paths[space][name] = path
        self.removed_projects[space] = [
            project for project in self.removed_projects[space] if project != name
        ]
        self.update_runtime_json()

    def remove_project(self, space: str, project_name: str) -> None:
        """Hide a project without deleting its directory or saved sessions."""
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        name = _clean_string(project_name)
        if name is None:
            raise ValueError("project name must not be empty")
        if space == DEFAULT_MEMORY_SPACE and name == DEFAULT_PROJECT:
            raise ValueError("the default general project cannot be removed")
        self.projects[space] = [
            project for project in self.projects[space] if project != name
        ]
        self.project_paths[space].pop(name, None)
        if name not in self.removed_projects[space]:
            self.removed_projects[space].append(name)
        if self.current_space == space and self.current_project == name:
            self.current_project = None
            self.current_thread_id = None
        self.update_runtime_json()

    def project_path(self, space: str, project_name: str) -> str | None:
        """Return the registered local directory for a project."""
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        return self.project_paths[space].get(project_name)

    def is_project_removed(self, space: str, project_name: str) -> bool:
        """Return whether a project was explicitly removed from desktop navigation."""
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        return project_name in self.removed_projects[space]

    def append_recent_threads(self, thread_id: str, space: str | None = None) -> None:
        """把 thread id 追加到指定 space 的最近线程列表(去重、截断)并落盘。

        参数:
            thread_id: 刚激活的会话 id, 来自 cleo/cli/lifecycle.py:43
                (会话结束记录)、cleo/cli/productivity.py 与 chat.py 的
                会话切换流程。
            space: 目标 memory space, 缺省用当前 current_space; 调用方通常
                显式传入 "productivity" 或 "non_productivity"。
        无返回值; 列表保留最近 MAX_RECENT_THREADS 条并写回 runtime.json。
        """
        target_space = space or self.current_space
        if target_space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {target_space}")
        recent = self.recent_threads[target_space]
        if thread_id in recent:
            recent.remove(thread_id)
        recent.append(thread_id)
        self.recent_threads[target_space] = recent[-MAX_RECENT_THREADS:]
        self.update_runtime_json()

    def forget_thread(self, thread_id: str, space: str) -> None:
        """Remove a deleted thread from runtime navigation state."""
        if space not in MEMORY_SPACES:
            raise ValueError(f"unsupported memory space: {space}")
        self.recent_threads[space] = [
            candidate for candidate in self.recent_threads[space] if candidate != thread_id
        ]
        if self.current_thread_id == thread_id:
            self.current_thread_id = None
        self.update_runtime_json()

    def projects_for(self, space: str | None = None) -> list[str]:
        """返回指定 space 的项目名列表副本(缺省为当前 space)。

        参数:
            space: 目标 memory space; 实际调用见 cleo/cli/chat.py:108、195,
                均显式传 "non_productivity" 用于补全/校验项目名。
        返回:
            项目名列表, 被 chat.py 的交互提示与项目切换校验消费。
        """
        return list(self.projects[space or self.current_space])

    def sync_projects_from_disk(self) -> None:
        """扫描磁盘上各 space 的项目目录, 把未登记的项目并入状态后落盘。

        由 Runtime.__init__ 在启动时调用一次; 目录结构来自
        cleo.memory.paths.projects_directory(memory_root, space)。
        无返回值; 合并结果经 update_runtime_json 写回 runtime.json。
        """
        for space in MEMORY_SPACES:
            root = projects_directory(self.memory_root, space)
            root.mkdir(parents=True, exist_ok=True)
            disk_projects = sorted(path.name for path in root.iterdir() if path.is_dir())
            for project_name in disk_projects:
                if project_name not in self.projects[space]:
                    self.projects[space].append(project_name)
        self.update_runtime_json()

    def update_runtime_json(self) -> None:
        """把内存中的当前状态重建为 RuntimeState(触发规范化)并原子落盘。

        由本类所有 update_* / append_recent_threads / sync_projects_from_disk
        内部调用, 也被 cleo/cli/chat.py、cleo/cli/productivity.py 在批量
        修改后直接调用以统一保存。无返回值; 写盘同时回写规范化后的字段到
        实例属性。
        """
        self.ensure_runtime_json()
        state = RuntimeState(
            current_space=self.current_space,
            current_project=self.current_project,
            current_thread_id=self.current_thread_id,
            projects=self.projects,
            recent_threads=self.recent_threads,
            project_paths=self.project_paths,
            removed_projects=self.removed_projects,
        )
        self.current_space = state.current_space
        self.current_project = state.current_project
        self.current_thread_id = state.current_thread_id
        self.projects = state.projects
        self.recent_threads = state.recent_threads
        self.project_paths = state.project_paths
        self.removed_projects = state.removed_projects
        self._write_runtime_state(state)
