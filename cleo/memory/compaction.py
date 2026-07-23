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
    return datetime.now(UTC).isoformat()


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def event_content_hash(events: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256(_canonical_json(events).encode()).hexdigest()
    return f"sha256:{digest}"


def load_events(path: Path) -> list[dict[str, Any]]:
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


def _compact_tool_result(name: str, status: str, content: Any) -> tuple[dict[str, Any], int]:
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
    """Build a compact, redacted projection backed by raw event IDs."""
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
    """Load compact data only when it matches the append-only event source."""
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
