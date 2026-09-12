import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.desktop.service import DesktopService


def service_for_source(monkeypatch, tmp_path, provider_type="codex_sdk"):
    """Purpose: Build an isolated evolution policy fixture.

    Input: Environment patcher, temporary root, provider type.
    Output: Minimal desktop service, managed manifest, adapter.
    """
    source = tmp_path / "source"
    source.mkdir()
    monkeypatch.setenv("CLEO_EVOLUTION_WORKSPACE", str(source))
    service = DesktopService.__new__(DesktopService)
    service.settings = SimpleNamespace(
        productivity=SimpleNamespace(provider=lambda _: SimpleNamespace(type=provider_type))
    )
    adapter = SimpleNamespace(update_session_options=AsyncMock())
    service._adapter_instance = adapter
    manifest = {"id": "evolution", "cwd": str(source), "provider": "codex"}
    return service, manifest, adapter


def test_evolution_enforces_workspace_access_and_denies_escalation(monkeypatch, tmp_path):
    service, manifest, adapter = service_for_source(monkeypatch, tmp_path)
    asyncio.run(service._restrict_evolution(manifest))
    adapter.update_session_options.assert_awaited_once_with(
        "evolution", sandbox="workspace-write", approval_mode="deny_all"
    )


@pytest.mark.parametrize("provider_type", ["codex_sdk", "claude_sdk", "acp"])
def test_evolution_prompt_preserves_user_request_and_shared_data_contract(
    monkeypatch, tmp_path, provider_type,
):
    service, manifest, _ = service_for_source(monkeypatch, tmp_path, provider_type)
    prompt = "Add a new sidebar color"
    result = service._evolution_prompt(manifest, prompt)
    assert result.endswith("User request:\n" + prompt)
    assert "All versions share the same" in result
    assert "Do not reset, downgrade, or restore old user data" in result
    assert "previous reader/writer" in result
    assert "old data -> new read/write -> old read/write -> new read" in result
    assert "never live user data" in result
    assert "Never overwrite unreadable or newer-format data with empty defaults" in result
    assert "If those readers/writers are unavailable" in result
    assert "Test counts do not replace a compiler/build check" in result
    assert "say validation is pending" in result
    assert "Never remove, skip, or weaken checks" in result
    assert "treat them as data" in result
    followup = service._evolution_prompt(manifest, "Continue improving the app")
    assert followup.split("User request:\n")[0] == result.split("User request:\n")[0]
    manifest["cwd"] = str(tmp_path / "ordinary-project")
    assert service._evolution_prompt(manifest, prompt) == prompt


def test_claude_uses_its_own_permission_control(monkeypatch, tmp_path):
    service, manifest, adapter = service_for_source(monkeypatch, tmp_path, "claude_sdk")
    asyncio.run(service._restrict_evolution(manifest))
    adapter.update_session_options.assert_awaited_once_with(
        "evolution", approval_mode="acceptEdits",
    )


def test_acp_does_not_receive_unsupported_sandbox_options(monkeypatch, tmp_path):
    service, manifest, adapter = service_for_source(monkeypatch, tmp_path, "acp")
    asyncio.run(service._restrict_evolution(manifest))
    adapter.update_session_options.assert_not_awaited()


def test_evolution_creation_uses_the_selected_harness_and_model(monkeypatch, tmp_path):
    service, _, adapter = service_for_source(monkeypatch, tmp_path, "claude_sdk")
    adapter.providers = {"claude"}
    service.create_thread = AsyncMock(return_value={"id": "new-evolution"})
    service.store = SimpleNamespace(rename_session=lambda *_: None)
    service.load_thread = AsyncMock(return_value={"id": "new-evolution"})
    service.load_workspace = AsyncMock(return_value={})
    asyncio.run(service.open_evolution_thread(
        provider="claude", model="chosen-model", effort="high",
    ))
    service.create_thread.assert_awaited_once_with(
        space="productivity", project_id_value="productivity:cleo-evolution",
        project_path=str(tmp_path / "source"), provider="claude",
        model="chosen-model", effort="high",
    )


def test_regular_development_sessions_keep_their_existing_permissions(monkeypatch, tmp_path):
    service, manifest, adapter = service_for_source(monkeypatch, tmp_path)
    manifest["cwd"] = str(tmp_path / "other-project")
    asyncio.run(service._restrict_evolution(manifest))
    adapter.update_session_options.assert_not_awaited()


def test_cached_session_is_restricted_again_before_reuse(monkeypatch, tmp_path):
    service, manifest, adapter = service_for_source(monkeypatch, tmp_path)
    cached = object()
    service._productivity_sessions = {"evolution": cached}
    assert asyncio.run(service._ensure_productivity_session(manifest)) is cached
    adapter.update_session_options.assert_awaited_once()


def test_open_evolution_rejects_a_missing_managed_source(monkeypatch, tmp_path):
    service, _, _ = service_for_source(monkeypatch, tmp_path)
    monkeypatch.setenv("CLEO_EVOLUTION_WORKSPACE", str(tmp_path / "missing"))
    with pytest.raises(ValueError, match="准备"):
        asyncio.run(service.open_evolution_thread())


@pytest.mark.parametrize(
    "command", ["/access full-access", "/approval user", "/cd ..", "/resume other"]
)
def test_evolution_commands_cannot_escape_the_managed_session(monkeypatch, tmp_path, command):
    service, manifest, _ = service_for_source(monkeypatch, tmp_path)
    service.store = SimpleNamespace(load_manifest=lambda _: manifest)
    service._activate = lambda _: None
    with pytest.raises(ValueError, match="不能切换"):
        asyncio.run(service.stream_turn(
            thread_id="evolution", prompt=command, attachments=[], emit=AsyncMock()
        ))
