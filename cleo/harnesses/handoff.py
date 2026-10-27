"""Backward-compatible markers for prepared and completed harness handoffs."""

from __future__ import annotations

from typing import Any

from cleo.i18n import tr

SWITCH_EVENT = "cleo/harness_switch"
DELIVERED_EVENT = "cleo/handoff_delivered"


def checked_history(store: Any, session_id: str) -> list[dict[str, Any]]:
    manifest = store.load_manifest(session_id)
    events = store.read_events(session_id)
    if (manifest.get("schema_version") != 1
            or len(events) != manifest.get("last_event_seq")
            or any(event.get("seq") != i or event.get("schema_version") != 1
                   for i, event in enumerate(events, 1))):
        raise ValueError(tr("handoff.conversation_history_is_incomplete_or_uses_an_un"))
    return events


def switch_record(event: dict[str, Any]) -> dict[str, Any] | None:
    data = event.get("data") or {}
    if event.get("type") == "provider_event" and data.get("provider_event_type") == SWITCH_EVENT:
        payload = data.get("payload")
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise ValueError(tr("handoff.unsupported_handoff_record_format_the_existing_c"))
        return payload
    return None


def pending_handoff(events: list[dict[str, Any]], provider: str) -> bool:
    delivered = set()
    for event in reversed(events):
        data = event.get("data") or {}
        if data.get("provider_event_type") == DELIVERED_EVENT:
            payload = data.get("payload") or {}
            if payload.get("version") != 1:
                raise ValueError(tr("handoff.unsupported_handoff_confirmation_format_the_exis"))
            delivered.add(payload["switch_id"])
        record = switch_record(event)
        if record is not None and record["provider"] == provider:
            # Old versions can write session_completed without sending a handoff.
            # Only our explicit acknowledgement proves the native thread has it.
            return event["id"] not in delivered
    return False
