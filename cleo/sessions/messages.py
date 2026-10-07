"""Conversion between LangChain message histories and session events, and session titles."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import BaseMessage, messages_from_dict, messages_to_dict

from cleo.sessions.rewind import active_events


def title_text(content: Any) -> str:
    """Purpose: Plain text of a message ``content`` (string or content blocks)."""
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


def automatic_title(content: Any, limit: int = 60) -> str | None:
    """Purpose: Title a session from its first user message, truncated with ``...``."""
    title = title_text(content)
    if not title:
        return None
    if len(title) <= limit:
        return title
    return title[: limit - 3].rstrip() + "..."


def title_from_events(events: list[dict[str, Any]]) -> str | None:
    """Purpose: Title from the first user event, preferring what the user saw."""
    for event in events:
        if event.get("type") == "user_message" or event.get("actor") == "user":
            # Generated instructions are internal; title from what the user sees.
            data = event.get("data")
            display = data.get("display_prompt") if isinstance(data, dict) else None
            title = automatic_title(display or event.get("content"))
            if title:
                return title
    return None


def _message_type(serialized: dict[str, Any]) -> str:
    data = serialized.get("data") if isinstance(serialized.get("data"), dict) else serialized
    return str(serialized.get("type") or data.get("type") or "unknown")


def _message_data(serialized: dict[str, Any]) -> dict[str, Any]:
    data = serialized.get("data")
    return data if isinstance(data, dict) else serialized


_EVENT_TYPES = {
    "human": "user_message",
    "ai": "assistant_message",
    "system": "system_message",
    "tool": "tool_result",
}
_ACTORS = {"human": "user", "ai": "assistant", "system": "system", "tool": "tool"}


def message_events(
    messages: list[BaseMessage], existing_source_ids: set[str],
) -> list[dict[str, Any]]:
    """Purpose: Events for the messages not yet recorded, keyed by ``source_message_id``.

    Input: A LangChain history and the source ids already in the log. Output: Event
    requests for ``SessionStore.append_events``; unknown message types become
    ``provider_event``.
    """
    new_events: list[dict[str, Any]] = []
    for index, serialized in enumerate(messages_to_dict(messages)):
        data = _message_data(serialized)
        message_type = _message_type(serialized)
        source_message_id = str(data.get("id") or f"{message_type}-{index}")
        data["id"] = source_message_id
        if source_message_id in existing_source_ids:
            continue
        new_events.append(
            {
                "type": _EVENT_TYPES.get(message_type, "provider_event"),
                "actor": _ACTORS.get(message_type, "provider"),
                "content": data.get("content"),
                "message": serialized,
                "source_message_id": source_message_id,
                "created_at": data.get("created_at"),
            }
        )
    return new_events


def history_from_events(events: list[dict[str, Any]]) -> list[BaseMessage]:
    """Purpose: Rebuild the LangChain history, skipping rewound turns."""
    serialized = [
        event["message"]
        for event in active_events(events)
        if isinstance(event.get("message"), dict)
    ]
    return messages_from_dict(serialized)
