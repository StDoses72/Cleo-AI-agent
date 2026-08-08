"""Detached worker for sequential DreamAgent memory consolidation."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from cleo.cli.lifecycle import _run_dream_agent


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


async def _run_jobs(jobs: list[tuple[str, str | None, str]]) -> None:
    for thread_id, project, space in jobs:
        await _run_dream_agent(thread_id, project, space)


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    try:
        jobs = _parse_jobs(sys.argv[1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return 2
    asyncio.run(_run_jobs(jobs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
