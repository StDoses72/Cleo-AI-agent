"""Normalize saved harness history into transcript entries for the Textual UI."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class TranscriptEntry:
    """One restored transcript card."""

    kind: str
    text: str


def native_transcript_entries(
    turns: tuple[dict[str, Any], ...],
) -> tuple[TranscriptEntry, ...]:
    """Extract readable transcript cards from provider-native turn dictionaries."""
    entries: list[TranscriptEntry] = []
    for turn in turns:
        items = turn.get("items")
        if not isinstance(items, list):
            continue
        for raw_item in items:
            if not isinstance(raw_item, dict):
                continue
            item = raw_item.get("root", raw_item)
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "")
            entry = _native_item_entry(item_type, item)
            if entry is not None and entry.text.strip():
                entries.append(entry)
    return tuple(entries)


def event_transcript_entries(
    events: list[dict[str, Any]],
) -> tuple[TranscriptEntry, ...]:
    """Extract transcript cards from Cleo's append-only managed session events."""
    kind_by_type = {
        "user_message": "user",
        "assistant_message": "assistant",
        "thought": "thought",
        "terminal_output": "terminal",
        "file_change": "event",
        "plan_update": "event",
        "tool_call": "event",
        "tool_result": "event",
        "error": "error",
    }
    entries: list[TranscriptEntry] = []
    for event in events:
        event_type = str(event.get("type") or "")
        kind = kind_by_type.get(event_type)
        if kind is None:
            continue
        text = _content_text(event.get("content"))
        if text:
            entries.append(TranscriptEntry(kind, _bounded(text)))
    return tuple(entries)


def _native_item_entry(item_type: str, item: dict[str, Any]) -> TranscriptEntry | None:
    if item_type == "userMessage":
        return _entry("user", _content_text(item.get("content")))
    if item_type == "agentMessage":
        return _entry("assistant", _content_text(item.get("text")))
    if item_type == "reasoning":
        return _entry(
            "thought",
            _content_text(item.get("summary")) or _content_text(item.get("content")),
        )
    if item_type == "commandExecution":
        command = _content_text(item.get("command"))
        output = _content_text(
            item.get("aggregatedOutput", item.get("aggregated_output"))
        )
        text = f"$ {command}" if command else "Command execution"
        if output:
            text = f"{text}\n{output}"
        return _entry("terminal", text)
    if item_type == "plan":
        return _entry("event", _content_text(item.get("text")))
    if item_type == "fileChange":
        changes = item.get("changes")
        count = len(changes) if isinstance(changes, list) else 0
        return TranscriptEntry("event", f"Changed {count} file(s).")
    if item_type == "webSearch":
        return _entry("event", f"Web search: {_content_text(item.get('query'))}")
    if item_type == "mcpToolCall":
        server = _content_text(item.get("server"))
        tool = _content_text(item.get("tool"))
        name = "/".join(part for part in (server, tool) if part)
        return _entry("event", f"MCP tool: {name}" if name else "MCP tool call")
    if item_type == "dynamicToolCall":
        return _entry("event", f"Tool: {_content_text(item.get('tool'))}")
    if item_type == "contextCompaction":
        return TranscriptEntry("event", "Context compacted.")
    return None


def _entry(kind: str, text: str) -> TranscriptEntry | None:
    text = text.strip()
    return TranscriptEntry(kind, _bounded(text)) if text else None


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(filter(None, (_content_text(item) for item in value)))
    if not isinstance(value, dict):
        return ""
    for key in ("text", "content", "input"):
        text = _content_text(value.get(key))
        if text:
            return text
    path = value.get("path")
    if isinstance(path, str) and path.strip():
        return f"[Image: {path.strip()}]"
    return ""


def _bounded(text: str, limit: int = 12_000) -> str:
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return f"{text[:limit]}\n… {omitted:,} characters omitted"
