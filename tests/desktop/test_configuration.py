import json
from pathlib import Path

import pytest

from cleo.desktop.configuration import (
    create_model_connection,
    read_model_settings,
    remove_model_connection,
    rename_model_connection,
    save_dream_settings,
    save_model_profile,
    select_chat_model,
)


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


def test_create_connection_preserves_defaults_and_accepts_display_names(tmp_path):
    path = tmp_path / "cleo.json"
    _config(path)
    result = create_model_connection(path, {
        "displayName": "我的 Codex", "backend": "codex", "provider": "codex",
        "models": ["gpt-6-astra", "gpt-5.6-sol", "gpt-6-astra"],
    })
    assert result["activeAgent"] == "current"
    assert result["activeDreamAgent"] == "current"
    added = next(p for p in result["profiles"] if p["displayName"] == "我的 Codex")
    assert added["models"] == ["gpt-6-astra", "gpt-5.6-sol"]
    assert "apiKey" not in added
    before = path.read_bytes()
    with pytest.raises(ValueError, match="已被使用"):
        create_model_connection(path, {
            "displayName": "我的 Codex", "backend": "codex", "provider": "codex",
            "models": ["another"],
        })
    assert path.read_bytes() == before


def test_default_model_change_does_not_change_dream_choice(tmp_path):
    path = tmp_path / "cleo.json"
    _config(path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["profiles"]["agents"]["current"]["models"] = ["existing-model", "new-model"]
    path.write_text(json.dumps(raw), encoding="utf-8")
    result = select_chat_model(path, "current", "new-model")
    assert result["profiles"][0]["model"] == "new-model"
    assert result["activeDreamModel"] == "existing-model"
    result = save_dream_settings(path, "current", "new-model")
    select_chat_model(path, "current", "existing-model")
    assert read_model_settings(path)["activeDreamModel"] == "new-model"
    before = path.read_bytes()
    with pytest.raises(ValueError, match="不属于"):
        select_chat_model(path, "current", "unregistered-model")
    assert path.read_bytes() == before


def test_rename_retains_id_and_remove_blocks_active_connections(tmp_path):
    path = tmp_path / "cleo.json"
    _config(path)
    rename_model_connection(path, "current", "日常对话")
    assert read_model_settings(path)["profiles"][0]["name"] == "current"
    assert "existing-secret" in path.read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="正在被使用"):
        remove_model_connection(path, "current")
    result = create_model_connection(path, {
        "displayName": "备用 API", "provider": "openai", "apiKey": "spare-secret",
        "models": ["spare-model"],
    })
    identifier = next(p["name"] for p in result["profiles"] if p["displayName"] == "备用 API")
    save_dream_settings(path, identifier, "spare-model")
    with pytest.raises(ValueError, match="正在被使用"):
        remove_model_connection(path, identifier)
    save_dream_settings(path, "mode:follow")
    result = remove_model_connection(path, identifier)
    assert len(result["profiles"]) == 1
    assert "spare-secret" not in path.read_text(encoding="utf-8")
