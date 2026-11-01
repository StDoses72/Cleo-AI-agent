"""Shared event projections with no terminal or desktop dependencies."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.harnesses.models import AgentEvent


def event_payload(event: AgentEvent) -> dict[str, Any]:
    """Return a nested payload, falling back to the canonical event data."""
    payload = event.data.get("payload")
    return payload if isinstance(payload, dict) else event.data


def _token_int(payload: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None


def capture_context_usage(event: AgentEvent, usage: ContextWindowUsage) -> None:
    """Purpose: Project native usage. Input: event/state. Output: latest request occupancy."""
    if event.data.get("provider_event_type") != "thread/tokenUsage/updated":
        return
    project_context_usage(event_payload(event), usage)


def project_context_usage(payload: dict[str, Any], usage: ContextWindowUsage) -> None:
    """Purpose: Share live/history context accounting. Input: payload. Output: updated state.

    Native total is lifetime consumption; only last describes the current request.
    Missing last counters clear the old occupancy instead of retaining stale numbers.
    """
    token_usage = payload.get("tokenUsage")
    if not isinstance(token_usage, dict):
        return
    last = token_usage.get("last")
    last = last if isinstance(last, dict) else {}
    incoming = _token_int(last, "inputTokens", "input_tokens")
    outgoing = _token_int(last, "outputTokens", "output_tokens")
    occupied = _token_int(last, "totalTokens", "total_tokens")
    if occupied is None and incoming is not None and outgoing is not None:
        occupied = incoming + outgoing
    usage.used_tokens = occupied
    usage.input_tokens = incoming
    usage.output_tokens = outgoing
    usage.cached_input_tokens = _token_int(last, "cachedInputTokens", "cached_input_tokens")
    usage.update(
        window_tokens=_token_int(
            token_usage,
            "modelContextWindow",
            "model_context_window",
        ),
    )
