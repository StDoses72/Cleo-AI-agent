"""Persistent session manifests, append-only events, and the global session index."""

from __future__ import annotations

import json
import shutil
import sqlite3
import uuid
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

from langchain_core.messages import BaseMessage, messages_from_dict, messages_to_dict

from cleo.memory.compaction import (
    event_content_hash,
    load_events,
    write_compact_events,
)
from cleo.memory.paths import (
    MEMORY_SPACES,
    events_path,
    manifest_path,
    memory_database_path,
    memory_state_path,
    session_directory,
    validate_name,
    validate_space,
)
from cleo.memory.state import (
    discard_session_source,
    get_session_source,
    touch_session_source,
)
from cleo.memory.store import delete_conversation_chunks, replace_conversation_chunks

MANIFEST_SCHEMA_VERSION = 1
EVENT_SCHEMA_VERSION = 1


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO 8601 字符串。

    被 create_session / update_manifest / append_events / move_session
    用于填充 created_at / updated_at 字段。
    """
    return datetime.now(UTC).isoformat()


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """以原子写(tmp 文件 + replace)方式写单个 JSON 文件, 避免半写状态。

    参数:
        path: 目标文件路径, 为 manifest.json 路径(来自
            cleo.memory.paths.manifest_path)。
        payload: 待序列化的 manifest 字典, 由 create_session /
            update_manifest / append_events / move_session 构造。
    无返回值。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    temp_path.replace(path)


