from __future__ import annotations

from types import SimpleNamespace

from cleo.desktop.presenters import project_list, thread_status, thread_view, workspace_view


def test_project_list_sorts_and_keeps_one_project_per_space() -> None:
    candidates = {
        "chat:general": ("chat", "general", "/home"),
        "productivity:Zeta": ("productivity", "Zeta", "/z"),
        "productivity:alpha": ("productivity", "alpha", "/a"),
    }
    projects = project_list(
        candidates, lambda path: SimpleNamespace(branch="main", dirty_count=len(path)),
    )
    assert [project["id"] for project in projects] == [
        "chat:general", "productivity:alpha", "productivity:Zeta"]
    assert [project["removable"] for project in projects] == [False, True, True]
    assert projects[0]["branch"] is None and projects[1]["dirtyFiles"] == 2
    alone = project_list({"productivity:a": ("productivity", "a", "/a")}, lambda _path: None)
    assert alone[0]["removable"] is False and alone[0]["branch"] is None


def _thread(manifest, **overrides):
    parts = {
        "page": {"items": [], "total": 0}, "events": [], "include_history": True,
        "running": False, "active_run_id": None, "steer_ready": False, "pending_approvals": [],
        "runtime": {"contextWindow": 1000}, "timing": None, "timing_error": None,
        "can_undo": False, "editable_turn_ids": [], "pending_questions": [], "changes": [],
        "skills": [],
    }
    return thread_view(manifest, **{**parts, **overrides})


def test_thread_view_titles_status_and_summary() -> None:
    chat = {"id": "c", "space": "non_productivity", "project": "general", "status": "failed"}
    task = {"id": "t", "space": "productivity", "project": "p", "status": "running",
            "title": "Cleo self-iteration requirements: x"}
    assert _thread(chat)["title"] == "新对话" and _thread(chat)["status"] == "attention"
    assert _thread(chat)["summary"] == "等待第一条消息"
    view = _thread(task, page={"items": [{"type": "message", "content": "latest answer"}],
                               "total": 1, "hasBefore": False})
    assert view["title"] == "进化会话" and view["status"] == "attention"
    assert view["summary"] == "latest answer" and view["history"] == {"total": 1,
                                                                       "hasBefore": False}
    assert _thread(task, running=True)["status"] == "running"
    assert _thread(task, include_history=False, page={"items": [{"type": "x"}]})["items"] == []
    assert [thread_status(value) for value in ("completed", "archived", None, "odd")] == [
        "completed", "completed", "idle", "idle"]


def test_workspace_view_defaults_to_productivity_without_an_active_thread() -> None:
    view = workspace_view(projects=[], threads=[], memory={"memories": []}, runtime={},
                          active=None, backend={})
    assert view["activeThreadId"] is None and view["activeSpace"] == "productivity"
    assert view["memories"] == []
    chat = workspace_view(projects=[], threads=[], memory={}, runtime={},
                          active={"id": "c", "space": "non_productivity"}, backend={})
    assert chat["activeThreadId"] == "c" and chat["activeSpace"] == "chat"
