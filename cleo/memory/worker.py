"""Detached worker for sequential DreamAgent memory consolidation.

The desktop backend launches this module on shutdown (see
``cleo.integrations.background.launch_dream_agent_worker``) with a JSON list of
``[thread_id, project, space]`` jobs. It runs without a console, so failures are written
to stderr and never stop the remaining jobs.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any


def _parse_jobs(raw: str) -> list[tuple[str, str | None, str]]:
    payload: Any = json.loads(raw)
    if not isinstance(payload, list):
        raise ValueError("jobs must be a list")
    jobs: list[tuple[str, str | None, str]] = []
    for item in payload:
        if not isinstance(item, list) or len(item) != 3:
            raise ValueError("each job must contain thread, project, and space")
        thread_id, project, space = item
        if not isinstance(thread_id, str) or not thread_id:
            raise ValueError("thread id must be a non-empty string")
        if project is not None and not isinstance(project, str):
            raise ValueError("project must be a string or null")
        if not isinstance(space, str) or not space:
            raise ValueError("space must be a non-empty string")
        jobs.append((thread_id, project, space))
    return jobs


async def consolidate(thread_id: str, project: str | None, space: str) -> dict | None:
    """Purpose: Consolidate one finished session with DreamAgent.

    Input: Session identity. Output: DreamAgent's result, or None when the session has no
    user input. Errors propagate to the caller.
    """
    from cleo.config.settings import settings
    from cleo.sessions.policy import has_user_interaction
    from cleo.sessions.store import SessionStore

    store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    if not has_user_interaction(store.read_events(thread_id)):
        return None
    from cleo.agents import DreamAgent

    return await DreamAgent().invoke(session_id=thread_id, project=project or "general",
                                     space=space)


async def _run_jobs(jobs: list[tuple[str, str | None, str]]) -> None:
    for thread_id, project, space in jobs:
        try:
            await consolidate(thread_id, project, space)
        except Exception as exc:  # One failed source must not block the rest of the queue.
            print(f"DreamAgent consolidation failed for {space}/{thread_id}: {exc}",
                  file=sys.stderr)


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    try:
        jobs = _parse_jobs(sys.argv[1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return 2
    from cleo.config.settings import current_settings

    current_settings()  # An unusable configuration stops the worker before any job starts.
    asyncio.run(_run_jobs(jobs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