def _atomic_write_jsonl(path: Path, payloads: list[dict[str, Any]]) -> None:
    """以原子写方式重写整个 JSONL 事件文件(每行一个事件)。

    参数:
        path: events.jsonl 路径, 来自 cleo.memory.paths.events_path。
        payloads: 全量事件列表, 由 move_session 在迁移会话目录时构造
            (逐条改写 project 字段后重写)。
    无返回值。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as stream:
        for payload in payloads:
            stream.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    temp_path.replace(path)


def _title_text(content: Any) -> str:
    """从消息 content(字符串或 content block 列表)提取纯文本标题素材。

    参数:
        content: 消息 content, 来自 append_events 中 user 消息的
            event["content"](LangChain 序列化消息可能是 block 列表)。
    返回:
        压缩空白后的纯文本; 供 _automatic_title 截断为会话标题。
    """
    if isinstance(content, str):
        return " ".join(content.split())
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return " ".join(" ".join(parts).split())
    return ""


def _automatic_title(content: Any, limit: int = 60) -> str | None:
    """根据首条用户消息内容自动生成截断标题(超长加省略号)。

    参数:
        content: 用户消息 content, 来自 append_events 中 event["content"]。
        limit: 标题最大长度, 默认 60, 目前无调用方覆盖。
    返回:
        标题字符串, 空内容返回 None; 被 append_events 写入
        manifest["title"]。
    """
    title = _title_text(content)
    if not title:
        return None
    if len(title) <= limit:
        return title
    return title[: limit - 3].rstrip() + "..."


def _message_type(serialized: dict[str, Any]) -> str:
    """从 LangChain 序列化消息中解析消息类型(human/ai/system/tool)。

    参数:
        serialized: messages_to_dict 产出的单条消息字典, 来自
            sync_langchain_messages 的遍历。
    返回:
        类型字符串(缺省 "unknown"), 供 _event_type_for_message /
        _actor_for_message 映射。
    """
    data = serialized.get("data") if isinstance(serialized.get("data"), dict) else serialized
    return str(serialized.get("type") or data.get("type") or "unknown")


def _message_data(serialized: dict[str, Any]) -> dict[str, Any]:
    """取序列化消息的 data 载荷(无 data 时返回消息本身, 兼容两种格式)。

    参数:
        serialized: messages_to_dict 产出的消息字典, 来自
            sync_langchain_messages。
    返回:
        消息数据字典, 供 _message_content 与 sync_langchain_messages
        读取 id / created_at。
    """
    data = serialized.get("data")
    return data if isinstance(data, dict) else serialized


def _message_content(serialized: dict[str, Any]) -> Any:
    """提取序列化消息中的 content 字段。

    参数:
        serialized: messages_to_dict 产出的消息字典, 来自
            sync_langchain_messages。
    返回:
        原始 content(字符串或 block 列表), 作为事件的 content 写入。
    """
    return _message_data(serialized).get("content")


def _event_type_for_message(message_type: str) -> str:
    """把 LangChain 消息类型映射为事件类型(event type)。

    参数:
        message_type: _message_type 的解析结果。
    返回:
        "user_message"/"assistant_message"/"system_message"/"tool_result",
        未知类型归为 "provider_event"; 被 sync_langchain_messages 消费。
    """
    return {
        "human": "user_message",
        "ai": "assistant_message",
        "system": "system_message",
        "tool": "tool_result",
    }.get(message_type, "provider_event")


def _actor_for_message(message_type: str) -> str:
    """把 LangChain 消息类型映射为事件行为者(actor)。

    参数:
        message_type: _message_type 的解析结果。
    返回:
        "user"/"assistant"/"system"/"tool", 未知类型归为 "provider";
        被 sync_langchain_messages 消费。
    """
    return {
        "human": "user",
        "ai": "assistant",
        "system": "system",
        "tool": "tool",
    }.get(message_type, "provider")


class SessionStore:
    """File-first session storage with a rebuildable global SQLite registry."""

    def __init__(self, memory_root: Path | str, index_path: Path | str | None = None) -> None:
        """初始化存储: 定位 memory 根目录与 SQLite 索引, 并确保索引表存在。

        参数:
            memory_root: memory 根目录, 由调用方传入 settings.MEMORY_DIR
                (cleo/cli/application.py:184、chat.py:89、lifecycle.py:32)
                或 harness adapter 的项目 memory 目录
                (cleo/harnesses/adapter.py:53)。
            index_path: 全局会话索引 SQLite 路径, 缺省为
                memory_root/sessions.sqlite3; CLI 传入
                settings.SESSION_INDEX_PATH。
        """
        self.memory_root = Path(memory_root).expanduser().resolve()
        self.index_path = (
            Path(index_path).expanduser().resolve()
            if index_path is not None
            else self.memory_root / "sessions.sqlite3"
        )
        self._lock = RLock()
        self._index_ready = False
        self._event_id_cache: dict[
            str,
            tuple[tuple[int, int, int] | None, set[str], int],
        ] = {}
        self._ensure_index()

    def create_session(
        self,
        *,
        session_id: str,
        space: str,
        project: str,
        provider: str,
        owner_type: str,
        native_session_id: str | None = None,
        owner_id: str | None = None,
        cwd: str | None = None,
        parent_session_id: str | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """创建新会话: 写 manifest.json、登记 SQLite 索引并追加 session_created 事件。

        参数(keyword-only):
            session_id: 会话 id, 由 ensure_session 透传, 最终来自
                cleo/harnesses/adapter.py:368(fork/native 会话登记)。
            space / project: 所属 memory space 与项目名, 来源同上
                (productivity 空间下的项目名)。
            provider: harness 提供方(如 "codex"/"claude"), 来源同上。
            owner_type / owner_id: 会话归属类型与归属者 id, 来源同上。
            native_session_id: 关联的 native harness 会话 id(可空), 来源同上。
            cwd: 会话工作目录, 来源同上。
            parent_session_id: fork 来源会话 id(可空), 来自 adapter.fork_session。
            tags: 标签列表(去重排序后存储), 来源同上。
        返回:
            新建会话的 manifest 字典(经 load_manifest 重读), 被
            ensure_session 透传给 adapter / sync_langchain_messages。
            会话已存在时抛 ValueError。
        """
        space = validate_space(space)
        project = validate_name(project, "project")
        session_id = validate_name(session_id, "session_id")
        provider = validate_name(provider, "provider")
        owner_type = validate_name(owner_type, "owner_type")
        path = manifest_path(self.memory_root, space, project, session_id)
        with self._lock:
            if path.exists() or self._session_index_row(session_id) is not None:
                raise ValueError(f"session already exists: {session_id}")
            now = _now_iso()
            manifest = {
                "schema_version": MANIFEST_SCHEMA_VERSION,
                "id": session_id,
                "space": space,
                "project": project,
                "provider": provider,
                "native_session_id": native_session_id,
                "owner_type": owner_type,
                "owner_id": owner_id,
                "status": "created",
                "title": None,
                "cwd": cwd,
                "parent_session_id": parent_session_id,
                "tags": sorted({str(tag).strip() for tag in (tags or []) if str(tag).strip()}),
                "last_event_seq": 0,
                "last_compacted_seq": 0,
                "source_hash": None,
                "source_version": 0,
                "created_at": now,
                "updated_at": now,
            }
            _atomic_write_json(path, manifest)
            self._upsert_index(manifest, path)
            self.append_event(
                space=space,
                project=project,
                session_id=session_id,
                event_type="session_created",
                actor="system",
                data={
                    "provider": provider,
                    "owner_type": owner_type,
                    "native_session_id": native_session_id,
                    "owner_id": owner_id,
                    "cwd": cwd,
                    "parent_session_id": parent_session_id,
                    "tags": manifest["tags"],
                },
            )
            return self.load_manifest(session_id)

    def ensure_session(self, **kwargs: Any) -> dict[str, Any]:
        """幂等获取会话: 已存在则返回 manifest, 不存在则按 kwargs 创建。

        参数:
            **kwargs: 与 create_session 相同的参数集, 必须含 session_id;
                由 sync_langchain_messages:372 透传(来自
                cleo/cli/lifecycle.py:33 的调用)。
        返回:
            已存在或新建的 manifest 字典, 供 sync_langchain_messages
            读取 status 等信息。
        """
        session_id = validate_name(str(kwargs["session_id"]), "session_id")
        try:
            return self.load_manifest(session_id)
        except FileNotFoundError:
            return self.create_session(**kwargs)

    def load_manifest(self, session_id: str) -> dict[str, Any]:
        """按 session_id 加载并校验 manifest.json(索引缺失时先重建索引)。

        参数:
            session_id: 会话 id, 调用方遍布 CLI 与 adapter:
                cleo/cli/application.py:201/230、chat.py:299/333、
                productivity.py:82/352/552、cleo/harnesses/adapter.py:330/366,
                以及本类内部各方法。
        返回:
            manifest 字典, 被上述调用方读取 space/project/status/title
            等字段; 不存在或文件损坏时抛 FileNotFoundError。
        """
        session_id = validate_name(session_id, "session_id")
        with self._lock:
            row = self._session_index_row(session_id)
            if row is None:
                self.rebuild_index()
                row = self._session_index_row(session_id)
            if row is None:
                raise FileNotFoundError(session_id)
            path = Path(row["manifest_path"])
            try:
                manifest = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError) as exc:
                raise FileNotFoundError(session_id) from exc
            self._validate_manifest(manifest)
            return manifest

    def update_manifest(self, session_id: str, **changes: Any) -> dict[str, Any]:
        """合并修改 manifest 字段(身份字段受保护)并同步索引。

        参数:
            session_id: 目标会话 id。
            **changes: 待更新字段, 来自 cleo/harnesses/adapter.py:276/297/379
                (runtime_options、title 等)与本类 refresh_compact;
                含 schema_version/id/space/project/created_at 时抛 ValueError。
        返回:
            更新后的 manifest, 被 rename_session 与 adapter 消费。
        """
        with self._lock:
            manifest = self.load_manifest(session_id)
            protected = {"schema_version", "id", "space", "project", "created_at"}
            if protected & changes.keys():
                raise ValueError("session identity fields cannot be updated")
            manifest.update(changes)
            manifest["updated_at"] = _now_iso()
            path = manifest_path(
                self.memory_root,
                manifest["space"],
                manifest["project"],
                manifest["id"],
            )
            _atomic_write_json(path, manifest)
            self._upsert_index(manifest, path)
            return manifest

    def append_event(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
        event_type: str,
        actor: str,
        content: Any = None,
        data: dict[str, Any] | None = None,
        message: dict[str, Any] | None = None,
        source_message_id: str | None = None,
        event_id: str | None = None,
        created_at: str | None = None,
    ) -> dict[str, Any]:
        """追加单个事件的便捷封装(内部转发给 append_events)。

        参数(keyword-only):
            space / project / session_id: 事件归属定位; 来自
                create_session(session_created)与
                cleo/harnesses/adapter.py:303(rename 事件)。
            event_type / actor: 事件类型与行为者, 来源同上。
            content / data / message / source_message_id: 事件载荷(可空)。
            event_id / created_at: 显式指定事件 id 与时间(可空, 缺省自动生成)。
        返回:
            实际写入的事件字典, 供调用方读取 id/seq。
        """
        events = self.append_events(
            space=space,
            project=project,
            session_id=session_id,
            events=[
                {
                    "type": event_type,
                    "actor": actor,
                    "content": content,
                    "data": data or {},
                    "message": message,
                    "source_message_id": source_message_id,
                    "id": event_id,
                    "created_at": created_at,
                }
            ],
        )
        return events[0]

    def append_events(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
        events: list[dict[str, Any]],
        manifest_updates: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """批量追加事件到 events.jsonl(按 id 幂等去重), 并同步 manifest 与索引。

        已持久化事件的 id 和末尾序号经 _cached_event_state 按文件元数据
        签名缓存复用,避免每次追加都全量重读 events.jsonl;文件被外部写入
        导致 mtime/ctime/size 变化时自动重读。

        参数(keyword-only):
            space / project / session_id: 事件归属, 必须与 manifest 一致,
                否则抛 ValueError; 来自 append_event、
                sync_langchain_messages、set_status 及
                cleo/harnesses/adapter.py:137/177(流式 harness 事件)。
            events: 事件字典列表(type/actor 必填, content/data/message/
                source_message_id/id/created_at 可选), 由上述调用方构造。
            manifest_updates: 顺带合并进 manifest 的字段(如 status)。
        返回:
            实际写入的事件列表(跳过重复 id); 首条 user 消息会触发
            自动标题写入 manifest["title"]。返回值被 append_event 取首元素,
            adapter 调用方一般忽略。
        """
        space = validate_space(space)
        project = validate_name(project, "project")
        session_id = validate_name(session_id, "session_id")
        if not events:
            return []
        with self._lock:
            manifest = self.load_manifest(session_id)
            if (manifest["space"], manifest["project"]) != (space, project):
                raise ValueError("session event binding does not match its manifest")
            output_path = events_path(self.memory_root, space, project, session_id)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            existing_ids, last_written_seq = self._cached_event_state(session_id, output_path)
            # The event log may be ahead of a manifest whose atomic write failed.
            next_seq = max(int(manifest.get("last_event_seq", 0)), last_written_seq)
            appended: list[dict[str, Any]] = []
            for item in events:
                event_type = validate_name(str(item.get("type") or ""), "event_type")
                actor = validate_name(str(item.get("actor") or ""), "actor")
                event_id = str(item.get("id") or f"evt_{uuid.uuid4().hex}")
                if event_id in existing_ids:
                    continue
                next_seq += 1
                event: dict[str, Any] = {
                    "schema_version": EVENT_SCHEMA_VERSION,
                    "id": event_id,
                    "seq": next_seq,
                    "session_id": session_id,
                    "space": space,
                    "project": project,
                    "type": event_type,
                    "actor": actor,
                    "created_at": item.get("created_at") or _now_iso(),
                }
                for key in ("content", "data", "message", "source_message_id"):
                    value = item.get(key)
                    if value not in (None, {}, []):
                        event[key] = value
                appended.append(event)
                existing_ids.add(event_id)

            if appended:
                with output_path.open("a", encoding="utf-8", newline="\n") as stream:
                    for event in appended:
                        stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
                    stream.flush()
                output_stat = output_path.stat()
                self._event_id_cache[session_id] = (
                    (
                        output_stat.st_mtime_ns,
                        output_stat.st_ctime_ns,
                        output_stat.st_size,
                    ),
                    set(existing_ids),
                    next_seq,
                )
                if not manifest.get("title"):
                    for event in appended:
                        if (
                            event.get("type") == "user_message"
                            or event.get("actor") == "user"
                        ):
                            title = _automatic_title(event.get("content"))
                            if title:
                                manifest["title"] = title
                                break
            manifest["last_event_seq"] = next_seq
            if manifest_updates:
                manifest.update(manifest_updates)
            manifest["updated_at"] = _now_iso()
            manifest_file = manifest_path(self.memory_root, space, project, session_id)
            _atomic_write_json(manifest_file, manifest)
            self._upsert_index(manifest, manifest_file)
            return appended

    def read_events(self, session_id: str) -> list[dict[str, Any]]:
        """读取会话的全部事件(events.jsonl 不存在时返回空列表)。

        参数:
            session_id: 会话 id, 由 sync_langchain_messages
                (查 source_message_id)、load_langchain_messages、
                move_session、refresh_compact 及 tests 传入。
        返回:
            事件字典列表, 经 cleo.memory.compaction.load_events 解析;
            被 refresh_compact 用于计算 source_hash 与 compact 载荷。
        """
        manifest = self.load_manifest(session_id)
        path = events_path(
            self.memory_root,
            manifest["space"],
            manifest["project"],
            session_id,
        )
        return load_events(path) if path.exists() else []

    def _cached_event_state(self, session_id: str, path: Path) -> tuple[set[str], int]:
        """Return committed event IDs and the last sequence, invalidated by file metadata.

        Copy the ID set so a failed append cannot contaminate the cache. Sequence
        recovery uses the authoritative log, including after a process restart.
        """
        stat = path.stat() if path.exists() else None
        signature = (
            (stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
            if stat is not None
            else None
        )
        cached = self._event_id_cache.get(session_id)
        if cached is not None and cached[0] == signature:
            return set(cached[1]), cached[2]
        events = load_events(path) if path.exists() else []
        ids = {
            str(event.get("id"))
            for event in events
            if event.get("id")
        }
        last_seq = int(events[-1]["seq"]) if events else 0
        self._event_id_cache[session_id] = (signature, ids, last_seq)
        return set(ids), last_seq

    def sync_langchain_messages(
        self,
        *,
        session_id: str,
        space: str,
        project: str,
        messages: list[BaseMessage],
        provider: str = "cleo",
        owner_type: str = "user",
        cwd: str | None = None,
        status: str = "active",
    ) -> dict[str, Any]:
        """把 LangChain 消息历史同步为持久事件(按 source_message_id 幂等)。

        参数(keyword-only):
            session_id / space / project: 会话定位; 来自
                cleo/cli/lifecycle.py:33(聊天循环每轮结束后同步)。
            messages: LangChain BaseMessage 列表, 为 agent 内存中的完整
                对话历史, 来源同上。
            provider / owner_type / cwd: 会话首次创建时使用的元数据。
            status: 目标会话状态, 变化时追加 session_<status> 系统事件。
        返回:
            refresh_compact 产出的 compact 载荷字典; 当前生产调用方
            (lifecycle.py)未消费返回值。
        """
        manifest = self.ensure_session(
            session_id=session_id,
            space=space,
            project=project,
            provider=provider,
            owner_type=owner_type,
            cwd=cwd,
        )
        existing_source_ids = {
            str(event.get("source_message_id"))
            for event in self.read_events(session_id)
            if event.get("source_message_id")
        }
        serialized_messages = messages_to_dict(messages)
        new_events: list[dict[str, Any]] = []
        for index, serialized in enumerate(serialized_messages):
            data = _message_data(serialized)
            message_type = _message_type(serialized)
            source_message_id = str(data.get("id") or f"{message_type}-{index}")
            data["id"] = source_message_id
            if source_message_id in existing_source_ids:
                continue
            new_events.append(
                {
                    "type": _event_type_for_message(message_type),
                    "actor": _actor_for_message(message_type),
                    "content": _message_content(serialized),
                    "message": serialized,
                    "source_message_id": source_message_id,
                    "created_at": data.get("created_at"),
                }
            )

        if status != manifest.get("status"):
            new_events.append(
                {
                    "type": f"session_{status}",
                    "actor": "system",
                    "data": {"previous_status": manifest.get("status")},
                }
            )
        self.append_events(
            space=space,
            project=project,
            session_id=session_id,
            events=new_events,
            manifest_updates={"status": status},
        )
        return self.refresh_compact(session_id)

    def load_langchain_messages(self, session_id: str) -> list[BaseMessage]:
        """从持久事件中还原 LangChain 消息历史(仅取带 message 载荷的事件)。

        参数:
            session_id: 会话 id, 来自 cleo/cli/application.py:207/231
                (启动恢复)与 cleo/cli/chat.py:248/339(移动/恢复会话)。
        返回:
            BaseMessage 列表, 被上述调用方塞回 agent 记忆以续聊。
        """
        serialized = [
            event["message"]
            for event in self.read_events(session_id)
            if isinstance(event.get("message"), dict)
        ]
        return messages_from_dict(serialized)

    def set_status(
        self,
        session_id: str,
        status: str,
        *,
        error: str | None = None,
        refresh_compact: bool = True,
    ) -> dict[str, Any]:
        """变更会话状态(追加 session_<status> 系统事件并更新 manifest)。

        参数:
            session_id: 目标会话 id, 来自 cleo/harnesses/adapter.py
                (failed:154、archived:318、cancelled:323、closed:332)。
            status: 目标状态; 允许带 "session_" 前缀, 落库时统一去掉。
            error: 失败原因(可选), 来自 adapter 的异常信息。
            refresh_compact: 是否顺带重建 compact(默认 True)。
        返回:
            更新后的 manifest, adapter 调用方未消费返回值。
        """
        manifest = self.load_manifest(session_id)
        if manifest.get("status") == status and error is None:
            return manifest
        event_type = status if status.startswith("session_") else f"session_{status}"
        self.append_events(
            space=manifest["space"],
            project=manifest["project"],
            session_id=session_id,
            events=[
                {
                    "type": event_type,
                    "actor": "system",
                    "content": error,
                    "data": {"previous_status": manifest.get("status")},
                }
            ],
            manifest_updates={"status": status.removeprefix("session_"), "error": error},
        )
        if refresh_compact:
            self.refresh_compact(session_id)
        return self.load_manifest(session_id)

    def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        """重命名会话(压缩空白、截断 120 字符, 空标题抛 ValueError)。

        参数:
            session_id / title: 目标会话与新标题, 来自
                cleo/cli/chat.py:186(/rename 命令)。
        返回:
            更新后的 manifest, 供 chat.py 确认展示。
        """
        normalized = " ".join(str(title).split())
        if not normalized:
            raise ValueError("title cannot be empty")
        return self.update_manifest(session_id, title=normalized[:120])

    def delete_session(self, session_id: str) -> dict[str, Any]:
        """Permanently delete one local session and its derived conversation state."""
        session_id = validate_name(session_id, "session_id")
        with self._lock:
            manifest = self.load_manifest(session_id)
            space = str(manifest["space"])
            project = str(manifest["project"])
            directory = session_directory(self.memory_root, space, project, session_id)

            discard_session_source(
                space,
                project,
                session_id,
                path=memory_state_path(self.memory_root, space),
            )
            delete_conversation_chunks(
                space=space,
                project=project,
                session_id=session_id,
                path=memory_database_path(self.memory_root, space),
            )
            shutil.rmtree(directory)
            with closing(sqlite3.connect(self.index_path)) as conn, conn:
                conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            self._event_id_cache.pop(session_id, None)
            return manifest

    def move_session(self, session_id: str, target_project: str) -> dict[str, Any]:
        """把会话整体迁移到目标项目(移动目录、重写事件、清理源侧记忆)。

        已 consolidate 进当前项目的会话拒绝迁移(抛 ValueError);
        迁移会重写所有事件的 project 字段、追加 session_project_moved
        事件、更新索引、丢弃源项目的 session source 与 conversation
        chunks, 最后重建 compact。

        参数:
            session_id / target_project: 目标会话与目标项目名, 来自
                cleo/cli/chat.py:249(/move 命令)。
        返回:
            迁移后的 manifest, 供 chat.py 确认展示。
        """
        target_project = validate_name(target_project, "project")
        with self._lock:
            manifest = self.load_manifest(session_id)
            source_project = str(manifest["project"])
            if source_project == target_project:
                return manifest

            state_path = memory_state_path(self.memory_root, manifest["space"])
            source_state = get_session_source(
                manifest["space"],
                source_project,
                session_id,
                path=state_path,
            )
            if source_state and source_state.get("consolidated_hash"):
                raise ValueError(
                    "thread has already been consolidated into its current project"
                )

            source_directory = session_directory(
                self.memory_root,
                manifest["space"],
                source_project,
                session_id,
            )
            target_directory = session_directory(
                self.memory_root,
                manifest["space"],
                target_project,
                session_id,
            )
            if target_directory.exists():
                raise ValueError(f"target session already exists: {target_directory}")

            events = self.read_events(session_id)
            moved_at = _now_iso()
            for event in events:
                event["project"] = target_project
            last_written_seq = int(events[-1]["seq"]) if events else 0
            next_seq = max(int(manifest.get("last_event_seq", 0)), last_written_seq) + 1
            events.append(
                {
                    "schema_version": EVENT_SCHEMA_VERSION,
                    "id": f"evt_{uuid.uuid4().hex}",
                    "seq": next_seq,
                    "session_id": session_id,
                    "space": manifest["space"],
                    "project": target_project,
                    "type": "session_project_moved",
                    "actor": "system",
                    "created_at": moved_at,
                    "data": {
                        "previous_project": source_project,
                        "project": target_project,
                    },
                }
            )

            target_directory.parent.mkdir(parents=True, exist_ok=True)
            source_directory.replace(target_directory)
            self._event_id_cache.pop(session_id, None)
            manifest["project"] = target_project
            manifest["last_event_seq"] = next_seq
            manifest["updated_at"] = moved_at
            target_manifest = manifest_path(
                self.memory_root,
                manifest["space"],
                target_project,
                session_id,
            )
            _atomic_write_jsonl(
                events_path(
                    self.memory_root,
                    manifest["space"],
                    target_project,
                    session_id,
                ),
                events,
            )
            _atomic_write_json(target_manifest, manifest)
            self._upsert_index(manifest, target_manifest)

            discard_session_source(
                manifest["space"],
                source_project,
                session_id,
                path=state_path,
            )
            delete_conversation_chunks(
                space=manifest["space"],
                project=source_project,
                session_id=session_id,
                path=memory_database_path(self.memory_root, manifest["space"]),
            )
            self.refresh_compact(session_id)
            return self.load_manifest(session_id)

    def refresh_compact(self, session_id: str) -> dict[str, Any]:
        """重建会话的 compact 产物: 事件哈希、compact.json 与向量 chunks。

        参数:
            session_id: 会话 id, 由 sync_langchain_messages、set_status、
                move_session 及 cleo/harnesses/adapter.py:188/311 调用。
        返回:
            write_compact_events 产出的 compact 载荷字典(同时经
            replace_conversation_chunks 写入 memory 数据库);
            返回值供 sync_langchain_messages 透传, adapter 未消费。
        """
        with self._lock:
            manifest = self.load_manifest(session_id)
            events = self.read_events(session_id)
            last_event_seq = int(events[-1]["seq"]) if events else 0
            source_hash = event_content_hash(events)
            source_state = touch_session_source(
                space=manifest["space"],
                project=manifest["project"],
                session_id=session_id,
                source_hash=source_hash,
                last_event_seq=last_event_seq,
                path=memory_state_path(self.memory_root, manifest["space"]),
            )
            _, payload = write_compact_events(
                memory_root=self.memory_root,
                space=manifest["space"],
                project=manifest["project"],
                session_id=session_id,
                events=events,
                source_version=int(source_state["source_version"]),
            )
            replace_conversation_chunks(
                payload,
                path=memory_database_path(self.memory_root, manifest["space"]),
            )
            self.update_manifest(
                session_id,
                last_event_seq=last_event_seq,
                last_compacted_seq=last_event_seq,
                source_hash=source_hash,
                source_version=int(source_state["source_version"]),
            )
            return payload

    def find_by_native_session(
        self,
        *,
        provider: str,
        native_session_id: str,
        space: str = "productivity",
    ) -> dict[str, Any] | None:
        self._ensure_index()
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT manifest_path FROM sessions
                WHERE provider = ? AND native_session_id = ? AND space = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (provider, native_session_id, validate_space(space)),
            ).fetchone()
        if row is None:
            return None
        return json.loads(Path(row["manifest_path"]).read_text(encoding="utf-8-sig"))

    def list_sessions(
        self,
        *,
        space: str | None = None,
        project: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[str] = []
        if space is not None:
            clauses.append("space = ?")
            values.append(validate_space(space))
        if project is not None:
            clauses.append("project = ?")
            values.append(validate_name(project, "project"))
        if status is not None:
            clauses.append("status = ?")
            values.append(status)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT * FROM sessions {where} ORDER BY updated_at DESC",
                values,
            ).fetchall()
        return [dict(row) for row in rows]

    def rebuild_index(self) -> int:
        manifests: list[tuple[dict[str, Any], Path]] = []
        for space in MEMORY_SPACES:
            pattern = f"{space}/projects/*/sessions/*/manifest.json"
            for path in self.memory_root.glob(pattern):
                try:
                    manifest = json.loads(path.read_text(encoding="utf-8-sig"))
                    self._validate_manifest(manifest)
                except (OSError, json.JSONDecodeError, ValueError):
                    continue
                manifests.append((manifest, path))
        with self._lock:
            self._ensure_index()
            with closing(sqlite3.connect(self.index_path)) as conn, conn:
                conn.execute("DELETE FROM sessions")
            for manifest, path in manifests:
                self._upsert_index(manifest, path)
        return len(manifests)

    def _ensure_index(self) -> None:
        """确保全局会话索引 SQLite 表结构存在(每实例仅执行一次 DDL)。

        首次调用(构造时)执行建表 DDL 并置 _index_ready; 之后
        _upsert_index / _session_index_row / find_by_native_session /
        rebuild_index 的重复调用直接跳过。索引文件被外部删除时自动
        重建; 双重检查经 _lock 保证线程安全。
        """
        if self._index_ready and self.index_path.exists():
            return
        with self._lock:
            if self._index_ready and self.index_path.exists():
                return
            self.index_path.parent.mkdir(parents=True, exist_ok=True)
            with closing(sqlite3.connect(self.index_path)) as conn, conn:
                conn.execute("PRAGMA journal_mode = WAL")
                conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        space TEXT NOT NULL,
                        project TEXT NOT NULL,
                        provider TEXT NOT NULL,
                        native_session_id TEXT,
                        owner_type TEXT NOT NULL,
                        owner_id TEXT,
                        status TEXT NOT NULL,
                        title TEXT,
                        cwd TEXT,
                        parent_session_id TEXT,
                        manifest_path TEXT NOT NULL UNIQUE,
                        last_event_seq INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_sessions_scope
                        ON sessions(space, project, status, updated_at);
                    CREATE INDEX IF NOT EXISTS idx_sessions_native
                        ON sessions(provider, native_session_id);
                    """
                )
                columns = {
                    str(row[1]) for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
                }
                if "title" not in columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN title TEXT")
            self._index_ready = True

    def _upsert_index(self, manifest: dict[str, Any], path: Path) -> None:
        self._ensure_index()
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.execute(
                """
                INSERT INTO sessions(
                    id, space, project, provider, native_session_id, owner_type,
                    owner_id, status, title, cwd, parent_session_id, manifest_path,
                    last_event_seq, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    space = excluded.space,
                    project = excluded.project,
                    provider = excluded.provider,
                    native_session_id = excluded.native_session_id,
                    owner_type = excluded.owner_type,
                    owner_id = excluded.owner_id,
                    status = excluded.status,
                    title = excluded.title,
                    cwd = excluded.cwd,
                    parent_session_id = excluded.parent_session_id,
                    manifest_path = excluded.manifest_path,
                    last_event_seq = excluded.last_event_seq,
                    updated_at = excluded.updated_at
                """,
                (
                    manifest["id"],
                    manifest["space"],
                    manifest["project"],
                    manifest["provider"],
                    manifest.get("native_session_id"),
                    manifest["owner_type"],
                    manifest.get("owner_id"),
                    manifest["status"],
                    manifest.get("title"),
                    manifest.get("cwd"),
                    manifest.get("parent_session_id"),
                    str(path),
                    int(manifest.get("last_event_seq", 0)),
                    manifest["created_at"],
                    manifest["updated_at"],
                ),
            )

    def _session_index_row(self, session_id: str) -> sqlite3.Row | None:
        self._ensure_index()
        with closing(sqlite3.connect(self.index_path)) as conn, conn:
            conn.row_factory = sqlite3.Row
            return conn.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()

    @staticmethod
    def _validate_manifest(manifest: dict[str, Any]) -> None:
        if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
            raise ValueError("session manifest schema is not supported")
        validate_space(str(manifest.get("space") or ""))
        validate_name(str(manifest.get("project") or ""), "project")
        validate_name(str(manifest.get("id") or ""), "session_id")
        validate_name(str(manifest.get("provider") or ""), "provider")
        validate_name(str(manifest.get("owner_type") or ""), "owner_type")
