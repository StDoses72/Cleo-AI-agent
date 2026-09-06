"""Detached process launcher for the existing memory consolidation worker."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import TYPE_CHECKING

from cleo.sessions.policy import has_user_interaction

if TYPE_CHECKING:
    from cleo.sessions.store import SessionStore


def launch_dream_agent_worker(
    jobs: list[tuple[str, str | None, str]],
    *,
    store: SessionStore | None = None,
) -> bool:
    """Launch one detached worker to consolidate interactive sessions in order."""
    unique_jobs: list[tuple[str, str | None, str]] = []
    seen: set[tuple[str, str | None, str]] = set()
    for thread_id, project, space in jobs:
        job = (str(thread_id), project, str(space))
        if not job[0] or job in seen:
            continue
        seen.add(job)
        unique_jobs.append(job)
    if store is not None:
        meaningful_jobs: list[tuple[str, str | None, str]] = []
        for job in unique_jobs:
            try:
                events = store.read_events(job[0])
            except (FileNotFoundError, OSError, ValueError):
                continue
            if has_user_interaction(events):
                meaningful_jobs.append(job)
        unique_jobs = meaningful_jobs
    if not unique_jobs:
        return False

    command = [
        sys.executable,
        "-m",
        "cleo.cli.dream_worker",
        json.dumps(unique_jobs, ensure_ascii=False),
    ]
    kwargs: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(command, **kwargs)  # noqa: S603
    except OSError:
        return False
    return True
