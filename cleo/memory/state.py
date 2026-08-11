"""Durable source-version state for space-bound session consolidation."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from cleo.config.settings import settings
from cleo.memory.paths import memory_state_path, validate_name, validate_space

SCHEMA_VERSION = 2
_STATE_LOCK = RLock()


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO 8601 字符串, 供 updated_at 等时间戳字段使用。"""
    return datetime.now(UTC).isoformat()


def _state_path(space: str, path: Path | None) -> Path:
    """解析 space 级状态文件路径, 优先使用调用方显式覆盖。

    参数:
        space: memory space; 来自 touch_session_source 等公开函数的入参。
        path: 可选路径覆盖; 来自 sessions/store.py 传入的 memory_state_path
            结果或测试注入, None 时回落到 settings.MEMORY_DIR。

    返回:
        memory_state.json 的 Path, 供 _load_unlocked/_save_unlocked 读写。
    """
    return path or memory_state_path(settings.MEMORY_DIR, validate_space(space))


def _empty_state() -> dict[str, Any]:
    """生成空的状态文档 (schema_version + 空 sources), 供初始化与损坏回退使用。

    返回:
        新的空 state dict, 被 _load_unlocked 在文件缺失/损坏/版本不符时返回。
    """
    return {"schema_version": SCHEMA_VERSION, "updated_at": _now_iso(), "sources": {}}


def _source_id(space: str, project: str, session_id: str) -> str:
    """生成会话事件源在 state 中的唯一键。

    参数:
        space: memory space; 来自各公开函数的会话定位入参, 内部做校验。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。

    返回:
        ``session:<space>:<project>:<session_id>`` 字符串, 作为
        state["sources"] 的键被所有公开函数使用。
    """
    return (
        f"session:{validate_space(space)}:"
        f"{validate_name(project, 'project')}:"
        f"{validate_name(session_id, 'session_id')}"
    )


def _load_unlocked(path: Path) -> dict[str, Any]:
    """在不持锁前提下读取状态文件, 损坏或版本不符时回退为空状态。

    参数:
        path: 状态文件路径; 来自各公开函数经 _state_path 解析的结果。

    返回:
        state dict; 文件缺失、JSON 损坏或 schema_version 不符时返回
        _empty_state()。调用方必须已持有 _STATE_LOCK。
    """
    if not path.exists():
        return _empty_state()
    try:
        state = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return _empty_state()
    if not isinstance(state, dict) or state.get("schema_version") != SCHEMA_VERSION:
        return _empty_state()
    if not isinstance(state.get("sources"), dict):
        state["sources"] = {}
    return state


