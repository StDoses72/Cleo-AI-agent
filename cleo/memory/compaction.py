"""Deterministic, evidence-preserving projection of append-only session events."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.memory.paths import compact_path, events_path, manifest_path

SCHEMA_VERSION = 2

_OMIT_RESULT_TOOLS = {"read_file", "ls", "glob", "grep"}
_FILE_WRITE_TOOLS = {"write_file", "edit_file", "apply_patch"}
_SECRET_KEY_PARTS = (
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
)
_LARGE_ARGUMENT_KEYS = {"content", "patch", "new_string", "old_string"}
_SENSITIVE_TEXT = re.compile(
    r"(?i)\b(api[_ -]?key|authorization|password|secret|token)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)
_BEARER_TOKEN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}")


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO 8601 字符串, 供 compression 时间戳等字段使用。"""
    return datetime.now(UTC).isoformat()


def _canonical_json(value: Any) -> str:
    """把任意值序列化为 key 排序、无多余空白的 canonical JSON 字符串。

    参数:
        value: 待序列化的值; 来自本文件内 event_content_hash、
            _content_characters、_bounded_text 与 compact_events。

    返回:
        稳定可比较的 JSON 文本, 供 hash 计算与字符数统计使用。
    """
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def event_content_hash(events: list[dict[str, Any]]) -> str:
    """计算 append-only 事件日志内容的 SHA-256 content hash, 用于 stale 检测与 source 绑定。

    参数:
        events: 原始 session 事件列表; 来自 cleo/sessions/store.py 中
            read_events 的结果 (refresh_compact 传入), 或本文件
            load_validated_compact 中 load_events 读出的 events.jsonl 内容。

    返回:
        ``"sha256:<hex>"`` 形式的指纹字符串; 被 sessions/store.py 的
        refresh_compact 写入 manifest 与 memory_state, 也被
        load_validated_compact 用来校验 compact projection 是否与事件源一致。
    """
    digest = hashlib.sha256(_canonical_json(events).encode()).hexdigest()
    return f"sha256:{digest}"


