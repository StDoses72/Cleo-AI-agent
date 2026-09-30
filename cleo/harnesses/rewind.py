"""Locate an earlier user turn inside a native harness conversation."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

UNLOCATED = "无法在原生会话中定位这条消息，未作修改。"


def locate_turn(entries: Sequence[tuple[Any, str]], prompt: str, later: Sequence[str]) -> Any:
    """Purpose: Align Cleo turns with native user messages, newest first.

    Input: Native (reference, text) pairs newest first, the edited turn's prompt, and the
    prompts of later Cleo turns oldest first. Native text may carry an injected prefix.
    Output: Reference of the edited turn; later turns that never reached the harness
    (for example a failed start) are skipped. Raises ValueError when it cannot be found.
    """
    wanted = [*reversed(later), prompt]
    start = 0
    for index, expected in enumerate(wanted):
        expected = expected.strip()
        found = next((position for position in range(start, len(entries))
                      if expected and entries[position][1].rstrip().endswith(expected)), None)
        if found is None:
            if index == len(wanted) - 1:
                raise ValueError(UNLOCATED)
            continue
        if index == len(wanted) - 1:
            return entries[found][0]
        start = found + 1
    raise ValueError(UNLOCATED)


# Runs in a child interpreter so the SDK reads the transcript directory from its own
# environment instead of this process's os.environ.
CLAUDE_TRANSCRIPT_SCRIPT = r"""
import json, sys
from claude_agent_sdk import fork_session, get_session_messages

request = json.load(sys.stdin)
if request["action"] == "fork":
    result = fork_session(request["session"], directory=request["cwd"],
                          up_to_message_id=request["message"])
    json.dump({"session": result.session_id}, sys.stdout)
else:
    rows = []
    for message in get_session_messages(request["session"], directory=request["cwd"]):
        content = (message.message or {}).get("content")
        text = None
        if message.type == "user":
            if isinstance(content, str):
                text = content
            elif isinstance(content, list) and not any(
                    isinstance(block, dict) and block.get("type") == "tool_result"
                    for block in content):
                text = "\n".join(block.get("text", "") for block in content
                                 if isinstance(block, dict) and block.get("type") == "text")
        rows.append({"uuid": message.uuid, "text": text})
    json.dump(rows, sys.stdout)
"""
