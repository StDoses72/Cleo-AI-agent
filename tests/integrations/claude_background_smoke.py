"""Opt-in real-CLI smoke for issue #152: a background task wakes Claude inside one Cleo turn.

Runs the real Claude Code CLI with the signed-in account and a small model (two short model
requests). Usage::

    python tests/integrations/claude_background_smoke.py

Expected: one ``ProviderTurn`` whose events contain both stage replies, a background-task
tool item that ends ``completed``, and a final response starting with ``STAGE2``.
"""

import asyncio
import os
import sys
from tempfile import TemporaryDirectory

from cleo.integrations.harnesses.claude import ClaudeProvider

PROMPT = (
    "Run `sleep 6 && echo BG_DONE` with the Bash tool using run_in_background=true, then reply "
    "exactly 'STAGE1: started' and end your turn without waiting. When you are notified that "
    "the background task completed, reply exactly 'STAGE2: <the command output>'."
)


async def main() -> int:
    with TemporaryDirectory(prefix="cleo-background-smoke-") as directory:
        provider = ClaudeProvider(
            default_model=os.environ.get("CLEO_SMOKE_MODEL", "haiku"),
            permission_mode="acceptEdits",
        )
        session = await provider.create_session(directory)
        events = []

        async def on_event(event):
            events.append(event)
            print(f"event {event.type}: {(event.text or '')[:80]}", flush=True)

        try:
            turn = await asyncio.wait_for(provider.prompt(session.id, PROMPT, on_event), 180)
        finally:
            await provider.close(session.id)
    replies = [event.text for event in events if event.type == "agent_message"]
    background = [event for event in events
                  if event.type == "tool_result"
                  and event.data.get("provider_event_type") == "task_notification"]
    stages = [event for event in events if event.type == "status"
              and event.data.get("provider_event_type") == "claude/stage_completed"]
    ok = (
        turn.status == "completed"
        and (turn.response or "").startswith("STAGE2")
        and any((text or "").startswith("STAGE1") for text in replies)
        and len(stages) >= 1
        and background and background[-1].data.get("status") == "completed"
    )
    print("replies:", replies)
    print("final:", turn.status, turn.response)
    print("CLAUDE_BACKGROUND_SMOKE_PASSED" if ok else "CLAUDE_BACKGROUND_SMOKE_FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
