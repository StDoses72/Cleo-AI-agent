"""A development task can start with the permission preset chosen in its draft."""

import asyncio
from pathlib import Path

import pytest

from cleo.harnesses.control import SessionOptions
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


@pytest.mark.parametrize(("provider_type", "permissions"), [
    ("codex_sdk", {"access": "workspace-write", "approval": "user"}),
    ("codex_sdk", {"access": "workspace-write", "approval": "auto_review"}),
    ("codex_sdk", {"access": "full-access", "approval": "deny_all"}),
    ("codex_sdk", {"access": "read-only", "approval": "user"}),
    *(("claude_sdk", {"approval": mode}) for mode in (
        "default", "auto", "bypassPermissions", "acceptEdits", "dontAsk", "plan",
    )),
    *(("acp", {"approval": mode}) for mode in ("user", "auto_allow", "deny_all")),
])
def test_creation_applies_native_permissions_over_harness_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider_type: str, permissions: dict,
) -> None:
    async def scenario() -> None:
        service, provider, _root = _service(tmp_path)
        monkeypatch.setattr(service.settings.productivity.provider("codex"), "type", provider_type)
        provider.provider_type = provider_type
        provider.options = SessionOptions(
            model="gpt-test", approval_mode="deny_all",
            sandbox="full-access" if provider_type == "codex_sdk" else None,
        )
        thread = await service.create_thread(
            space="productivity", project_id_value="productivity:general", **permissions,
        )
        actual = provider.session_options("provider-new")
        assert actual.approval_mode == permissions["approval"]
        assert actual.sandbox == permissions.get("access")
        assert thread["runtime"]["approval"] == permissions["approval"]
        if "access" in permissions:
            assert thread["runtime"]["access"] == permissions["access"]
        assert service.store.load_manifest(thread["id"])["runtime_options"] == actual.as_dict()

    asyncio.run(scenario())


@pytest.mark.parametrize("provider_type", ["claude_sdk", "acp"])
def test_non_codex_draft_rejects_sandbox_before_creating_a_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider_type: str,
) -> None:
    async def scenario() -> None:
        service, provider, _root = _service(tmp_path)
        monkeypatch.setattr(service.settings.productivity.provider("codex"), "type", provider_type)
        with pytest.raises(ValueError, match="access=default"):
            await service.create_thread(
                space="productivity", project_id_value="productivity:general", access="default",
            )
        assert provider.brokers == {}

    asyncio.run(scenario())
