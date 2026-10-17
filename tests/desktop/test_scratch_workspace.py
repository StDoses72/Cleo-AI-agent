"""Development tasks start without a chosen folder in a Cleo-managed scratch workspace."""

import asyncio
import os
from pathlib import Path

import pytest

from cleo.desktop.service import SCRATCH_PROJECT
from tests.desktop.test_task_questions import _service


def test_development_task_without_folder_uses_registered_scratch_workspace(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, provider, root = _service(tmp_path)
        thread = await service.create_thread(
            space="productivity", project_id_value=f"productivity:{SCRATCH_PROJECT}",
        )
        scratch = root / "workspaces" / SCRATCH_PROJECT
        assert scratch.is_dir(), "the scratch workspace must exist before the harness starts"
        assert thread["projectId"] == f"productivity:{SCRATCH_PROJECT}"
        manifest = service.store.load_manifest(thread["id"])
        assert os.path.normcase(manifest["cwd"]) == os.path.normcase(str(scratch))
        assert manifest["project"] == SCRATCH_PROJECT
        # The sidebar finds the project later through the runtime registry, like a chosen folder.
        assert os.path.normcase(service.runtime.project_path("productivity", SCRATCH_PROJECT)) == os.path.normcase(str(scratch))
        assert "provider-new" in provider.brokers
        # A second task reuses the same directory instead of creating another one.
        second = await service.create_thread(space="productivity", project_id_value=f"productivity:{SCRATCH_PROJECT}")
        assert os.path.normcase(service.store.load_manifest(second["id"])["cwd"]) == os.path.normcase(str(scratch))

    asyncio.run(scenario())


def test_unknown_project_without_folder_is_still_refused(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, _provider, root = _service(tmp_path)
        with pytest.raises(ValueError, match="没有有效的工作目录"):
            await service.create_thread(space="productivity", project_id_value="productivity:unknown")
        assert not (root / "workspaces").exists()

    asyncio.run(scenario())
