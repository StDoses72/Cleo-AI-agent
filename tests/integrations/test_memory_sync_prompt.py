import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from claude_agent_sdk import ResultMessage
from openai_codex import TextInput

from cleo.harnesses import SessionOptions
from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.memory.source_settings import save_source_settings


def test_codex_sync_guidance_is_read_each_turn_and_preserves_media_input(tmp_path):
    config = tmp_path / "memory-sources.json"
    memory = MemoryMcp(tmp_path / "memory", source_config_path=config)
    provider = CodexProvider(None, memory_mcp=memory)
    runtime = SimpleNamespace(
        has_started_turn=False, options=SessionOptions(approval_mode="deny_all"),
        client=SimpleNamespace(), legacy_home=False, thread=SimpleNamespace(turn=AsyncMock()),
    )
    async def run():
        save_source_settings(config, {"sync_enabled": True})
        await provider._start_turn(runtime, [TextInput("user input")])
        sent = runtime.thread.turn.call_args.args[0]
        assert "Optional native memory cooperation" in sent[0].text
        assert sent[1].text == "user input"
        save_source_settings(config, {"sync_enabled": False})
        await provider._start_turn(runtime, "second user input")
        assert runtime.thread.turn.call_args.args[0] == "second user input"
    asyncio.run(run())


def test_claude_sync_guidance_is_read_each_turn(tmp_path):
    config = tmp_path / "memory-sources.json"
    memory = MemoryMcp(tmp_path / "memory", source_config_path=config)
    class Client:
        query = AsyncMock()
        async def receive_response(self):
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1, session_id="native", result="done")
    provider = ClaudeProvider(memory_mcp=memory)
    provider._sessions["session"] = _ClaudeRuntime(Client(), SessionOptions(), str(tmp_path))
    async def run():
        save_source_settings(config, {"sync_enabled": True})
        await provider.prompt("session", "hello")
        assert "Optional native memory cooperation" in Client.query.call_args.args[0]
        save_source_settings(config, {"sync_enabled": False})
        await provider.prompt("session", "hello again")
        assert Client.query.call_args.args[0] == "hello again"
    asyncio.run(run())
