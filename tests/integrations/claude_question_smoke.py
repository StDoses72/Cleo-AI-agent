"""Opt-in real-CLI smoke for issue #152: AskUserQuestion round-trips through Cleo's broker.

Runs the real Claude Code CLI with the signed-in account and a small model (two short model
requests). Usage::

    python tests/integrations/claude_question_smoke.py [permission_mode]

Expected: a ``question_request`` event, the answer submitted through ``resolve_question``,
the same turn continuing to a final reply that mentions the chosen answer, and no pending
question left behind.
"""

import asyncio
import os
import sys
from tempfile import TemporaryDirectory

from cleo.integrations.harnesses.claude import ClaudeProvider

PROMPT = (
    "Use the AskUserQuestion tool to ask what my favourite colour is (offer options red, blue "
    "and green). After I answer, reply with exactly: FINAL: you chose <colour>. Ask nothing else."
)


async def main(permission_mode: str) -> int:
    with TemporaryDirectory(prefix="cleo-question-smoke-") as directory:
        provider = ClaudeProvider(
            default_model=os.environ.get("CLEO_SMOKE_MODEL", "haiku"),
            permission_mode=permission_mode,
        )
        session = await provider.create_session(directory)
        await provider.enable_questions(session.id)
        await provider.enable_user_approvals(session.id)
        events = []
        receipts = []

        async def on_event(event):
            events.append(event)
            print(f"event {event.type}: {(event.text or '')[:80]}", flush=True)
            if event.type == "question_request":
                request = event.data

                async def answer():
                    await asyncio.sleep(1)  # the dialog is open; the user takes a moment
                    answers = {q["id"]: ["blue"] for q in request["questions"]}
                    receipts.append(
                        await provider.resolve_question(session.id, request["id"], answers)
                    )

                asyncio.get_running_loop().create_task(answer())
            elif event.type == "permission_request":
                asyncio.get_running_loop().create_task(
                    provider.resolve_approval(session.id, event.data["id"], "accept")
                )

        try:
            turn = await asyncio.wait_for(provider.prompt(session.id, PROMPT, on_event), 150)
            pending = provider.pending_questions(session.id)
        finally:
            await provider.close(session.id)
    types = [event.type for event in events]
    ok = (
        turn.status == "completed"
        and "question_request" in types
        and "question_response" in types
        and types.index("question_response") < types.index("agent_message")
        and len(receipts) == 1
        and "blue" in (turn.response or "").lower()
        and not pending
    )
    print("event types:", types)
    print("final:", turn.status, turn.response)
    print("CLAUDE_QUESTION_SMOKE_PASSED" if ok else "CLAUDE_QUESTION_SMOKE_FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "acceptEdits")))
