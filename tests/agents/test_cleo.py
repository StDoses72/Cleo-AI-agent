import asyncio

from langchain_core.messages import AIMessageChunk

from cleo.agents import Agent
from cleo.runtime.usage import ContextWindowUsage


def test_agent_stream_text_uses_async_graph_streaming() -> None:
    class FakeGraph:
        async def astream(self, payload, *, config, stream_mode):
            assert payload["messages"][-1]["content"] == "hello"
            assert config == {"configurable": {"thread_id": "thread-1"}}
            assert stream_mode == "messages"
            yield AIMessageChunk(content="hello"), {}
            yield AIMessageChunk(content=" world"), {}
            yield AIMessageChunk(
                content="",
                usage_metadata={
                    "input_tokens": 120,
                    "output_tokens": 30,
                    "total_tokens": 150,
                },
            ), {}

    agent = Agent.__new__(Agent)
    agent.deepagent = FakeGraph()
    agent.context_usage = ContextWindowUsage(window_tokens=1000)

    async def collect() -> list[str]:
        return [text async for text in agent.stream_text("hello", thread_id="thread-1")]

    assert asyncio.run(collect()) == ["hello", " world"]
    assert agent.context_usage.used_tokens == 150
    assert agent.context_usage.ratio == 0.15