def load_events(path: Path) -> list[dict[str, Any]]:
    """逐行读取 events.jsonl 并校验 seq 严格递增, 还原完整 append-only 事件列表。

    参数:
        path: events.jsonl 文件路径; 来自 events_path (本文件
            load_validated_compact) 或 sessions/store.py read_events 中
            拼出的 session 事件路径。

    返回:
        事件 dict 列表; 被 sessions/store.py read_events 返回给
        refresh_compact/move_session, 也被 load_validated_compact 用于
        hash 校验。非 object 行或 seq 非严格递增时抛 ValueError。
    """
    events: list[dict[str, Any]] = []
    previous_seq = 0
    with path.open(encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError(f"event line {line_number} is not an object")
            seq = int(event.get("seq", 0))
            if seq <= previous_seq:
                raise ValueError("session event sequence is not strictly increasing")
            previous_seq = seq
            events.append(event)
    return events


def _content_characters(content: Any) -> int:
    """统计 content 的字符数, 供 omitted/truncated 统计标记使用。

    参数:
        content: 任意消息或工具结果内容; 来自 _sanitize_value 与
            _compact_tool_result。

    返回:
        字符串长度或其 canonical JSON 长度 (int), 用于生成
        ``<omitted:N chars>`` 与 original_result_characters。
    """
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    return len(_canonical_json(content))


def _redact_text(value: str) -> str:
    """对文本中的 secret 模式 (api_key、token、Bearer 等) 做正则 redaction。

    参数:
        value: 待脱敏文本; 来自 _sanitize_value 与 _bounded_text。

    返回:
        敏感片段替换为 ``<redacted>`` 后的字符串, 回到原调用方的截断流程。
    """
    redacted = _SENSITIVE_TEXT.sub(lambda match: f"{match[1]}{match[2]}<redacted>", value)
    return _BEARER_TOKEN.sub("Bearer <redacted>", redacted)


def _sanitize_value(
    value: Any,
    key: str = "",
    *,
    truncate_strings: bool = True,
) -> Any:
    """递归脱敏并压缩任意值: redact secret 键、省略大字段、图片降级为引用。

    参数:
        value: 待清洗的值; 来自事件 args/result/content (经 _sanitize_args、
            _parse_json_result、_base_message、compact_events 传入)。
        key: 该值在父对象中的键名, 用于识别 secret/大字段; 顶层调用传 ""。
        truncate_strings: 是否截断超长字符串; 由调用方按场景控制
            (content 类不截断, args/result 类截断)。

    返回:
        结构不变但已脱敏/省略/截断的值, 最终进入 compact payload 的 events。
    """
    normalized_key = key.casefold()
    if any(part in normalized_key for part in _SECRET_KEY_PARTS):
        return "<redacted>"
    if normalized_key in _LARGE_ARGUMENT_KEYS:
        return f"<omitted:{_content_characters(value)} chars>"
    if normalized_key in {"base64", "data", "image_url"} and isinstance(value, str):
        return f"<binary-or-inline-data-omitted:{len(value)} chars>"
    if isinstance(value, dict):
        block_type = str(value.get("type") or "").casefold()
        if block_type in {"image", "image_url", "input_image"}:
            return {
                "type": "image_reference",
                "name": value.get("name"),
                "mime_type": value.get("mime_type"),
                "content_omitted": True,
            }
        return {
            str(child_key): _sanitize_value(
                child_value,
                str(child_key),
                truncate_strings=truncate_strings,
            )
            for child_key, child_value in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize_value(item, truncate_strings=truncate_strings) for item in value]
    if isinstance(value, str):
        text = _redact_text(value)
        if truncate_strings and len(text) > 1000 and key:
            return text[:1000] + f"... <truncated:{len(text) - 1000} chars>"
        return text
    return value


def _sanitize_args(args: Any) -> dict[str, Any]:
    """清洗 tool call 的 args dict, 生成 tool_event.args。

    参数:
        args: 工具调用参数; 来自 _tool_event 中 tool_call.get("args")。

    返回:
        逐键脱敏后的 dict; 非 dict 输入返回 {}, 由 _tool_event 合并进 tool_event。
    """
    if not isinstance(args, dict):
        return {}
    return {str(key): _sanitize_value(value, str(key)) for key, value in args.items()}


def _parse_json_result(content: Any) -> Any:
    """尝试把 tool result content 解析为 JSON 并脱敏, 无法解析时返回 None。

    参数:
        content: 工具结果内容; 来自 _compact_tool_result 的 result_message
            content。

    返回:
        脱敏后的 dict/list; 非 JSON 文本返回 None, 调用方据此回退到
        _bounded_text 的截断路径。
    """
    if isinstance(content, (dict, list)):
        return _sanitize_value(content)
    if not isinstance(content, str):
        return None
    text = content.strip()
    if not text or text[0] not in "[{":
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return _sanitize_value(parsed) if isinstance(parsed, (dict, list)) else None


def _bounded_text(content: Any, limit: int) -> tuple[Any, bool]:
    """对工具结果文本做 redaction 并按字符上限截断。

    参数:
        content: 工具结果内容; 来自 _compact_tool_result。
        limit: 字符上限; 由 _compact_tool_result 按是否 error 选 2000/1000。

    返回:
        ``(截断后的文本, 是否发生截断)`` 二元组, 供 _compact_tool_result
        组装 result 与 result_truncated 字段。
    """
    if content is None:
        return None, False
    if not isinstance(content, str):
        content = _canonical_json(content)
    content = _redact_text(content)
    if len(content) <= limit:
        return content, False
    return content[:limit] + f"... <truncated:{len(content) - limit} chars>", True


def _compact_tool_result(name: str, status: str, content: Any) -> tuple[dict[str, Any], int]:
    """把单个工具结果压缩为 compact 字段, 并统计被省略的字符数。

    参数:
        name: 工具名; 来自 _tool_event 从 tool_call/result_message 解析的结果,
            用于命中 _OMIT_RESULT_TOOLS/_FILE_WRITE_TOOLS 整体省略策略。
        status: 工具执行状态; 同来源, 非 success 时放宽截断上限到 2000。
        content: 工具结果内容; 来自 result_message.get("content")。

    返回:
        ``(compact 字段 dict, 省略字符数)`` 二元组; 字段并入 tool_event,
        字符数由 compact_events 累计进 compression.omitted_tool_characters。
    """
    result_characters = _content_characters(content)
    if name in _OMIT_RESULT_TOOLS or name in _FILE_WRITE_TOOLS:
        return (
            {
                "result_omitted": True,
                "original_result_characters": result_characters,
            },
            result_characters,
        )

    parsed_result = _parse_json_result(content)
    if parsed_result is not None:
        return {"result": parsed_result}, 0

    is_error = str(status).casefold() not in {"", "success", "completed"}
    limit = 2000 if is_error else 1000
    result, truncated = _bounded_text(content, limit)
    compacted: dict[str, Any] = {"result": result}
    if truncated:
        compacted["result_truncated"] = True
        compacted["original_result_characters"] = result_characters
        return compacted, max(0, result_characters - limit)
    return compacted, 0


def _normalize_message_event(event: dict[str, Any], index: int) -> dict[str, Any] | None:
    """把一条原始事件规范化为统一 message 结构, 非消息类事件返回 None。

    参数:
        event: 原始事件 dict; 来自 compact_events 遍历的 events 列表,
            兼容 "message" 包装与扁平 (user_message/tool_result 等) 两种格式。
        index: 事件在列表中的序号, 用于生成 fallback source_message_id。

    返回:
        规范化 message dict 或 None; 供 compact_events 分组组装
        tool_event 与 base message。
    """
    serialized = event.get("message")
    if isinstance(serialized, dict):
        data = serialized.get("data") if isinstance(serialized.get("data"), dict) else serialized
        message_type = str(serialized.get("type") or data.get("type") or "unknown")
        return {
            "id": str(event["id"]),
            "source_message_id": str(
                event.get("source_message_id")
                or data.get("id")
                or f"{message_type}-{index}"
            ),
            "type": message_type,
            "content": data.get("content"),
            "created_at": event.get("created_at") or data.get("created_at"),
            "name": data.get("name"),
            "status": data.get("status"),
            "tool_call_id": data.get("tool_call_id"),
            "tool_calls": data.get("tool_calls") or [],
        }

    event_type = str(event.get("type") or "")
    role = {
        "user_message": "human",
        "assistant_message": "ai",
        "system_message": "system",
        "tool_result": "tool",
    }.get(event_type)
    if role is None:
        return None
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    return {
        "id": str(event["id"]),
        "source_message_id": str(event.get("source_message_id") or event["id"]),
        "type": role,
        "content": event.get("content"),
        "created_at": event.get("created_at"),
        "name": data.get("name"),
        "status": data.get("status"),
        "tool_call_id": data.get("tool_call_id"),
        "tool_calls": data.get("tool_calls") or [],
    }


def _base_message(message: dict[str, Any]) -> dict[str, Any]:
    """生成消息类事件 (human/ai) 的 compact 表示, 保留 source event 引用。

    参数:
        message: 规范化 message; 来自 compact_events 中
            _normalize_message_event 的输出。

    返回:
        去除 None 字段后的 compact message dict, 由 compact_events 追加进
        payload["events"]。
    """
    compacted = {
        "id": message["id"],
        "type": message["type"],
        "content": _sanitize_value(message.get("content"), truncate_strings=False),
        "created_at": message.get("created_at"),
        "source_event_ids": [message["id"]],
        "source_message_id": message.get("source_message_id"),
    }
    return {key: value for key, value in compacted.items() if value is not None}


def _tool_event(
    call_message: dict[str, Any] | None,
    tool_call: dict[str, Any] | None,
    result_message: dict[str, Any] | None,
) -> tuple[dict[str, Any], int]:
    """把 tool call 与其 result 合并为一条 tool_event compact 记录。

    参数:
        call_message: 发起调用的 ai message; 来自 compact_events 的遍历,
            孤立 result 场景为 None。
        tool_call: tool_calls 中的单个调用 dict; 孤立 result 场景为 None。
        result_message: 对应的 tool result message; 由 compact_events 通过
            results_by_call_id 按 tool_call_id 匹配, 无结果时为 None。

    返回:
        ``(tool_event dict, 省略字符数)`` 二元组, 由 compact_events 追加进
        payload["events"] 并累计 compression 统计。
    """
    tool_call = tool_call or {}
    result_message = result_message or {}
    name = str(tool_call.get("name") or result_message.get("name") or "unknown")
    status = str(result_message.get("status") or ("pending" if not result_message else "success"))
    result_fields, omitted_characters = _compact_tool_result(
        name,
        status,
        result_message.get("content"),
    )
    source_event_ids = [
        message["id"] for message in (call_message, result_message) if message and message.get("id")
    ]
    event: dict[str, Any] = {
        "id": result_message.get("id") or (call_message or {}).get("id"),
        "type": "tool_event",
        "name": name,
        "args": _sanitize_args(tool_call.get("args")),
        "status": status,
        "tool_call_id": tool_call.get("id") or result_message.get("tool_call_id"),
        "source_event_ids": source_event_ids,
        "created_at": result_message.get("created_at") or (call_message or {}).get("created_at"),
        **result_fields,
    }
    return ({key: value for key, value in event.items() if value is not None}, omitted_characters)


def compact_events(
    *,
    space: str,
    project: str,
    session_id: str,
    events: list[dict[str, Any]],
    source_version: int | None = None,
) -> dict[str, Any]:
    """Build a compact, redacted projection backed by raw event IDs.

    将 append-only 原始事件投影为脱敏、压缩的 compact payload, 每条记录通过
    source_event_ids 回溯原始事件, 并附带 source/compression 元数据。

    参数:
        space: memory space; 来自 write_compact_events, 最终由
            sessions/store.py refresh_compact 传入 manifest["space"]。
        project: 项目名; 同上, 来自 manifest["project"]。
        session_id: 会话 ID; 同上, 来自会话标识。
        events: 原始事件列表; 来自 sessions/store.py read_events 的输出。
        source_version: 事件源单调修订号; 来自 memory_state 中
            touch_session_source 返回的 source_version。

    返回:
        完整 compact payload dict (schema_version/source/compression/events);
        被 write_compact_events 落盘为 compact.json, 也被
        sessions/store.py refresh_compact 传给 replace_conversation_chunks。
    """
    normalized_messages = [
        message
        for index, event in enumerate(events)
        if isinstance(event, dict)
        if (message := _normalize_message_event(event, index)) is not None
    ]
    results_by_call_id = {
        str(message["tool_call_id"]): message
        for message in normalized_messages
        if message["type"] == "tool" and message.get("tool_call_id")
    }

    compacted_events: list[dict[str, Any]] = []
    associated_result_ids: set[str] = set()
    omitted_tool_characters = 0
    tool_event_count = 0

    for message in normalized_messages:
        message_type = message["type"]
        if message_type == "system":
            continue
        if message_type == "ai":
            if message.get("content") not in (None, "", [], {}):
                compacted_events.append(_base_message(message))
            for tool_call in message.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                result_message = results_by_call_id.get(str(tool_call.get("id") or ""))
                tool_event, omitted = _tool_event(message, tool_call, result_message)
                compacted_events.append(tool_event)
                omitted_tool_characters += omitted
                tool_event_count += 1
                if result_message:
                    associated_result_ids.add(result_message["id"])
            continue
        if message_type == "tool":
            if message["id"] in associated_result_ids:
                continue
            tool_event, omitted = _tool_event(None, None, message)
            compacted_events.append(tool_event)
            omitted_tool_characters += omitted
            tool_event_count += 1
            continue
        compacted_events.append(_base_message(message))

    represented_ids = {
        event_id
        for compacted in compacted_events
        for event_id in compacted.get("source_event_ids") or []
    }
    for event in events:
        event_id = str(event.get("id") or "")
        event_type = str(event.get("type") or "")
        if not event_id or event_id in represented_ids:
            continue
        if event_type in {
            "session_failed",
            "session_cancelled",
            "tool_call",
            "tool_result",
            "permission_request",
            "permission_response",
            "file_change",
            "terminal_output",
            "plan_update",
            "error",
            "provider_event",
        }:
            compacted_events.append(
                {
                    "id": event_id,
                    "type": event_type,
                    "content": _sanitize_value(event.get("content"), truncate_strings=False),
                    "data": _sanitize_value(event.get("data") or {}),
                    "created_at": event.get("created_at"),
                    "source_event_ids": [event_id],
                }
            )

    source_hash = event_content_hash(events)
    raw_json = _canonical_json(events)
    compact_json = _canonical_json(compacted_events)
    source: dict[str, Any] = {
        "relative_path": (
            f"{space}/projects/{project}/sessions/{session_id}/events.jsonl"
        ),
        "event_count": len(events),
        "from_seq": int(events[0]["seq"]) if events else 0,
        "to_seq": int(events[-1]["seq"]) if events else 0,
        "source_content_hash": source_hash,
    }
    if source_version is not None:
        source["source_version"] = int(source_version)

    return {
        "schema_version": SCHEMA_VERSION,
        "space": space,
        "project": project,
        "session_id": session_id,
        "source": source,
        "compression": {
            "compressed_at": _now_iso(),
            "raw_characters": len(raw_json),
            "compact_characters": len(compact_json),
            "omitted_tool_characters": omitted_tool_characters,
            "tool_event_count": tool_event_count,
        },
        "events": compacted_events,
    }


def write_compact_events(
    *,
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
    events: list[dict[str, Any]],
    source_version: int | None = None,
) -> tuple[Path, dict[str, Any]]:
    """生成 compact payload 并以临时文件原子替换方式写入 compact.json。

    参数:
        memory_root: memory 根目录; 来自 sessions/store.py refresh_compact
            的 self.memory_root。
        space: memory space; 来自 manifest["space"]。
        project: 项目名; 来自 manifest["project"]。
        session_id: 会话 ID; 来自 refresh_compact 的入参。
        events: 原始事件列表; 来自 sessions/store.py read_events 的输出。
        source_version: 事件源修订号; 来自 touch_session_source 返回的
            source_state["source_version"]。

    返回:
        ``(compact.json 路径, payload)`` 二元组; payload 被 refresh_compact
        继续传给 replace_conversation_chunks 并回写 manifest。
    """
    payload = compact_events(
        space=space,
        project=project,
        session_id=session_id,
        events=events,
        source_version=source_version,
    )
    output_path = compact_path(memory_root, space, project, session_id)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_suffix(".json.tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    temp_path.replace(output_path)
    return output_path, payload


def load_validated_compact(
    *,
    memory_root: Path,
    space: str,
    project: str,
    session_id: str,
) -> dict[str, Any]:
    """Load compact data only when it matches the append-only event source.

    读取 compact.json 并做多重绑定校验 (space/project/session、schema_version、
    source_content_hash、seq 范围), 防止消费 stale 或错绑的投影。

    参数:
        memory_root: memory 根目录; 调用方为 cleo/agents/dream.py invoke、
            dream_agent_tools.py 的 _validated_compact、memory/store.py 的
            search_conversation_history, 均传 settings.MEMORY_DIR 或 memory_root。
        space: memory space; 来自各调用方的会话上下文。
        project: 项目名; 同来源。
        session_id: 会话 ID; 同来源。

    返回:
        校验通过的 compact payload dict; 被 DreamAgent 用于提取 durable
        memory, 被 search_conversation_history 用于 source_hash 新鲜度比对。
        任何校验失败抛 ValueError。
    """
    raw_events = load_events(events_path(memory_root, space, project, session_id))
    manifest = json.loads(
        manifest_path(memory_root, space, project, session_id).read_text(encoding="utf-8-sig")
    )
    payload = json.loads(
        compact_path(memory_root, space, project, session_id).read_text(encoding="utf-8-sig")
    )
    source = payload.get("source") or {}
    expected_binding = (space, project, session_id)
    manifest_binding = (
        manifest.get("space"),
        manifest.get("project"),
        manifest.get("id"),
    )
    compact_binding = (
        payload.get("space"),
        payload.get("project"),
        payload.get("session_id"),
    )
    if manifest_binding != expected_binding:
        raise ValueError("session manifest binding does not match")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("compact memory schema is not supported")
    if compact_binding != expected_binding:
        raise ValueError("compact memory space/project/session binding does not match")
    if source.get("source_content_hash") != event_content_hash(raw_events):
        raise ValueError("compact memory is stale relative to the session event log")
    expected_seq = int(raw_events[-1]["seq"]) if raw_events else 0
    if int(source.get("to_seq", -1)) != expected_seq:
        raise ValueError("compact memory event range is stale")
    return payload
