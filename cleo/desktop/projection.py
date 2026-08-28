"""Project persisted Cleo state into the desktop renderer contract."""

from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.cli.productivity_renderer import event_payload
from cleo.harnesses.models import AgentEvent

_DIFF_HEADER = re.compile(r"^diff --git a/(.+?) b/(.+)$")
_INCOMPLETE_TOOL_OUTPUT = "任务已结束，但没有收到该工具的完成事件。"


def relative_time(value: str | None) -> str:
    if not value:
        return "—"
    try:
        updated = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    elapsed = max(0, int((datetime.now(UTC) - updated.astimezone(UTC)).total_seconds()))
    if elapsed < 60:
        return "刚刚"
    if elapsed < 3_600:
        return f"{elapsed // 60} 分钟前"
    if elapsed < 86_400:
        return f"{elapsed // 3_600} 小时前"
    return f"{elapsed // 86_400} 天前"


def timeline_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate durable session events into renderer timeline items."""
    items: list[dict[str, Any]] = []
    tools: dict[str, dict[str, Any]] = {}
    plans: dict[str, dict[str, Any]] = {}
    current_turn_key = "initial"
    for event in events[-500:]:
        event_type = str(event.get("type") or "")
        event_id = str(event.get("id") or f"event-{len(items)}")
        content = _content_text(event.get("content"))
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
        if event_type in {"user_message", "human"} and content:
            current_turn_key = event_id
            items.append(_message(event_id, "user", content, event.get("created_at")))
        elif event_type in {"assistant_message", "ai"} and content:
            items.append(_message(event_id, "assistant", content, event.get("created_at")))
        elif event_type == "thought" and content:
            items.append({"id": event_id, "type": "thought", "content": content, "status": "done"})
        elif event_type == "plan_update":
            plan = payload.get("plan") if isinstance(payload, dict) else None
            steps = [_plan_step(step) for step in plan] if isinstance(plan, list) else []
            steps = [step for step in steps if step is not None]
            if steps:
                plan_key = str(payload.get("turnId") or payload.get("turn_id") or current_turn_key)
                plan_item = plans.get(plan_key)
                if plan_item is None:
                    plan_item = {
                        "id": f"plan-{plan_key}",
                        "type": "plan",
                        "title": "执行计划",
                        "steps": steps,
                    }
                    plans[plan_key] = plan_item
                    items.append(plan_item)
                else:
                    plan_item["steps"] = steps
        elif event_type == "tool_call":
            source = payload.get("item") if isinstance(payload, dict) else None
            source = source if isinstance(source, dict) else payload
            tool_id = str(source.get("id") or event_id)
            item = {
                "id": f"tool-{tool_id}",
                "type": "tool",
                "name": str(source.get("tool") or source.get("name") or "tool"),
                "command": str(source.get("command") or source.get("input") or ""),
                "status": "running",
            }
            tools[tool_id] = item
            items.append(item)
        elif event_type == "tool_result":
            source = payload.get("item") if isinstance(payload, dict) else None
            source = source if isinstance(source, dict) else payload
            tool_id = str(source.get("id") or source.get("toolCallId") or "")
            item = tools.get(tool_id)
            if item is None:
                item = {
                    "id": f"tool-result-{event_id}",
                    "type": "tool",
                    "name": str(source.get("tool") or "tool"),
                    "command": "",
                    "status": "done",
                }
                items.append(item)
            item["status"] = "error" if source.get("status") == "failed" else "done"
            output = _content_text(source.get("output") or content)
            if output:
                item["output"] = output
        elif event_type in {
            "session_completed",
            "session_failed",
            "session_cancelled",
            "session_closed",
        }:
            _finalize_running_tools(tools.values())
            if event_type == "session_completed":
                continue
            items.append(
                {
                    "id": event_id,
                    "type": "notice",
                    "tone": "warning",
                    "title": "运行需要查看",
                    "detail": content or "任务在工具完成前结束。",
                }
            )
        elif event_type == "error":
            items.append(
                {
                    "id": event_id,
                    "type": "notice",
                    "tone": "warning",
                    "title": "运行需要查看",
                    "detail": content or "后端报告了一个错误。",
                }
            )
    return items


def changes_from_diff(diff: str | None) -> list[dict[str, Any]]:
    """Split a unified Git diff into renderer file cards."""
    if not diff:
        return []
    files: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    current_lines: list[str] = []
    for line in diff.splitlines():
        match = _DIFF_HEADER.match(line)
        if match:
            if current is not None:
                current["diff"] = "\n".join(current_lines)
                files.append(current)
            path = match.group(2)
            current = {
                "path": path,
                "status": "modified",
                "additions": 0,
                "deletions": 0,
                "diff": "",
            }
            current_lines = [line]
            continue
        if current is None:
            continue
        current_lines.append(line)
        if line.startswith("new file mode"):
            current["status"] = "added"
        elif line.startswith("deleted file mode"):
            current["status"] = "deleted"
        elif line.startswith("+") and not line.startswith("+++"):
            current["additions"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            current["deletions"] += 1
    if current is not None:
        current["diff"] = "\n".join(current_lines)
        files.append(current)
    return files


def final_changes_from_diff(
    diff: str | None,
    state: dict[str, Any],
) -> list[dict[str, Any]]:
    """Prefer the final Git diff, falling back to the latest streamed turn diff."""
    if diff is not None:
        return changes_from_diff(diff)
    streamed = state.get("changes:latest")
    if not isinstance(streamed, list):
        return []
    return [dict(change) for change in streamed if isinstance(change, dict)]


def latest_turn_changes(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rebuild the latest turn's provider diff when the session cwd is not a Git repo."""
    for event in reversed(events):
        event_type = str(event.get("type") or "")
        if event_type in {"user_message", "human"}:
            break
        if event_type != "file_change":
            continue
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        if data.get("provider_event_type") != "turn/diff/updated":
            continue
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
        diff = event.get("content") or payload.get("diff")
        return changes_from_diff(diff if isinstance(diff, str) else None)
    return []


