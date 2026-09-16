"""Backward-compatible markers for prepared and completed harness handoffs."""

from __future__ import annotations

from typing import Any

SWITCH_EVENT = "cleo/harness_switch"
DELIVERED_EVENT = "cleo/handoff_delivered"


def checked_history(store: Any, session_id: str) -> list[dict[str, Any]]:
    manifest = store.load_manifest(session_id)
    events = store.read_events(session_id)
    if (manifest.get("schema_version") != 1
            or len(events) != manifest.get("last_event_seq")
            or any(event.get("seq") != i or event.get("schema_version") != 1
                   for i, event in enumerate(events, 1))):
        raise ValueError("会话历史不完整或格式不受支持，无法可靠交接；原 harness 保持不变。")
    return events


def switch_record(event: dict[str, Any]) -> dict[str, Any] | None:
    data = event.get("data") or {}
    if event.get("type") == "provider_event" and data.get("provider_event_type") == SWITCH_EVENT:
        payload = data.get("payload")
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise ValueError("交接记录格式不受支持，未覆盖现有会话。")
        return payload
    return None


def pending_handoff(events: list[dict[str, Any]], provider: str) -> bool:
    delivered = set()
    for event in reversed(events):
        data = event.get("data") or {}
        if data.get("provider_event_type") == DELIVERED_EVENT:
            payload = data.get("payload") or {}
            if payload.get("version") != 1:
                raise ValueError("交接确认格式不受支持，未覆盖现有会话。")
            delivered.add(payload["switch_id"])
        record = switch_record(event)
        if record is not None and record["provider"] == provider:
            # Old versions can write session_completed without sending a handoff.
            # Only our explicit acknowledgement proves the native thread has it.
            return event["id"] not in delivered
    return False

