from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

import cleo.config.settings as settings_module
from cleo.config.settings import SettingsModel


@pytest.mark.parametrize("value", [[], None, True, 42, 1.5, "sk-config-secret"])
def test_load_settings_rejects_non_object_json(tmp_path: Path, value) -> None:
    config_path = tmp_path / "cleo.json"
    harnesses_path = tmp_path / "harnesses.json"
    content = json.dumps(value)
    config_path.write_text(content, encoding="utf-8")

    with pytest.raises(ValueError, match=r"^cleo.json must contain a JSON object\.$"):
        settings_module.load_settings(config_path, harnesses_path)

    assert config_path.read_text(encoding="utf-8") == content
    assert not harnesses_path.exists()


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


def test_load_settings_ignores_removed_memory_gate_configuration(tmp_path: Path) -> None:
    config_path = tmp_path / "cleo.json"
    config_path.write_text(
        json.dumps(
            {
                **_settings_payload(dream_agent=None),
                "memory_gate": {"enabled": True, "model": "legacy-model"},
            }
        ),
        encoding="utf-8",
    )

    settings = settings_module.load_settings(config_path, tmp_path / "harnesses.json")

    assert not hasattr(settings, "memory_gate")


def test_missing_dream_agent_profile_is_rejected() -> None:
    with pytest.raises(ValidationError, match="dream_agent:missing"):
        SettingsModel.model_validate(_settings_payload(dream_agent="missing"))


def test_browser_tools_have_safe_defaults() -> None:
    settings = SettingsModel.model_validate(_settings_payload(dream_agent=None))

    browser = settings.active_tools_profile.browser
    assert browser.enabled is True
    assert browser.headless is True
    assert browser.allow_private_network is False
    assert browser.allowed_domains == []
    assert browser.idle_timeout_seconds == 900


def test_browser_tool_unknown_configuration_is_rejected() -> None:
    payload = _settings_payload(dream_agent=None)
    payload["profiles"]["tools"] = {
        "default": {"browser": {"enabled": True, "unknown_option": True}}
    }

    with pytest.raises(ValidationError, match="unknown_option"):
        SettingsModel.model_validate(payload)


def test_settings_proxy_resolves_the_installed_configuration(monkeypatch) -> None:
    monkeypatch.setattr(settings_module, "_current_settings", None)
    model = SettingsModel.model_validate(_settings_payload(dream_agent="dream"))

    settings_module.configure_settings(model)

    assert settings_module.current_settings() is model
    assert settings_module.settings.active_profiles is model.active_profiles
    assert settings_module.settings.active_dream_agent_profile.model == "dream-model"


def test_settings_proxy_loads_from_disk_on_first_use(tmp_path: Path, monkeypatch) -> None:
    config_path = tmp_path / "cleo.json"
    config_path.write_text(json.dumps(_settings_payload(dream_agent=None)), encoding="utf-8")
    real_load = settings_module.load_settings
    calls = []

    def load_once():
        calls.append(config_path)
        return real_load(config_path, tmp_path / "harnesses.json")

    monkeypatch.setattr(settings_module, "_current_settings", None)
    monkeypatch.setattr(settings_module, "load_settings", load_once)

    assert settings_module.settings.active_agent_profile.model == "foreground-model"
    assert settings_module.settings.active_profiles.agent == "foreground"
    assert calls == [config_path]
