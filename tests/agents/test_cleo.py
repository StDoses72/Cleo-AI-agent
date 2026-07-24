import asyncio
from types import SimpleNamespace

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


def test_agent_backend_uses_configured_application_root(tmp_path, monkeypatch) -> None:
    import cleo.agents.cleo as agent_module

    (tmp_path / "skills" / "demo").mkdir(parents=True)
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "MEMORY_POLICY.md").write_text(
        "# Memory Policy\n",
        encoding="utf-8",
    )
    (tmp_path / "workspace").mkdir()

    monkeypatch.setattr(
        agent_module,
        "settings",
        SimpleNamespace(
            active_directory_profile=SimpleNamespace(root_path=tmp_path),
        ),
    )
    monkeypatch.setattr(agent_module, "init_chat_model", lambda **_kwargs: object())
    monkeypatch.setattr(
        agent_module,
        "create_deep_agent",
        lambda **_kwargs: SimpleNamespace(),
    )

    agent = agent_module.Agent()

    assert agent.root_dir == tmp_path
    assert agent.backend.ls("/skills").error is None
    assert agent.backend.read("/memory/MEMORY_POLICY.md").error is None
    assert agent.backend.ls("/workspace").error is None
