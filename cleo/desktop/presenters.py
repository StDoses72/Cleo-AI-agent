"""How threads, projects and the workspace are shown to the desktop app.

Pure functions only: ``DesktopService`` gathers the data (manifests, timeline pages, run
state, runtime profile, timings, Git status) and these map it to the JSON the renderer reads.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from cleo.desktop.projection import change_history_from_events, project_id, relative_time
from cleo.runtime.usage import ContextWindowUsage

Candidates = dict[str, tuple[str, str, str]]


def ui_space(space: str) -> str:
    return "chat" if space == "non_productivity" else "productivity"


def thread_status(status: Any) -> str:
    value = str(status or "idle")
    if value == "running":
        return "running"
    if value in {"failed", "cancelled", "interrupted"}:
        return "attention"
    if value in {"completed", "closed", "archived"}:
        return "completed"
    return "idle"


def visible_title(title: Any) -> str | None:
    """Purpose: Keep titles saved from internal evolution prompts out of the UI.

    Input: Persisted manifest title. Output: Display title; the stored value is unchanged.
    """
    if isinstance(title, str) and title.startswith(
        ("Cleo self-iteration requirements", "[[CLEO_ACCEPTANCE_REQUEST:"),
    ):
        return "进化会话"
    return title or None


def accent(value: str) -> str:
    palette = ("#6be4ed", "#a78bfa", "#f2b36c", "#72d69c", "#ef7ea8")
    return palette[sum(value.encode("utf-8")) % len(palette)]


def usage_from_events(events: list[dict[str, Any]], limit: int) -> dict[str, int | None]:
    """Purpose: Context usage reported by the harness in the latest token-usage events."""
    usage = {"used": None, "limit": limit, "input": None, "output": None}
    for event in events:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
        token_usage = payload.get("tokenUsage") if isinstance(payload, dict) else None
        if not isinstance(token_usage, dict):
            continue
        total = token_usage.get("total") if isinstance(token_usage.get("total"), dict) else {}
        last = token_usage.get("last") if isinstance(token_usage.get("last"), dict) else {}
        for key, value in {
            "used": total.get("totalTokens"),
            "limit": token_usage.get("modelContextWindow"),
            "input": last.get("inputTokens"),
            "output": last.get("outputTokens"),
        }.items():
            if isinstance(value, int):
                usage[key] = value
    return usage


def usage_view(usage: ContextWindowUsage) -> dict[str, int | None]:
    return {
        "used": usage.used_tokens,
        "limit": usage.window_tokens or 128_000,
        "input": usage.input_tokens,
        "output": usage.output_tokens,
    }


def terminal_lines(events: list[dict[str, Any]]) -> list[str]:
    output = []
    for event in events[-100:]:
        if event.get("type") != "terminal_output":
            continue
        content = event.get("content")
        if isinstance(content, str) and content:
            output.append(content)
    return output


def thread_view(
    manifest: dict[str, Any],
    *,
    page: dict[str, Any],
    events: list[dict[str, Any]],
    include_history: bool,
    running: bool,
    active_run_id: str | None,
    steer_ready: bool,
    pending_approvals: list[dict[str, Any]],
    runtime: dict[str, Any],
    timing: dict[str, Any] | None,
    timing_error: str | None,
    can_undo: bool,
    editable_turn_ids: list[str],
    pending_questions: list[dict[str, Any]],
    changes: list[dict[str, Any]],
    skills: list[dict[str, Any]],
) -> dict[str, Any]:
    """Purpose: One thread as the sidebar and conversation view show it.

    Input: The manifest, its latest timeline page and recent events, the run state and
    the other gathered parts. Output: The renderer's ``Thread`` object.
    """
    items = page["items"]
    summary = next(
        (
            item["content"][:100]
            for item in reversed(items)
            if item["type"] == "message" and item["content"]
        ),
        manifest.get("title") or "等待第一条消息",
    )
    chat = manifest["space"] == "non_productivity"
    return {
        "id": manifest["id"],
        "currentTiming": timing,
        "timingError": timing_error,
        "space": ui_space(manifest["space"]),
        "projectId": project_id(manifest["space"], manifest["project"]),
        "title": visible_title(manifest.get("title")) or ("新对话" if chat else "新任务"),
        "summary": summary,
        "canUndo": can_undo,
        "updatedAt": relative_time(manifest.get("updated_at")),
        "status": "running" if running else (
            "attention" if manifest.get("status") == "running"
            else thread_status(manifest.get("status"))
        ),
        "activeRunId": active_run_id,
        "steerReady": steer_ready,
        "pendingApprovals": pending_approvals,
        "editableTurnIds": editable_turn_ids,
        "items": items if include_history else [],
        "history": {key: value for key, value in page.items() if key != "items"},
        "pendingQuestions": pending_questions,
        "changes": changes,
        "changeHistory": change_history_from_events(events),
        "usage": usage_from_events(events, runtime["contextWindow"]),
        "runtime": runtime,
        "terminal": terminal_lines(events),
        "skills": skills,
    }


def project_list(
    candidates: Candidates, git_status: Callable[[str], Any],
) -> list[dict[str, Any]]:
    """Purpose: The project rail, sorted by space then name.

    Input: ``{project id: (ui space, name, path)}`` and a Git status reader. Output: Project
    objects; a space's last project and the chat ``general`` project are not removable.
    """
    counts = {
        space: sum(1 for candidate_space, _name, _path in candidates.values()
                   if candidate_space == space)
        for space in ("chat", "productivity")
    }
    projects = []
    for identifier, (space, name, path) in candidates.items():
        git = git_status(path) if space == "productivity" else None
        projects.append(
            {
                "id": identifier,
                "space": space,
                "name": name,
                "path": path,
                "branch": git.branch if git else None,
                "dirtyFiles": git.dirty_count if git else 0,
                "accent": accent(identifier),
                "removable": counts[space] > 1
                and not (space == "chat" and name == "general"),
            }
        )
    return sorted(projects, key=lambda item: (item["space"], item["name"].casefold()))


def backend_view(
    *,
    commands: dict[str, list[str]],
    recoverable_chat_backups: int,
    hot_reload: bool,
    config_status: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "connected": True,
        "mode": "local",
        "commands": commands,
        "recoverableChatBackups": recoverable_chat_backups,
        "hotReload": hot_reload,
        "config": config_status,
    }


def workspace_view(
    *,
    projects: list[dict[str, Any]],
    threads: list[dict[str, Any]],
    memory: dict[str, Any],
    runtime: dict[str, Any],
    active: dict[str, Any] | None,
    backend: dict[str, Any],
) -> dict[str, Any]:
    """Purpose: The workspace snapshot ``load_workspace`` returns."""
    return {
        "projects": projects,
        "threads": threads,
        **memory,
        "runtime": runtime,
        "activeThreadId": active["id"] if active else None,
        "activeSpace": ui_space(active["space"]) if active else "productivity",
        "backend": backend,
    }
