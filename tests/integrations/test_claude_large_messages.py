"""Feed screenshot-sized records through the actual SDK JSON reader."""

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport

from cleo.integrations.harnesses.claude import ClaudeProvider


def test_screenshot_tool_result_above_one_megabyte_survives_sdk_reader(tmp_path, monkeypatch):
    image = "a" * (2 * 1024 * 1024)
    message = {"type": "user", "message": {"content": [{
        "type": "tool_result", "tool_use_id": "snapshot", "content": [{
            "type": "image", "source": {"type": "base64", "data": image,
                                        "media_type": "image/png"}}]}]}}
    wire = json.dumps(message) + "\n"

    async def chunks():
        for offset in range(0, len(wire), 65536):
            yield wire[offset:offset + 65536]

    class Client:
        def __init__(self, options):
            self.transport = SubprocessCLITransport(
                prompt="", options=replace(options, cli_path="unused-cli"))
            self.transport._process = SimpleNamespace(wait=AsyncMock(return_value=0))
            self.transport._stdout_stream = chunks()

        async def connect(self):
            decoded = [item async for item in self.transport.read_messages()]
            assert decoded == [message]

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)
    asyncio.run(ClaudeProvider().create_session(str(tmp_path)))
