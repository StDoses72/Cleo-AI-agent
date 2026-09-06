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
        if isinstance(value, int):
            return value
    return None


def capture_context_usage(event: AgentEvent, usage: ContextWindowUsage) -> None:
    """Project a token-usage event into shared runtime usage state."""
    if event.data.get("provider_event_type") != "thread/tokenUsage/updated":
        return
    payload = event_payload(event)
    token_usage = payload.get("tokenUsage")
    if not isinstance(token_usage, dict):
        return
    total = token_usage.get("total")
    last = token_usage.get("last")
    total = total if isinstance(total, dict) else {}
    last = last if isinstance(last, dict) else {}
    usage.update(
        used_tokens=_token_int(total, "totalTokens", "total_tokens"),
        window_tokens=_token_int(
            token_usage,
            "modelContextWindow",
            "model_context_window",
        ),
        input_tokens=_token_int(last, "inputTokens", "input_tokens"),
        output_tokens=_token_int(last, "outputTokens", "output_tokens"),
        cached_input_tokens=_token_int(
            last,
            "cachedInputTokens",
            "cached_input_tokens",
        ),
    )
