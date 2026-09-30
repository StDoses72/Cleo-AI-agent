"""Conversation rewinds recorded in append-only session logs."""

from __future__ import annotations

from typing import Any

REWIND_EVENT = "rewind"


def active_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Purpose: Hide rewound turns while the raw log stays authoritative and append-only.

    Input: Ordered session events. Output: Events without each rewound turn, everything
    recorded after it before the rewind marker, or the marker itself.
    """
    visible: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") != REWIND_EVENT:
            visible.append(event)
            continue
        target = (event.get("data") or {}).get("turn_id")
        for index, kept in enumerate(visible):
            if kept.get("type") == "user_message" and kept.get("id") == target:
                del visible[index:]
                break
    return visible
