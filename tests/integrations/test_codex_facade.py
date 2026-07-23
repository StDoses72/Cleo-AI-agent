import asyncio

from cleo.harnesses import AgentResult
from cleo.integrations.codex import CodexAdapter, CodexResult


def test_codex_facade_uses_async_unified_adapter(tmp_path, monkeypatch) -> None:
    adapter = CodexAdapter(default_model="test-model", project_root=tmp_path)

    async def fake_run(**kwargs) -> AgentResult:
        assert kwargs == {
            "provider": "codex",
            "prompt": "hello",
            "project_path": ".",
            "model": "test-model",
        }
        await asyncio.sleep(0.05)
        return AgentResult(
            session_id="agent-1",
            provider="codex",
            native_session_id="thread-1",
            turn_id="turn-1",
            status="completed",
            response="done",
        )

    monkeypatch.setattr(adapter._adapter, "run", fake_run)

    async def exercise() -> CodexResult:
        task = asyncio.create_task(adapter.start("hello", ".", "test-model"))
        await asyncio.sleep(0.01)
        assert not task.done()
        return await task

    result = asyncio.run(exercise())
    assert result.thread_id == "thread-1"
    assert result.status == "completed"
