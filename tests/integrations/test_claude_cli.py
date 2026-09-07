import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import pytest

from cleo.config.settings import AgentProfile
from cleo.integrations import claude_cli, subscriptions
from cleo.integrations.subscriptions import AgentMcp


class InputPipe:
    def write(self, value):
        self.value = value

    async def drain(self):
        pass

    def close(self):
        pass


@pytest.mark.parametrize("fails", [False, True])
def test_claude_stream_resume_errors_and_temporary_cleanup(tmp_path, monkeypatch, fails):
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")
    mcp = AgentMcp(profile, tmp_path, "Cleo persona")
    captured = {}
    events = []
    monkeypatch.setattr(subscriptions, "executable", lambda _: "claude")
    monkeypatch.setattr(
        claude_cli,
        "TemporaryDirectory",
        lambda **kw: TemporaryDirectory(
            dir=tmp_path,
            **kw,
        ),
    )

    async def spawn(*args, **kwargs):
        captured["args"] = args
        captured["mcp_path"] = args[args.index("--mcp-config") + 1]
        config = json.loads(Path(captured["mcp_path"]).read_text(encoding="utf-8"))
        assert set(config["mcpServers"]) == {"cleo-tools"}
        stdout = asyncio.StreamReader()
        stderr = asyncio.StreamReader()
        messages = [
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "Hi"},
                },
            },
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "tool-1",
                            "name": "read_file",
                            "input": {},
                        }
                    ]
                },
            },
            {"type": "result", "session_id": "native", "result": "Hi", "is_error": fails},
        ]
        stdout.feed_data(("\n".join(json.dumps(m) for m in messages) + "\n").encode())
        stdout.feed_eof()
        stderr.feed_eof()

        async def wait():
            return 0

        return SimpleNamespace(
            stdout=stdout,
            stderr=stderr,
            stdin=InputPipe(),
            returncode=0,
            wait=wait,
        )

    monkeypatch.setattr(claude_cli.asyncio, "create_subprocess_exec", spawn)

    async def exercise():
        provider = claude_cli.ClaudeCliProvider(profile, mcp)
        session = await provider.resume_session("native", str(tmp_path))
        try:
            if fails:
                with pytest.raises(RuntimeError, match="did not complete"):
                    await provider.prompt(session.id, "Hello", on_event=events.append)
            else:
                result = await provider.prompt(session.id, "Hello", on_event=events.append)
                assert result.native_session_id == "native"
                assert result.response == "Hi"
        finally:
            await provider.close(session.id)

    asyncio.run(exercise())
    assert "--model" not in captured["args"]
    assert "--resume" in captured["args"]
    assert "--dangerously-skip-permissions" not in captured["args"]
    assert [event.type for event in events] == ["assistant_message_chunk", "tool_call"]
    assert not Path(captured["mcp_path"]).exists()


def test_codex_default_defers_to_runtime(tmp_path):
    profile = AgentProfile(backend="codex", provider="codex", model="default")
    provider = subscriptions.create_runtime(profile, AgentMcp(profile, tmp_path, ""))
    assert provider._default_model is None


@pytest.mark.parametrize("backend", ["gemini", "copilot", "grok"])
def test_acp_model_is_selected_even_without_config_options(tmp_path, monkeypatch, backend):
    monkeypatch.setattr(subscriptions, "executable", lambda _: "official-cli")
    profile = AgentProfile(backend=backend, provider=backend, model="chosen-model")
    provider = subscriptions.create_runtime(profile, AgentMcp(profile, tmp_path, ""))
    assert provider._spec.args[:2] == ("--model", "chosen-model")
    assert provider._spec.auto_approve is False
