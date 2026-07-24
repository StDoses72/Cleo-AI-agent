from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

import cleo.config.settings as settings_module
from cleo.config.settings import SettingsModel


def test_app_home_prefers_explicit_override(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    override = tmp_path / "cleo-home"
    monkeypatch.setenv("CLEO_HOME", str(override))

    assert settings_module._app_home(source_root) == override.resolve()


def test_app_home_uses_source_checkout_when_pyproject_exists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    (source_root / "pyproject.toml").write_text("", encoding="utf-8")
    monkeypatch.delenv("CLEO_HOME", raising=False)

    assert settings_module._app_home(source_root) == source_root.resolve()


def test_app_home_uses_platform_user_data_for_installed_package(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_root = tmp_path / "site-packages"
    source_root.mkdir()
    user_data = tmp_path / "local-data" / "Cleo"
    monkeypatch.delenv("CLEO_HOME", raising=False)
    monkeypatch.setattr(
        settings_module,
        "user_data_dir",
        lambda *_args, **_kwargs: str(user_data),
    )

    assert settings_module._app_home(source_root) == user_data.resolve()


def _settings_payload(*, dream_agent: str | None) -> dict:
    active_profiles = {"agent": "foreground"}
    if dream_agent is not None:
        active_profiles["dream_agent"] = dream_agent
    return {
        "active_profiles": active_profiles,
        "profiles": {
            "agents": {
                "foreground": {
                    "provider": "openai",
                    "model": "foreground-model",
                    "api_key": "foreground-key",
                },
                "dream": {
                    "provider": "openai",
                    "model": "dream-model",
                    "api_key": "dream-key",
                    "temperature": 0.2,
                },
            }
        },
    }


def test_dream_agent_profile_can_be_selected_independently() -> None:
    settings = SettingsModel.model_validate(_settings_payload(dream_agent="dream"))

    assert settings.active_agent_profile.model == "foreground-model"
    assert settings.active_dream_agent_profile.model == "dream-model"
    assert settings.active_dream_agent_profile.temperature == 0.2


def test_dream_agent_profile_falls_back_to_foreground_for_legacy_config() -> None:
    settings = SettingsModel.model_validate(_settings_payload(dream_agent=None))

    assert settings.active_dream_agent_profile is settings.active_agent_profile


def test_missing_dream_agent_profile_is_rejected() -> None:
    with pytest.raises(ValidationError, match="dream_agent:missing"):
        SettingsModel.model_validate(_settings_payload(dream_agent="missing"))
