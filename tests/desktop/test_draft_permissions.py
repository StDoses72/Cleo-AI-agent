"""A development task can start with the permission preset chosen in its draft."""

import asyncio
from pathlib import Path

import pytest

from tests.desktop.test_task_questions import _service


def test_catalog_lists_the_presets_a_draft_can_choose(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, _provider, _root = _service(tmp_path)
        catalog = await service.get_runtime_catalog()
        codex = next(item for item in catalog["productivityProviders"] if item["id"] == "codex")
        presets = {preset["value"]: preset for preset in codex["permissionOptions"]["presets"]}
        assert presets["full"]["update"] == {"approval": "deny_all", "access": "full-access"}
        assert presets["ask"]["disabledReason"] is None

    asyncio.run(scenario())


def test_task_starts_with_the_chosen_permissions(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, provider, _root = _service(tmp_path)
        thread = await service.create_thread(
            space="productivity", project_id_value="productivity:general",
            access="full-access", approval="deny_all",
        )
        options = provider.session_options("provider-new")
        assert (options.sandbox, options.approval_mode) == ("full-access", "deny_all")
        assert (thread["runtime"]["access"], thread["runtime"]["approval"]) == (
            "full-access", "deny_all",
        )
        manifest = service.store.load_manifest(thread["id"])
        assert manifest.get("pending_runtime_permissions") is None

    asyncio.run(scenario())


def test_invalid_draft_permissions_create_no_session(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, provider, _root = _service(tmp_path)
        with pytest.raises(ValueError, match="不支持的权限选项"):
            await service.create_thread(
                space="productivity", project_id_value="productivity:general",
                approval="bypassPermissions",
            )
        assert provider.brokers == {}, "validation must happen before the session exists"
        with pytest.raises(ValueError, match="只有开发任务"):
            await service.create_thread(
                space="chat", project_id_value="chat:general", approval="user",
            )

    asyncio.run(scenario())
