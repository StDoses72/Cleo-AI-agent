from __future__ import annotations

import asyncio
import inspect
import time

from langchain_core.messages import AIMessageChunk

import main
from core.agent import Agent, DreamAgent
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


def test_codex_sync_sdk_work_runs_outside_event_loop(tmp_path, monkeypatch) -> None:
    adapter = CodexAdapter(default_model="test-model", project_root=tmp_path)

    def slow_start(prompt: str, project_path: str, model: str) -> CodexResult:
        time.sleep(0.05)
        return CodexResult(
            thread_id="thread-1",
            turn_id="turn-1",
            status="completed",
            response=f"{prompt}:{model}:{project_path}",
        )

    monkeypatch.setattr(adapter, "_start_sync", slow_start)

    async def exercise() -> CodexResult:
        task = asyncio.create_task(adapter.start("hello", "."))
        await asyncio.sleep(0.01)
        assert not task.done()
        return await task

    result = asyncio.run(exercise())
    assert result.thread_id == "thread-1"
    assert result.status == "completed"
