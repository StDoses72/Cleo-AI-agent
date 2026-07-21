"""Deterministic, evidence-preserving projection of raw thread messages."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

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
    return datetime.now(UTC).isoformat()


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def source_content_hash(messages: list[dict[str, Any]]) -> str:
    """Return a stable hash for an exact logical raw-message snapshot."""
    digest = hashlib.sha256(_canonical_json(messages).encode()).hexdigest()
    return f"sha256:{digest}"


def compact_thread_path(compact_dir: Path, thread_id: str) -> Path:
    return compact_dir / f"{thread_id}.json"


def _content_characters(content: Any) -> int:
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    return len(_canonical_json(content))


def _redact_text(value: str) -> str:
    redacted = _SENSITIVE_TEXT.sub(lambda match: f"{match[1]}{match[2]}<redacted>", value)
    return _BEARER_TOKEN.sub("Bearer <redacted>", redacted)


def _sanitize_value(
    value: Any,
    key: str = "",
    *,
    truncate_strings: bool = True,
) -> Any:
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
            str(k): _sanitize_value(v, str(k), truncate_strings=truncate_strings)
            for k, v in value.items()
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
    if not isinstance(args, dict):
        return {}
    return {str(key): _sanitize_value(value, str(key)) for key, value in args.items()}


def _parse_json_result(content: Any) -> Any:
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
    if content is None:
        return None, False
    if not isinstance(content, str):
        content = _canonical_json(content)
    content = _redact_text(content)
    if len(content) <= limit:
        return content, False
    return content[:limit] + f"... <truncated:{len(content) - limit} chars>", True


def _compact_tool_result(
    *,
    name: str,
    status: str,
    content: Any,
) -> tuple[dict[str, Any], int]:
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

    is_error = str(status).casefold() not in {"", "success"}
    limit = 2000 if is_error else 1000
    result, truncated = _bounded_text(content, limit)
    compacted: dict[str, Any] = {"result": result}
    if truncated:
        compacted["result_truncated"] = True
        compacted["original_result_characters"] = result_characters
        return compacted, max(0, result_characters - limit)
    return compacted, 0


def _normalize_message(message: dict[str, Any], index: int) -> dict[str, Any]:
    data = message.get("data") if isinstance(message.get("data"), dict) else message
    message_type = str(message.get("type") or data.get("type") or "unknown")
    message_id = data.get("id") or message.get("id") or f"{message_type}-{index}"
    return {
        "id": str(message_id),
        "type": message_type,
        "content": data.get("content"),
        "created_at": data.get("created_at") or message.get("created_at"),
        "name": data.get("name"),
        "status": data.get("status"),
        "tool_call_id": data.get("tool_call_id"),
        "tool_calls": data.get("tool_calls") or [],
    }


def _base_message(message: dict[str, Any]) -> dict[str, Any]:
    compacted = {
        "id": message["id"],
        "type": message["type"],
        "content": _sanitize_value(message.get("content"), truncate_strings=False),
        "created_at": message.get("created_at"),
    }
    return {key: value for key, value in compacted.items() if value is not None}


def _tool_event(
    call_message: dict[str, Any] | None,
    tool_call: dict[str, Any] | None,
    result_message: dict[str, Any] | None,
) -> tuple[dict[str, Any], int]:
    tool_call = tool_call or {}
    result_message = result_message or {}
    name = str(tool_call.get("name") or result_message.get("name") or "unknown")
    args = _sanitize_args(tool_call.get("args"))
    status = str(result_message.get("status") or ("pending" if not result_message else "success"))
    result_fields, omitted_characters = _compact_tool_result(
        name=name,
        status=status,
        content=result_message.get("content"),
    )

    source_message_ids = [
        message["id"] for message in (call_message, result_message) if message and message.get("id")
    ]
    event: dict[str, Any] = {
        "id": result_message.get("id") or tool_call.get("id"),
        "type": "tool_event",
        "name": name,
        "args": args,
        "status": status,
        "tool_call_id": tool_call.get("id") or result_message.get("tool_call_id"),
        "source_message_ids": source_message_ids,
        "created_at": result_message.get("created_at")
        or (call_message or {}).get("created_at"),
        **result_fields,
    }
    return ({key: value for key, value in event.items() if value is not None}, omitted_characters)


def compact_messages(
    *,
    project: str,
    thread_id: str,
    messages: list[dict[str, Any]],
    source_version: int | None = None,
) -> dict[str, Any]:
    """Build a compact mirror for DreamAgent and history retrieval."""
    normalized = [
        _normalize_message(message, index)
        for index, message in enumerate(messages)
        if isinstance(message, dict)
    ]
    results_by_call_id = {
        str(message["tool_call_id"]): message
        for message in normalized
        if message["type"] == "tool" and message.get("tool_call_id")
    }

    compacted_messages: list[dict[str, Any]] = []
    associated_result_ids: set[str] = set()
    omitted_tool_characters = 0
    tool_event_count = 0

    for message in normalized:
        message_type = message["type"]
        if message_type == "system":
            continue
        if message_type == "ai":
            if message.get("content") not in (None, "", [], {}):
                compacted_messages.append(_base_message(message))
            for tool_call in message.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                result_message = results_by_call_id.get(str(tool_call.get("id") or ""))
                event, omitted = _tool_event(message, tool_call, result_message)
                compacted_messages.append(event)
                omitted_tool_characters += omitted
                tool_event_count += 1
                if result_message:
                    associated_result_ids.add(result_message["id"])
            continue
        if message_type == "tool":
            if message["id"] in associated_result_ids:
                continue
            event, omitted = _tool_event(None, None, message)
            compacted_messages.append(event)
            omitted_tool_characters += omitted
            tool_event_count += 1
            continue
        compacted_messages.append(_base_message(message))

    raw_json = _canonical_json(messages)
    compact_json = _canonical_json(compacted_messages)
    source: dict[str, Any] = {
        "relative_path": f"thread_objects/{thread_id}.json",
        "message_count": len(messages),
        "source_content_hash": source_content_hash(messages),
    }
    if source_version is not None:
        source["source_version"] = int(source_version)

    return {
        "schema_version": SCHEMA_VERSION,
        "project": project,
        "thread_id": thread_id,
        "source": source,
        "compression": {
            "compressed_at": _now_iso(),
            "raw_characters": len(raw_json),
            "compact_characters": len(compact_json),
            "omitted_tool_characters": omitted_tool_characters,
            "tool_event_count": tool_event_count,
        },
        "messages": compacted_messages,
    }


def write_compact_messages(
    *,
    compact_dir: Path,
    project: str,
    thread_id: str,
    messages: list[dict[str, Any]],
    source_version: int | None = None,
) -> tuple[Path, dict[str, Any]]:
    payload = compact_messages(
        project=project,
        thread_id=thread_id,
        messages=messages,
        source_version=source_version,
    )
    output_path = compact_thread_path(compact_dir, thread_id)
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
    project: str,
    thread_id: str,
    thread_objects_dir: Path,
    compact_dir: Path,
) -> dict[str, Any]:
    """Load compact data only when it still matches the authoritative raw snapshot."""
    raw_path = thread_objects_dir / f"{thread_id}.json"
    compact_path = compact_thread_path(compact_dir, thread_id)
    raw_data = json.loads(raw_path.read_text(encoding="utf-8-sig"))
    messages = raw_data.get("messages", []) if isinstance(raw_data, dict) else []
    payload = json.loads(compact_path.read_text(encoding="utf-8-sig"))
    source = payload.get("source") or {}
    raw_project = raw_data.get("project") if isinstance(raw_data, dict) else None
    raw_thread_id = raw_data.get("thread_id") if isinstance(raw_data, dict) else None
    if raw_project and raw_project != project:
        raise ValueError("raw snapshot project binding does not match")
    if raw_thread_id and raw_thread_id != thread_id:
        raise ValueError("raw snapshot thread binding does not match")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("compact memory schema is not supported")
    if payload.get("project") != project or payload.get("thread_id") != thread_id:
        raise ValueError("compact memory project/thread binding does not match")
    if source.get("source_content_hash") != source_content_hash(messages):
        raise ValueError("compact memory is stale relative to the raw thread snapshot")
    return payload
