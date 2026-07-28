import asyncio

import pytest

from cleo.harnesses import AgentResult, AgentSession
from cleo.integrations.codex import CodexAdapter, CodexResult


def test_codex_facade_uses_async_unified_adapter(tmp_path, monkeypatch) -> None:
    adapter = CodexAdapter(default_model="test-model", project_root=tmp_path)
    closed: list[str] = []

    async def fake_create(provider, **kwargs) -> AgentSession:
        assert provider == "codex"
        assert kwargs == {
            "project_path": ".",
            "model": "test-model",
        }
        return AgentSession(
            id="agent-1",
            provider="codex",
            native_session_id="thread-1",
            project_path=".",
            project="general",
        )

    async def fake_prompt(session_id, prompt) -> AgentResult:
        assert (session_id, prompt) == ("agent-1", "hello")
        await asyncio.sleep(0.05)
        return AgentResult(
            session_id="agent-1",
            provider="codex",
            native_session_id="thread-1",
            turn_id="turn-1",
            status="completed",
            response="done",
        )

    async def fake_close(session_id) -> None:
        closed.append(session_id)

    monkeypatch.setattr(adapter._adapter, "create_session", fake_create)
    monkeypatch.setattr(adapter._adapter, "prompt", fake_prompt)
    monkeypatch.setattr(adapter._adapter, "close", fake_close)

    async def exercise() -> CodexResult:
        task = asyncio.create_task(adapter.start("hello", ".", "test-model"))
        await asyncio.sleep(0.01)
        assert not task.done()
        return await task

    result = asyncio.run(exercise())
    assert result.thread_id == "thread-1"
    assert result.status == "completed"
    assert closed == ["agent-1"]


def test_codex_facade_closes_new_session_when_prompt_fails(tmp_path, monkeypatch) -> None:
    adapter = CodexAdapter(default_model="test-model", project_root=tmp_path)
    closed: list[str] = []

    async def fake_create(*_args, **_kwargs) -> AgentSession:
        return AgentSession(
            id="agent-failed",
            provider="codex",
            native_session_id="thread-failed",
            project_path=".",
            project="general",
        )

    async def fake_prompt(*_args, **_kwargs) -> AgentResult:
        raise RuntimeError("turn failed")

    async def fake_close(session_id) -> None:
        closed.append(session_id)

    monkeypatch.setattr(adapter._adapter, "create_session", fake_create)
    monkeypatch.setattr(adapter._adapter, "prompt", fake_prompt)
    monkeypatch.setattr(adapter._adapter, "close", fake_close)

    with pytest.raises(RuntimeError, match="turn failed"):
        asyncio.run(adapter.start("hello", "."))

    assert closed == ["agent-failed"]


def test_codex_facade_serializes_same_thread_replies_and_releases_locks(
    tmp_path,
    monkeypatch,
) -> None:
    adapter = CodexAdapter(default_model="test-model", project_root=tmp_path)
    active_prompts = 0
    max_active_prompts = 0
    resumed: list[str] = []
    closed: list[str] = []

    async def fake_resume(**kwargs) -> AgentSession:
        assert kwargs["provider"] == "codex"
        assert kwargs["native_session_id"] == "thread-1"
        session_id = f"agent-{len(resumed) + 1}"
        resumed.append(session_id)
        return AgentSession(
            id=session_id,
            provider="codex",
            native_session_id="thread-1",
            project_path=kwargs["project_path"],
            project="general",
        )

    async def fake_prompt(session_id, prompt) -> AgentResult:
        nonlocal active_prompts, max_active_prompts
        active_prompts += 1
        max_active_prompts = max(max_active_prompts, active_prompts)
        await asyncio.sleep(0.02)
        active_prompts -= 1
        return AgentResult(
            session_id=session_id,
            provider="codex",
            native_session_id="thread-1",
            turn_id=f"turn-{prompt}",
            status="completed",
            response=prompt,
        )

    async def fake_close(session_id) -> None:
        closed.append(session_id)

    monkeypatch.setattr(adapter._adapter, "resume_session", fake_resume)
    monkeypatch.setattr(adapter._adapter, "prompt", fake_prompt)
    monkeypatch.setattr(adapter._adapter, "close", fake_close)

    async def exercise() -> tuple[CodexResult, CodexResult]:
        first, second = await asyncio.gather(
            adapter.reply("thread-1", "one", "."),
            adapter.reply("thread-1", "two", "."),
        )
        return first, second

    first, second = asyncio.run(exercise())

    assert {first.response, second.response} == {"one", "two"}
    assert max_active_prompts == 1
    assert resumed == ["agent-1", "agent-2"]
    assert closed == resumed
    assert adapter._thread_locks == {}
