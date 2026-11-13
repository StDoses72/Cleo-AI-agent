"""Shared event projections with no terminal or desktop dependencies."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cleo.runtime.usage import ContextWindowUsage

if TYPE_CHECKING:
    from cleo.harnesses.models import AgentEvent

# Cleo's own event for a harness that reports usage per request but has no context notification.
CONTEXT_USAGE_EVENT = "cleo/context_usage"
# Native notifications that say how full the context window is: Codex app-server, ACP, Cleo's own.
CONTEXT_USAGE_EVENTS = frozenset({"thread/tokenUsage/updated", "usage_update", CONTEXT_USAGE_EVENT})


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


def request_input_tokens(usage: Any) -> int | None:
    """Purpose: The input side of one Anthropic-style request.

    Input: A request's usage counters. Output: fresh input plus cache reads and writes, or
    None when the request reported no input counter.
    """
    if not isinstance(usage, dict) or _token_int(usage, "input_tokens") is None:
        return None
    return sum(_token_int(usage, key) or 0 for key in (
        "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))


def context_usage_data(used: int, window: int | None) -> dict[str, Any]:
    """Purpose: Event data for a harness without a native context notification.

    Input: The latest request's input side and the model's window. Output: ``AgentEvent`` data.
    """
    return {
        "provider_event_type": CONTEXT_USAGE_EVENT,
        "payload": {"contextUsage": {"used": used, "window": window}},
    }


def capture_context_usage(event: AgentEvent, usage: ContextWindowUsage) -> None:
    """Purpose: Project native usage. Input: event/state. Output: latest request occupancy."""
    if event.data.get("provider_event_type") not in CONTEXT_USAGE_EVENTS:
        return
    project_context_usage(event_payload(event), usage)


def project_context_usage(payload: dict[str, Any], usage: ContextWindowUsage) -> None:
    """Purpose: Share live/history context accounting. Input: payload. Output: updated state.

    Every harness means the same thing: the input side of its latest request (fresh input
    plus cache reads and writes) against the window it reports. A reply's output is not
    counted; it shows up as input on the next request.
    Codex: ``tokenUsage.last.inputTokens`` (``total`` is lifetime consumption, not occupancy).
    ACP: ``usage_update.used`` / ``size``. Claude: Cleo's ``contextUsage`` event.
    Missing counters clear the old occupancy instead of retaining stale numbers.
    """
    token_usage = payload.get("tokenUsage")
    if isinstance(token_usage, dict):
        last = token_usage.get("last")
        last = last if isinstance(last, dict) else {}
        used = _token_int(last, "inputTokens", "input_tokens")
        usage.output_tokens = _token_int(last, "outputTokens", "output_tokens")
        usage.cached_input_tokens = _token_int(last, "cachedInputTokens", "cached_input_tokens")
        window = _token_int(token_usage, "modelContextWindow", "model_context_window")
    else:
        context = payload.get("contextUsage")
        if not isinstance(context, dict):
            if payload.get("sessionUpdate") != "usage_update":
                return
            context = {"used": payload.get("used"), "window": payload.get("size")}
        used = _token_int(context, "used")
        usage.output_tokens = None
        usage.cached_input_tokens = None
        window = _token_int(context, "window")
    usage.used_tokens = used
    usage.input_tokens = used
    usage.update(window_tokens=window)