def _save_unlocked(path: Path, state: dict[str, Any]) -> None:
    """以临时文件原子替换方式持久化状态, 并刷新 schema_version/updated_at。

    参数:
        path: 状态文件路径; 来自各公开函数经 _state_path 解析的结果。
        state: 内存中已更新的 state dict; 来自 _load_unlocked 加调用方修改。

    返回:
        无返回值; 写盘副作用被调用方 (touch/mark/discard 系列) 依赖。
        调用方必须已持有 _STATE_LOCK。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    state["schema_version"] = SCHEMA_VERSION
    state["updated_at"] = _now_iso()
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def touch_session_source(
    *,
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    last_event_seq: int,
    path: Path | None = None,
) -> dict[str, Any]:
    """Register an event-log revision without advancing consolidation state.

    登记一次事件源修订: hash 变化时递增 source_version 并置回 pending,
    不推进任何 consolidation 进度。

    ``source_version`` is a monotonic revision counter for this session's
    persisted event source. In normal conversation flow it advances roughly
    once per completed interaction batch, but lifecycle/status events can also
    advance it, so it is not an exact turn count or a schema/model version.

    参数:
        space: memory space; 来自 sessions/store.py refresh_compact 传入的
            manifest["space"] (或测试)。
        project: 项目名; 同来源, 来自 manifest["project"]。
        session_id: 会话 ID; 同来源。
        source_hash: 事件日志 content hash; 来自 refresh_compact 中
            event_content_hash(events) 的结果。
        last_event_seq: 最新事件 seq; 来自 manifest["last_event_seq"]。
        path: 可选状态文件覆盖; 来自 sessions/store.py 传入的
            memory_state_path 结果或测试注入。

    返回:
        该 source 的 entry dict 副本; 被 refresh_compact 读取
        source_version 传给 write_compact_events 与 update_manifest。
    """
    state_path = _state_path(space, path)
    source_id = _source_id(space, project, session_id)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(source_id)
        now = _now_iso()
        if entry is None:
            entry = {
                "space": space,
                "project": project,
                "session_id": session_id,
                "source_version": 1,
                "source_hash": source_hash,
                "last_event_seq": int(last_event_seq),
                "consolidated_version": 0,
                "consolidated_hash": None,
                "processed_version": 0,
                "processed_hash": None,
                "processing_decision": None,
                "processing_reason": None,
                "status": "pending",
                "failure_count": 0,
                "last_error": None,
                "last_updated_at": now,
                "last_consolidated_at": None,
                "last_processed_at": None,
            }
            state["sources"][source_id] = entry
        elif entry.get("source_hash") != source_hash:
            # A distinct event-log hash represents a new source revision. Keep
            # only the latest revision number; no per-version history is stored.
            entry["source_version"] = int(entry.get("source_version", 0)) + 1
            entry["source_hash"] = source_hash
            entry["last_event_seq"] = int(last_event_seq)
            entry["status"] = "pending"
            entry["processing_decision"] = None
            entry["processing_reason"] = None
            entry["gate_result"] = None
            entry["last_error"] = None
            entry["last_updated_at"] = now
        _save_unlocked(state_path, state)
        return dict(entry)


def get_session_source(
    space: str,
    project: str,
    session_id: str,
    *,
    path: Path | None = None,
) -> dict[str, Any] | None:
    """读取指定会话事件源的 consolidation 状态条目。

    参数:
        space: memory space; 来自 sessions/store.py move_session、
            cleo/agents/dream.py invoke 及 needs_consolidation 的会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        path: 可选状态文件覆盖; move_session 传入 memory_state_path 结果,
            其余调用方默认 None 回落 settings.MEMORY_DIR。

    返回:
        entry dict 副本, 不存在时返回 None; 被 move_session 判断是否已
        consolidate, 被 dream.py 校验 consolidation 是否完成, 被
        needs_consolidation 比较 consolidated_hash。
    """
    with _STATE_LOCK:
        state = _load_unlocked(_state_path(space, path))
        entry = state["sources"].get(_source_id(space, project, session_id))
        return dict(entry) if entry else None


def list_session_sources(
    space: str,
    *,
    path: Path | None = None,
) -> list[dict[str, Any]]:
    """Return consolidation source states for memory status projections."""
    with _STATE_LOCK:
        state = _load_unlocked(_state_path(space, path))
        entries = [dict(entry) for entry in state["sources"].values()]
    return sorted(entries, key=lambda entry: entry.get("last_updated_at") or "", reverse=True)


def discard_session_source(
    space: str,
    project: str,
    session_id: str,
    *,
    path: Path | None = None,
) -> None:
    """删除指定会话事件源的状态条目 (会话跨项目迁移后清理旧绑定)。

    参数:
        space: memory space; 来自 sessions/store.py move_session 的
            manifest["space"]。
        project: 源项目名; 同来源的 source_project。
        session_id: 会话 ID; 同来源。
        path: 可选状态文件覆盖; move_session 传入 memory_state_path 结果。

    返回:
        无返回值; 条目存在时删除并持久化, 不存在时为 no-op。
    """
    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        if state["sources"].pop(_source_id(space, project, session_id), None) is not None:
            _save_unlocked(state_path, state)


def needs_consolidation(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    path: Path | None = None,
) -> bool:
    """判断指定 source_hash 是否尚未被 consolidate。

    参数:
        space: memory space; 来自 cleo/agents/dream.py invoke 的会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 来自 dream.py
            中 load_validated_compact 返回 payload 的 source 字段。
        path: 可选状态文件覆盖, 供测试注入。

    返回:
        True 表示无记录或 processed_hash 与 source_hash 不同; 被 dream.py
        用来决定运行 gate/整理流程。旧状态没有 processed_hash 时兼容回退到
        consolidated_hash。
    """
    entry = get_session_source(space, project, session_id, path=path)
    if entry is None:
        return True
    processed_hash = entry.get("processed_hash") or entry.get("consolidated_hash")
    return processed_hash != source_hash


def mark_consolidation_skipped(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    reason: str,
    gate_result: dict[str, Any],
    path: Path | None = None,
) -> dict[str, Any]:
    """Mark a source revision as reviewed without claiming it entered memory."""
    if not reason.strip():
        raise ValueError("a skipped consolidation requires a reason")
    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None or entry.get("source_hash") != source_hash:
            raise ValueError("memory source changed before gate decision was recorded")
        now = _now_iso()
        entry["processed_hash"] = source_hash
        entry["processed_version"] = int(entry.get("source_version", 0))
        entry["processing_decision"] = "skipped"
        entry["processing_reason"] = reason.strip()
        entry["gate_result"] = dict(gate_result)
        entry["status"] = "skipped"
        entry["last_processed_at"] = now
        entry["last_error"] = None
        _save_unlocked(state_path, state)
        return dict(entry)


def mark_consolidation_started(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    gate_result: dict[str, Any] | None = None,
    path: Path | None = None,
) -> dict[str, Any]:
    """把指定 source 标记为 running, 表示一次 consolidation 已开始。

    参数:
        space: memory space; 来自 cleo/agents/dream.py invoke 的会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 来自 dream.py
            从 load_validated_compact payload 中取出的值, 用于防止事件源在
            启动前被改写。
        path: 可选状态文件覆盖, 供测试注入。

    返回:
        更新后的 entry dict 副本; source 缺失或 hash 不匹配时抛 ValueError。
        dream.py 不使用返回值, 仅依赖其副作用与校验。
    """
    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None or entry.get("source_hash") != source_hash:
            raise ValueError("memory source changed before consolidation started")
        entry["status"] = "running"
        if gate_result is not None:
            entry["gate_result"] = dict(gate_result)
        entry["last_started_at"] = _now_iso()
        entry["last_error"] = None
        _save_unlocked(state_path, state)
        return dict(entry)


def mark_consolidation_failed(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    error: str,
    *,
    path: Path | None = None,
) -> dict[str, Any] | None:
    """把指定 source 标记为 failed 并累计 failure_count, 记录截断后的错误。

    参数:
        space: memory space; 来自 cleo/agents/dream.py invoke 异常分支的
            会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 启动 consolidation 时的 source hash; 仅当其仍与当前
            source_hash 一致时才更新状态, 避免覆盖新修订。
        error: 异常文本; 来自 dream.py 捕获的 str(exc), 截断到 2000 字符。
        path: 可选状态文件覆盖, 供测试注入。

    返回:
        更新后的 entry dict 副本; source 不存在时返回 None (no-op)。
        dream.py 不使用返回值, 仅依赖副作用。
    """
    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None:
            return None
        if entry.get("source_hash") == source_hash:
            entry["status"] = "failed"
            entry["failure_count"] = int(entry.get("failure_count", 0)) + 1
            entry["last_error"] = str(error)[:2000]
            entry["last_failed_at"] = _now_iso()
            _save_unlocked(state_path, state)
        return dict(entry)


def mark_consolidated(
    space: str,
    project: str,
    session_id: str,
    source_hash: str,
    *,
    durable_memory_count: int,
    no_durable_memory_reason: str = "",
    path: Path | None = None,
) -> dict[str, Any]:
    """提交 consolidation 完成态: 绑定 consolidated_hash 并记录产出统计。

    参数:
        space: memory space; 来自 dream_agent_tools.py
            complete_memory_consolidation 的工具入参 (由 DreamAgent 按
            prompt 中的会话上下文传入)。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。
        source_hash: 当前 compact 投影的 source_content_hash; 同来源, 已在
            工具内与 load_validated_compact 比对过。
        durable_memory_count: 本次 source 产出的 evidence-backed 记忆条数;
            已在 complete_memory_consolidation 中与 count_source_memories
            核对, 不能为负。
        no_durable_memory_reason: 零产出时的必填原因; 同来源的 DreamAgent
            汇报文本。
        path: 可选状态文件覆盖, 供测试注入。

    返回:
        更新后的 entry dict 副本; 被 complete_memory_consolidation 读取
        source_version 组 JSON 返回给 DreamAgent。source 缺失或 hash 不
        匹配时抛 ValueError。
    """
    if durable_memory_count < 0:
        raise ValueError("durable_memory_count cannot be negative")
    if durable_memory_count == 0 and not no_durable_memory_reason.strip():
        raise ValueError("a no-op consolidation requires a reason")

    state_path = _state_path(space, path)
    with _STATE_LOCK:
        state = _load_unlocked(state_path)
        entry = state["sources"].get(_source_id(space, project, session_id))
        if entry is None or entry.get("source_hash") != source_hash:
            raise ValueError("memory source changed before consolidation completed")
        entry["consolidated_hash"] = source_hash
        entry["consolidated_version"] = int(entry.get("source_version", 0))
        entry["processed_hash"] = source_hash
        entry["processed_version"] = int(entry.get("source_version", 0))
        entry["processing_decision"] = "consolidated"
        entry["processing_reason"] = None
        entry["status"] = "complete"
        entry["failure_count"] = 0
        entry["last_error"] = None
        entry["last_consolidated_at"] = _now_iso()
        entry["last_processed_at"] = entry["last_consolidated_at"]
        entry["durable_memory_count"] = durable_memory_count
        entry["no_durable_memory_reason"] = no_durable_memory_reason.strip() or None
        _save_unlocked(state_path, state)
        return dict(entry)
