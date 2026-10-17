"""Development tasks that bind no folder belong to the managed general project."""

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from cleo.desktop.presenters import project_list
from cleo.desktop.service import GENERAL_PROJECT
from tests.desktop.test_task_questions import _service


def test_development_task_without_folder_runs_in_the_general_workspace(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, provider, root = _service(tmp_path)
        thread = await service.create_thread(
            space="productivity", project_id_value=f"productivity:{GENERAL_PROJECT}",
        )
        general = root / "workspaces" / GENERAL_PROJECT
        assert general.is_dir(), "the managed directory must exist before the harness starts"
        assert thread["projectId"] == f"productivity:{GENERAL_PROJECT}"
        manifest = service.store.load_manifest(thread["id"])
        assert os.path.normcase(manifest["cwd"]) == os.path.normcase(str(general))
        assert manifest["project"] == GENERAL_PROJECT
        assert "provider-new" in provider.brokers
        second = await service.create_thread(
            space="productivity", project_id_value=f"productivity:{GENERAL_PROJECT}",
        )
        assert os.path.normcase(service.store.load_manifest(second["id"])["cwd"]) == os.path.normcase(str(general))

    asyncio.run(scenario())


def test_unknown_project_without_folder_is_still_refused(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, _provider, root = _service(tmp_path)
        with pytest.raises(ValueError, match="没有有效的工作目录"):
            await service.create_thread(space="productivity", project_id_value="productivity:unknown")
        assert not (root / "workspaces").exists()

    asyncio.run(scenario())


def test_general_development_project_is_managed_and_not_removable() -> None:
    calls: list[str] = []

    def git(path: str):
        calls.append(path)
        return SimpleNamespace(branch="main", dirty_count=0)

    projects = project_list({
        "chat:general": ("chat", "general", "/home"),
        "productivity:general": ("productivity", "general", "/home/workspaces/general"),
        "productivity:app": ("productivity", "app", "/code/app"),
    }, git)
    general = next(project for project in projects if project["id"] == "productivity:general")
    app = next(project for project in projects if project["id"] == "productivity:app")
    assert general["managed"] is True and general["removable"] is False
    assert general["branch"] is None, "a managed directory is never inspected as a repository"
    assert app["managed"] is False and app["removable"] is True and app["branch"] == "main"
    assert calls == ["/code/app"]
