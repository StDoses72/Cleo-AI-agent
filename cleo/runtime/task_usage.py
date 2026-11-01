"""Actual task consumption across persisted main/child calls, independent of context size."""

import json
import math
from contextvars import ContextVar
from pathlib import Path

usage_observer = ContextVar("task_usage_observer", default=None)


def counter(value):
    """Purpose: Accept only reported nonnegative integer counters. Output: count or None."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def cost_number(value):
    """Purpose: Validate reported money. Input: telemetry. Output: amount or unknown."""
    return value if (isinstance(value, (int, float)) and not isinstance(value, bool)
                     and math.isfinite(value) and value >= 0) else None


def normalize_call_usage(usage):
    """Purpose: Include Claude cache in input totals. Output: normalized reported counters."""
    result = dict(usage)
    if counter(result.get("input_tokens")) is not None:
        result["input_tokens"] += sum(counter(result.get(field)) or 0 for field in (
            "cache_creation_input_tokens", "cache_read_input_tokens"))
    return result


def event_usage(events, *, include=None):
    """Purpose: Aggregate native or API telemetry once, including rewound/failed work.

    Input: Full append-only events and an optional contribution filter. Output: counters.
    Codex totals are cumulative within a native thread; Claude/API totals are per call.
    Native telemetry takes precedence over its LangChain bridge representation.
    Filtered-out cumulative events still establish the baseline for later task deltas.
    """
    native, messages = [], []
    seen = set()
    turns = turn = unknown_calls = 0
    reported_turns = set()
    for event in events:
        selected = include is None or include(event)
        if event.get("type") == "user_message":
            turns += int(selected)
            turn += 1
        data = event.get("data") or {}
        payload = data.get("payload", data)
        if not isinstance(payload, dict):
            continue
        token = payload.get("tokenUsage")
        if isinstance(token, dict) and isinstance(token.get("total"), dict):
            native.append(("cumulative", payload.get("threadId", "default"), token["total"],
                           selected))
            if selected:
                reported_turns.add(turn)
        elif (event.get("type") == "usage" or data.get("provider_event_type") == "usage") and (
            isinstance(payload.get("usage"), dict)
            or cost_number(payload.get("total_cost_usd")) is not None
        ):
            key = payload.get("call_id") or event.get("id")
            if key not in seen:
                seen.add(key)
                # Claude's ordinary input counter excludes cache creation/read tokens.
                usage = normalize_call_usage(payload.get("usage") or {})
                usage["reported_cost_usd"] = cost_number(payload.get("total_cost_usd"))
                native.append(("call", key, usage, selected))
        serialized = event.get("message") or {}
        if serialized.get("type") != "ai":
            continue
        message = serialized.get("data") or {}
        key = message.get("id") or event.get("source_message_id") or event.get("id")
        if key in seen:
            continue
        seen.add(key)
        usage = message.get("usage_metadata") or (
            message.get("response_metadata") or {}).get("token_usage")
        metadata = message.get("response_metadata") or {}
        if (metadata.get("cleo_native_usage")
                or isinstance(usage, dict) and "context_window" in usage):
            continue
        if isinstance(usage, dict):
            messages.append(("call", key, usage, selected))
        elif selected:
            unknown_calls += 1
    rows = native + messages
    total = input_tokens = output_tokens = calls = 0
    cached = written = 0
    cost = 0.0
    cost_reports = 0
    cost_complete = True
    partial = has_reported = False
    previous = {}
    for basis, key, usage, selected in rows:
        if selected:
            reported_cost = cost_number(usage.get("reported_cost_usd"))
            if reported_cost is None:
                cost_complete = False
            else:
                cost += reported_cost
                cost_reports += 1
        incoming = counter(usage.get("inputTokens", usage.get(
            "input_tokens", usage.get("prompt_tokens"))))
        outgoing = counter(usage.get("outputTokens", usage.get(
            "output_tokens", usage.get("completion_tokens"))))
        reported = counter(usage.get("totalTokens", usage.get("total_tokens")))
        if reported is None and incoming is not None and outgoing is not None:
            reported = incoming + outgoing
        if reported is None:
            partial |= selected
            continue
        read = counter(usage.get("cachedInputTokens", usage.get("cache_read_input_tokens")))
        if read is None:
            read = counter((usage.get("input_token_details") or {}).get("cache_read"))
        write = counter(usage.get("cache_creation_input_tokens"))
        values = (reported, incoming or 0, outgoing or 0, read or 0, write or 0)
        if basis == "cumulative":
            old = previous.get(key, (0, 0, 0, 0, 0))
            # A reset starts a new segment; repeated notifications contribute zero.
            delta = tuple(value - prior if value >= prior else value
                          for value, prior in zip(values, old, strict=True))
            previous[key] = values
        else:
            delta = values
        if not selected:
            continue
        has_reported = True
        if basis == "call":
            calls += 1
        total += delta[0]
        input_tokens += delta[1]
        output_tokens += delta[2]
        cached += delta[3]
        written += delta[4]
        partial |= incoming is None or outgoing is None
    if reported_turns:
        # Native notifications are not independent inference calls.
        calls += len(reported_turns)
    missing = max(unknown_calls, turns - calls, 0) + int(partial)
    return {"total": total if has_reported else None,
            "input": input_tokens if has_reported and not partial else None,
            "output": output_tokens if has_reported and not partial else None,
            "reportedCalls": calls, "missingCalls": missing,
            "cacheRead": cached if has_reported else None,
            "cacheWrite": written if has_reported else None,
            "reportedCostUsd": cost if cost_reports and cost_complete else None,
            "complete": missing == 0}


def task_usage(store, session_id):
    """Purpose: Sum a task, descendants and independent evaluator calls without inference.

    Input: SessionStore and task root. Output: reported token totals with unknown coverage.
    Explicit boundaries select the active goal, including corrections/cancellations.
    Legacy sessions retain their historical aggregate until their first recorded boundary.
    """
    root = store.load_manifest(session_id)
    events = store.read_events(session_id)
    if any(event.get("type") == "task_boundary" for event in events):
        from cleo.runtime.task_ledger import scoped_usage

        return scoped_usage(store, root, events)
    manifests = {session_id: root}
    for row in store.list_sessions():
        try:
            manifest = store.load_manifest(row["id"])
            manifests[manifest["id"]] = manifest
        except (ValueError, OSError):
            continue
    included = {session_id}
    for _ in range(len(manifests)):
        children = {key for key, item in manifests.items()
                    if item.get("parent_session_id") in included}
        if children <= included:
            break
        included |= children
    parts = []
    for key in sorted(included):
        item = manifests[key]
        usage = event_usage(events if key == session_id else store.read_events(key))
        options = item.get("runtime_options") or {}
        parts.append({**usage, "role": "main" if key == session_id else "worker",
                      "model": options.get("model") or (options.get("chat_profile") or {}).get(
                          "model"),
                      "provider": item.get("provider")})
    for path in (Path(store.memory_root) / ".routing" / "tasks").glob("task_*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            evaluation = record.get("evaluator") or {}
            if (record.get("parent_session_id") not in included
                    or evaluation.get("status") not in {"completed", "failed", "cancelled"}
                    or not evaluation.get("called", bool(evaluation.get("model")))):
                continue
            usage = evaluation.get("usage") or {}
            total = counter(usage.get("total_tokens"))
            parts.append({"role": "evaluator", "model": evaluation.get("model"),
                          "provider": evaluation.get("backend"), "total": total,
                          "input": counter(usage.get("input_tokens")),
                          "output": counter(usage.get("output_tokens")),
                          "reportedCalls": int(total is not None),
                          "missingCalls": int(total is None), "complete": total is not None})
        except (OSError, ValueError, TypeError):
            continue
    contributors = [item for item in parts
                    if item["reportedCalls"] or item["missingCalls"] or item["total"] is not None]
    return {"total": sum(item["total"] or 0 for item in parts)
            if any(item["total"] is not None for item in parts) else None,
            "input": sum(item["input"] or 0 for item in parts)
            if contributors and all(item["input"] is not None for item in contributors) else None,
            "output": sum(item["output"] or 0 for item in parts)
            if contributors and all(item["output"] is not None for item in contributors) else None,
            "reportedCalls": sum(item["reportedCalls"] for item in parts),
            "missingCalls": sum(item["missingCalls"] for item in parts),
            "complete": all(item["complete"] for item in parts), "breakdown": parts}
