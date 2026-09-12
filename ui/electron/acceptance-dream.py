"""Replay the package's Dream extraction; input is a frozen fixture, output is JSON.

The model is deterministic. This tests format recovery, not model quality or memory relevance.
No consolidation or memory publication is invoked.
"""
import asyncio
import json
import socket
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
# Windows creates a loopback socket pair for the event loop's wake-up pipe.
# Create that local mechanism before rejecting all subsequent network connections.
loop = asyncio.new_event_loop()


def deny_network(*args, **kwargs):
    """Reject network use while replaying a captured response."""
    raise RuntimeError("Network is disabled during behavior replay")


socket.socket.connect = deny_network
socket.create_connection = deny_network

from langchain_core.messages import AIMessage  # noqa: E402

from cleo.agents.dream import DreamAgent  # noqa: E402
from cleo.memory.consolidation import Extraction  # noqa: E402

fixture = json.load(sys.stdin)
expected = Extraction.model_validate(json.loads(fixture["corrected"]))
calls = []


class RecordedModel:
    async def ainvoke(self, messages):
        """Return the failed output once, then the frozen corrected response."""
        calls.append(messages)
        if len(calls) > 3:
            raise RuntimeError("Retry budget exceeded")
        return AIMessage(content=fixture["invalid"] if len(calls) == 1 else fixture["corrected"])


async def main():
    """Exercise the actual extractor and report observations against the frozen contract."""
    agent = DreamAgent()
    agent.model = RecordedModel()
    try:
        result = await agent._extract(fixture["prompt"])
        passed = result.model_dump() == expected.model_dump() and 2 <= len(calls) <= 3
        passed = passed and all(messages[-1].content == fixture["prompt"] for messages in calls)
        outcome = "格式纠正成功，原始证据保持一致" if passed else "未满足纠正结果或重试约束"
        detail = f"{len(calls)} 次模型调用；{outcome}"
    except Exception as error:
        passed = False
        detail = f"{len(calls)} 次模型调用；{type(error).__name__}: {str(error)[:500]}"
    print(json.dumps(
        {"status": "passed" if passed else "failed", "detail": detail}, ensure_ascii=False,
    ))


try:
    loop.run_until_complete(main())
finally:
    loop.close()
