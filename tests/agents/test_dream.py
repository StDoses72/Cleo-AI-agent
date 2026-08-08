import asyncio
from types import SimpleNamespace

from langchain_core.messages import HumanMessage
from pydantic import SecretStr

import cleo.agents.dream as dream_module
import cleo.memory.state as state_module
from cleo.memory.gate import MemoryGateResult
from cleo.memory.state import get_session_source
from cleo.sessions.store import SessionStore


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


def test_dream_agent_gate_skips_without_invoking_the_llm(tmp_path, monkeypatch) -> None:
    memory_root = tmp_path / "memory"
    store = SessionStore(memory_root, memory_root / "sessions.sqlite3")
    store.sync_langchain_messages(
        session_id="session-thanks",
        space="non_productivity",
        project="general",
        messages=[HumanMessage(content="谢谢，知道了", id="human-1")],
        status="completed",
    )
    fake_settings = SimpleNamespace(MEMORY_DIR=memory_root, memory_gate=object())
    monkeypatch.setattr(dream_module, "settings", fake_settings)
    monkeypatch.setattr(state_module, "settings", fake_settings)
    monkeypatch.setattr(
        dream_module,
        "evaluate_memory_gate",
        lambda *_args: MemoryGateResult(
            decision="skip",
            reason="transient acknowledgement",
            model="fake-model",
            negative_score=0.9,
            message_count=1,
        ),
    )
    agent = object.__new__(dream_module.DreamAgent)

    result = asyncio.run(
        agent.invoke(
            session_id="session-thanks",
            project="general",
            space="non_productivity",
        )
    )

    assert result["status"] == "skipped"
    source = get_session_source(
        "non_productivity",
        "general",
        "session-thanks",
        path=memory_root / "non_productivity" / "memory_state.json",
    )
    assert source is not None
    assert source["processed_hash"] == source["source_hash"]
    assert source["consolidated_hash"] is None
