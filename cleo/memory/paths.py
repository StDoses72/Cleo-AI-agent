"""Memory 目录布局与名称校验: 所有 space/project/session 路径拼接的唯一入口。"""

from __future__ import annotations

from pathlib import Path

MEMORY_SPACES = ("non_productivity", "productivity")
DEFAULT_MEMORY_SPACE = "non_productivity"


def validate_space(space: str) -> str:
    """校验 memory space 是否合法并返回规范化值。

    参数:
        space: 待校验的 space 名称; 来自 sessions/store.py、
            dream_agent_tools.py、memory/state.py、memory/store.py 等
            调用方传入的会话/工具上下文。

    返回:
        strip 后的合法 space 字符串, 供调用方继续拼路径或做 SQL 过滤;
        不在 MEMORY_SPACES 中时抛 ValueError。
    """
    value = str(space).strip()
    if value not in MEMORY_SPACES:
        raise ValueError(f"unsupported memory space: {value}")
    return value


def validate_name(value: str, field_name: str) -> str:
    """校验名称字段 (project/session_id 等) 不是路径, 防止路径穿越。

    参数:
        value: 待校验名称; 来自 sessions/store.py 的会话操作参数、
            dream_agent_tools.py 的工具入参及 memory/state.py 的 source id。
        field_name: 字段名, 仅用于报错信息定位, 由调用方按字段固定传入。

    返回:
        strip 后的安全名称; 为空或含 ``/`` ``\\`` ``..`` 时抛 ValueError。
    """
    name = str(value).strip()
    if not name or any(part in name for part in ("/", "\\", "..")):
        raise ValueError(f"{field_name} must be a name, not a path")
    return name


def space_directory(memory_root: Path, space: str) -> Path:
    """返回指定 space 的根目录 ``<memory_root>/<space>``。

    参数:
        memory_root: memory 根目录; 通常来自 settings.MEMORY_DIR 或
            sessions/store.py 的 self.memory_root。
        space: memory space; 由调用方会话上下文传入, 内部经 validate_space 校验。

    返回:
        space 目录 Path; 被 projects_directory 与 memory_database_path、
        memory_state_path 复用。
    """
    return Path(memory_root) / validate_space(space)


def projects_directory(memory_root: Path, space: str) -> Path:
    """返回 space 下的 projects 目录。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。

    返回:
        ``<space>/projects`` 目录 Path; 被 runtime/state.py 遍历项目、
        dream_agent_tools.py 的 list_all_project_names 及 project_directory 使用。
    """
    return space_directory(memory_root, space) / "projects"


def project_directory(memory_root: Path, space: str, project: str) -> Path:
    """返回单个项目目录 ``<space>/projects/<project>``。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。
        project: 项目名; 同来源, 内部经 validate_name 校验。

    返回:
        项目目录 Path; 被 dream_agent_tools.py 的 _safe_project_dir 及
        sessions_directory 使用。
    """
    return projects_directory(memory_root, space) / validate_name(project, "project")


def sessions_directory(memory_root: Path, space: str, project: str) -> Path:
    """返回项目下的 sessions 目录。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。
        project: 项目名; 同来源。

    返回:
        ``<project>/sessions`` 目录 Path; 被 dream_agent_tools.py 的
        list_all_session_ids 及 session_directory 使用。
    """
    return project_directory(memory_root, space, project) / "sessions"


def session_directory(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    """返回单个会话目录 ``<project>/sessions/<session_id>``。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源, 内部经 validate_name 校验。

    返回:
        会话目录 Path; 被 sessions/store.py 的 move_session/session_directory
        及本文件 manifest_path/events_path/compact_path 使用。
    """
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
    """返回会话 manifest.json 的路径。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。

    返回:
        manifest.json 的 Path; 被 sessions/store.py 读写 manifest、
        compaction.py load_validated_compact 校验绑定时消费。
    """
    return session_directory(memory_root, space, project, session_id) / "manifest.json"


def events_path(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    """返回会话 append-only 事件日志 events.jsonl 的路径。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。

    返回:
        events.jsonl 的 Path; 被 sessions/store.py 追加/读取事件、
        dream_agent_tools.py 的 read_session_events、
        compaction.py load_validated_compact 消费。
    """
    return session_directory(memory_root, space, project, session_id) / "events.jsonl"


def compact_path(
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> Path:
    """返回会话 compact 投影 compact.json 的路径。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。

    返回:
        compact.json 的 Path; 被 compaction.py 的 write_compact_events 写入、
        load_validated_compact 读取。
    """
    return session_directory(memory_root, space, project, session_id) / "compact.json"


def memory_database_path(memory_root: Path, space: str) -> Path:
    """返回 space 级 SQLite 索引库 memory.sqlite3 的路径。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文, 内部经 validate_space 校验。

    返回:
        memory.sqlite3 的 Path; 被 memory/store.py 的 _database_path 及
        sessions/store.py 的 refresh_compact/move_session 使用。
    """
    return space_directory(memory_root, space) / "memory.sqlite3"


def memory_state_path(memory_root: Path, space: str) -> Path:
    """返回 space 级 consolidation 状态文件 memory_state.json 的路径。

    参数:
        memory_root: memory 根目录; 来自 settings.MEMORY_DIR 或 self.memory_root。
        space: memory space; 来自调用方会话上下文。

    返回:
        memory_state.json 的 Path; 被 memory/state.py 的 _state_path 及
        sessions/store.py 的 refresh_compact/move_session 使用。
    """
    return space_directory(memory_root, space) / "memory_state.json"
