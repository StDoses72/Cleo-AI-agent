import json
from pathlib import Path

import pytest

from cleo.desktop.configuration import read_model_settings, save_dream_settings, save_model_profile


def _config(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "active_profiles": {
                    "agent": "current",
                    "dream_agent": "current",
                    "directory": "default",
                    "shell": "default",
                    "tools": "default",
                },
                "profiles": {
                    "agents": {
                        "current": {
                            "provider": "openai",
                            "model": "existing-model",
                            "api_key": "existing-secret",
                            "max_tokens": 64000,
                            "temperature": 0.7,
                        }
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def test_model_settings_never_return_api_key(tmp_path: Path) -> None:
    path = tmp_path / "cleo.json"
    _config(path)

    settings = read_model_settings(path)

    assert settings["profiles"][0]["hasApiKey"] is True
    assert "apiKey" not in settings["profiles"][0]
    assert "existing-secret" not in json.dumps(settings)


def test_save_model_profile_can_activate_new_profile(tmp_path: Path) -> None:
    path = tmp_path / "cleo.json"
    _config(path)

    result = save_model_profile(
        path,
        {
            "name": "custom_api",
            "provider": "openai",
            "model": "custom-model",
            "apiKey": "new-secret",
            "baseUrl": "https://models.example/v1",
            "maxTokens": 128000,
            "activateAgent": True,
            "activateDreamAgent": False,
        },
    )

    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["profiles"]["agents"]["custom_api"]["api_key"] == "new-secret"
    assert saved["active_profiles"]["agent"] == "custom_api"
    assert saved["active_profiles"]["dream_agent"] == "current"
    assert result["activeAgent"] == "custom_api"


def test_new_model_profile_requires_api_key(tmp_path: Path) -> None:
    path = tmp_path / "cleo.json"
    _config(path)

    with pytest.raises(ValueError, match="API Key"):
        save_model_profile(
            path,
            {
                "name": "missing_key",
                "provider": "openai",
                "model": "custom-model",
            },
        )


def test_subscription_profile_and_dream_selection(tmp_path):
    path = tmp_path / "cleo.json"
    _config(path)
    result = save_model_profile(path, {
        "name": "subscription", "backend": "grok", "provider": "grok", "model": "default",
        "activateAgent": True,
    })
    assert result["activeDreamAgent"] == "current"
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert not raw["profiles"]["agents"]["subscription"]["api_key"]
    assert save_dream_settings(path, "mode:follow")["activeDreamAgent"] == ""
    assert save_dream_settings(path, "mode:disabled")["dreamEnabled"] is False
    assert save_dream_settings(path, "subscription")["dreamEnabled"] is True
    with pytest.raises(ValueError, match="Unknown"):
        save_dream_settings(path, "missing")
    save_model_profile(path, {
        "name": "follow", "backend": "codex", "provider": "codex", "model": "default",
    })
    assert save_dream_settings(path, "follow")["activeDreamAgent"] == "follow"