def stream_event_item(event: AgentEvent, state: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate one live productivity event into zero or more UI events."""
    output: list[dict[str, Any]] = []
    payload = event_payload(event)
    item = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    event_key = str(
        item.get("id")
        or payload.get("itemId")
        or item.get("toolCallId")
        or payload.get("turnId")
        or len(state)
    )
    if event.type == "assistant_message_chunk" and event.text:
        active_id = state.get("assistant:active_id")
        if not isinstance(active_id, str):
            active_id = (
                "live-assistant"
                if event.provider != "codex"
                else f"live-assistant-{event_key}"
            )
            state["assistant:active_id"] = active_id
        content_key = f"assistant:content:{active_id}"
        content = str(state.get(content_key) or "") + event.text
        state[content_key] = content
        phase = str(item.get("phase") or payload.get("phase") or "")
        if event.provider != "codex" or phase in {"final_answer", "final"}:
            state["assistant"] = content
        output.append(
            {
                "type": "upsert-item",
                "item": (
                    {
                        "id": active_id,
                        "type": "thought",
                        "content": content,
                        "status": "running",
                    }
                    if phase == "commentary"
                    else _message(active_id, "assistant", content, None)
                ),
            }
        )
    elif event.type == "assistant_message_completed":
        active_id = state.pop("assistant:active_id", None)
        if not isinstance(active_id, str):
            active_id = f"live-assistant-{event_key}"
        content_key = f"assistant:content:{active_id}"
        content = event.text or str(state.get(content_key) or "")
        state.pop(content_key, None)
        phase = str(item.get("phase") or payload.get("phase") or "")
        if phase == "commentary":
            output.append(
                {
                    "type": "upsert-item",
                    "item": {
                        "id": active_id,
                        "type": "thought",
                        "content": content,
                        "status": "done",
                    },
                }
            )
        elif content:
            state["assistant"] = content
            output.append(
                {
                    "type": "upsert-item",
                    "item": _message(active_id, "assistant", content, None),
                }
            )
    elif event.type == "thought" and event.text:
        thought_key = f"thought:content:{event_key}"
        content = str(state.get(thought_key) or "") + event.text
        state[thought_key] = content
        output.append(
            {
                "type": "upsert-item",
                "item": {
                    "id": f"thought-{event_key}",
                    "type": "thought",
                    "content": content,
                    "status": "done",
                },
            }
        )
    elif event.type == "plan_update":
        plan = payload.get("plan")
        steps = [_plan_step(step) for step in plan] if isinstance(plan, list) else []
        steps = [step for step in steps if step is not None]
        if steps:
            plan_id = state.get("plan:id")
            if not isinstance(plan_id, str):
                plan_key = (
                    payload.get("turnId")
                    or payload.get("turn_id")
                    or state.get("run_id")
                    or "current"
                )
                plan_id = f"live-plan-{plan_key}"
                state["plan:id"] = plan_id
            output.append(
                {
                    "type": "upsert-item",
                    "item": {
                        "id": plan_id,
                        "type": "plan",
                        "title": "执行计划",
                        "steps": steps,
                    },
                }
            )
    elif event.type == "tool_call":
        tool = {
            "id": f"live-tool-{event_key}",
            "type": "tool",
            "name": str(item.get("tool") or item.get("name") or "tool"),
            "command": str(item.get("command") or item.get("input") or ""),
            "status": "running",
        }
        state[f"tool:{event_key}"] = tool
        output.append({"type": "upsert-item", "item": tool})
    elif event.type == "tool_result":
        tool = state.get(f"tool:{event_key}")
        if not isinstance(tool, dict):
            tool = {
                "id": f"live-tool-{event_key}",
                "type": "tool",
                "name": str(item.get("tool") or "tool"),
                "command": "",
            }
        tool = dict(tool)
        tool["status"] = "error" if item.get("status") == "failed" else "done"
        result = _content_text(item.get("output") or event.text)
        if result:
            tool["output"] = result
        state[f"tool:{event_key}"] = tool
        output.append({"type": "upsert-item", "item": tool})
    elif event.type == "terminal_output" and event.text:
        output.append({"type": "terminal", "chunk": event.text})
    elif event.type == "file_change":
        diff = event.text or payload.get("diff")
        changes = changes_from_diff(diff if isinstance(diff, str) else None)
        authoritative = event.data.get("provider_event_type") == "turn/diff/updated"
        if authoritative or changes:
            state["changes:latest"] = changes
            output.append({"type": "changes", "changes": changes})
    elif event.type == "permission_request":
        output.append({"type": "approval-request", "request": payload})
    elif event.type == "permission_response":
        output.append({"type": "approval-resolved", "response": payload})
    elif event.type == "error":
        output.append({"type": "error", "message": event.text or "Provider reported an error."})
    return output


def finalize_stream_tools(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Close tool calls that never received a terminal provider event."""
    tools = [
        value for key, value in state.items() if key.startswith("tool:") and isinstance(value, dict)
    ]
    finalized = _finalize_running_tools(tools)
    return [{"type": "upsert-item", "item": tool} for tool in finalized]


def _finalize_running_tools(tools: Iterable[Any]) -> list[dict[str, Any]]:
    finalized: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("status") != "running":
            continue
        tool["status"] = "error"
        tool.setdefault("output", _INCOMPLETE_TOOL_OUTPUT)
        finalized.append(tool)
    return finalized


def _message(event_id: str, role: str, content: str, created_at: Any) -> dict[str, Any]:
    time_text = ""
    if isinstance(created_at, str):
        try:
            time_text = (
                datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                .astimezone()
                .strftime("%H:%M")
            )
        except ValueError:
            time_text = ""
    return {"id": event_id, "type": "message", "role": role, "content": content, "time": time_text}


def _plan_step(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    label = str(value.get("step") or value.get("label") or "").strip()
    if not label:
        return None
    raw_status = str(value.get("status") or "pending")
    status = {"completed": "done", "in_progress": "running"}.get(raw_status, raw_status)
    if status not in {"pending", "running", "done"}:
        status = "pending"
    return {"label": label, "status": status}


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(filter(None, (_content_text(item) for item in value)))
    if isinstance(value, dict):
        return next(
            (
                text
                for key in ("text", "content", "value")
                if (text := _content_text(value.get(key)))
            ),
            "",
        )
    return ""


def project_id(space: str, project: str) -> str:
    return f"{'chat' if space == 'non_productivity' else 'productivity'}:{project}"


def project_name_from_id(value: str) -> str:
    return value.partition(":")[2] or value


def path_name(value: str | None, fallback: str) -> str:
    return Path(value).name if value else fallback
