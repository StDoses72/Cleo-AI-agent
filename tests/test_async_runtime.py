from __future__ import annotations

import asyncio
import inspect

from langchain_core.messages import AIMessageChunk

import main
from core.agent import Agent, DreamAgent
from core.integrations.agent_adapter import AgentResult
from core.integrations.codex import CodexAdapter, CodexResult


def test_primary_runtime_boundaries_are_async() -> None:
    assert inspect.iscoroutinefunction(main.amain)
    assert not inspect.iscoroutinefunction(main.main)
    assert inspect.isasyncgenfunction(Agent.stream_text)
    assert inspect.iscoroutinefunction(DreamAgent.invoke)
    assert inspect.iscoroutinefunction(CodexAdapter.start)
    assert inspect.iscoroutinefunction(CodexAdapter.reply)


def test_agent_stream_text_uses_async_graph_streaming() -> None:
    class FakeGraph:
        async def astream(self, payload, *, config, stream_mode):
            assert payload["messages"][-1]["content"] == "hello"
            assert config == {"configurable": {"thread_id": "thread-1"}}
            assert stream_mode == "messages"
            yield AIMessageChunk(content="hello"), {}
            yield AIMessageChunk(content=" world"), {}

    agent = Agent.__new__(Agent)
    agent.deepagent = FakeGraph()

    async def collect() -> list[str]:
        return [text async for text in agent.stream_text("hello", thread_id="thread-1")]

    assert asyncio.run(collect()) == ["hello", " world"]


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
