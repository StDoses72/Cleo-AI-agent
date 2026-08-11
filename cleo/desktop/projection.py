"""Project persisted Cleo state into the desktop renderer contract."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cleo.cli.productivity_renderer import event_payload
from cleo.harnesses.models import AgentEvent

_DIFF_HEADER = re.compile(r"^diff --git a/(.+?) b/(.+)$")


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
    for event in events[-500:]:
        event_type = str(event.get("type") or "")
        event_id = str(event.get("id") or f"event-{len(items)}")
        content = _content_text(event.get("content"))
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
        if event_type in {"user_message", "human"} and content:
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
                items.append({"id": event_id, "type": "plan", "title": "执行计划", "steps": steps})
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
        elif event_type in {"session_failed", "error"}:
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


def stream_event_item(event: AgentEvent, state: dict[str, Any]) -> list[dict[str, Any]]:
    """Translate one live productivity event into zero or more UI events."""
    output: list[dict[str, Any]] = []
    payload = event_payload(event)
    item = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    event_key = str(item.get("id") or item.get("toolCallId") or len(state))
    if event.type == "assistant_message_chunk" and event.text:
        state["assistant"] = str(state.get("assistant") or "") + event.text
        output.append(
            {
                "type": "upsert-item",
                "item": _message("live-assistant", "assistant", state["assistant"], None),
            }
        )
    elif event.type == "thought" and event.text:
        output.append(
            {
                "type": "upsert-item",
                "item": {
                    "id": f"thought-{event_key}",
                    "type": "thought",
                    "content": event.text,
                    "status": "done",
                },
            }
        )
    elif event.type == "plan_update":
        plan = payload.get("plan")
        steps = [_plan_step(step) for step in plan] if isinstance(plan, list) else []
        steps = [step for step in steps if step is not None]
        if steps:
            output.append(
                {
                    "type": "upsert-item",
                    "item": {
                        "id": "live-plan",
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
        if changes:
            output.append({"type": "changes", "changes": changes})
    elif event.type == "error":
        output.append({"type": "error", "message": event.text or "Provider reported an error."})
    return output


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
