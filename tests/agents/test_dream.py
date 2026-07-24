from types import SimpleNamespace

from pydantic import SecretStr

import cleo.agents.dream as dream_module


def test_dream_agent_uses_independent_active_profile(monkeypatch) -> None:
    captured_model_options = {}
    dream_profile = SimpleNamespace(
        model="dream-model",
        provider="openai",
        api_key=SecretStr("dream-key"),
        temperature=0.2,
        base_url="https://dream.example/v1",
    )
    monkeypatch.setattr(
        dream_module,
        "settings",
        SimpleNamespace(active_dream_agent_profile=dream_profile),
    )
    monkeypatch.setattr(
        dream_module,
        "init_chat_model",
        lambda **options: captured_model_options.update(options) or object(),
    )
    monkeypatch.setattr(
        dream_module,
        "create_agent",
        lambda **_options: SimpleNamespace(),
    )

    dream_module.DreamAgent()

    assert captured_model_options == {
        "model": "dream-model",
        "model_provider": "openai",
        "api_key": "dream-key",
        "temperature": 0.2,
        "base_url": "https://dream.example/v1",
    }
