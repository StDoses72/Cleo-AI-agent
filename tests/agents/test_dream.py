import asyncio
from types import SimpleNamespace

from langchain_core.messages import HumanMessage
from pydantic import SecretStr

import cleo.agents.dream as dream_module
import cleo.memory.state as state_module
from cleo.memory.state import get_session_source
from cleo.sessions.store import SessionStore


def test_dream_agent_defers_model_until_source_profile_is_known(monkeypatch) -> None:
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

    agent = dream_module.DreamAgent()
    assert captured_model_options == {}
    agent._configure(dream_profile)

    assert captured_model_options == {
        "model": "dream-model",
        "model_provider": "openai",
        "api_key": "dream-key",
        "temperature": 0.2,
        "base_url": "https://dream.example/v1",
    }


def test_dream_agent_runs_llm_directly(tmp_path, monkeypatch) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root, memory_root / "sessions.sqlite3")
    store.sync_langchain_messages(
        session_id="session-timeout",
        space="productivity",
        project="cleo",
        messages=[HumanMessage(content="Remember this decision", id="human-1")],
        status="completed",
    )
    from cleo.config.settings import SettingsModel

    fake_settings = SettingsModel.model_validate({
        "active_profiles": {"agent": "primary", "dream_agent": "primary"},
        "profiles": {
            "agents": {"primary": {
                "provider": "openai", "model": "test-model", "api_key": "test-key",
            }},
            "directories": {"default": {"root_dir": str(tmp_path)}},
        },
    })
    monkeypatch.setattr(dream_module, "settings", fake_settings)
    monkeypatch.setattr("cleo.config.settings.settings", fake_settings)

    observed_phases = []

    class FakeGraph:
        async def ainvoke(self, *_args, **_kwargs):
            source = get_session_source("productivity", "cleo", "session-timeout")
            assert source is not None
            observed_phases.append(source["processing_phase"])
            state_module.mark_consolidated(
                "productivity",
                "cleo",
                "session-timeout",
                source["source_hash"],
                durable_memory_count=0,
                no_durable_memory_reason="No durable information in this test source.",
            )
            return {"status": "done"}

    monkeypatch.setattr(dream_module, "init_chat_model", lambda **_: object())
    monkeypatch.setattr(dream_module, "create_agent", lambda **_: FakeGraph())
    agent = dream_module.DreamAgent()

    result = asyncio.run(
        agent.invoke(
            session_id="session-timeout",
            project="cleo",
            space="productivity",
        )
    )

    assert result == {"status": "done"}
    assert observed_phases == ["llm"]
