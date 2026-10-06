"""Runs in progress: at most one per thread, with its steering, approvals and workspace.

``RunSupervisor`` holds the state that used to be spread over eight ``DesktopService``
attributes, and the operations that keep it consistent: starting and finishing a run,
cancelling one, guarding a harness switch, and telling whether a workspace is in use.
The turn pipeline itself still lives in ``DesktopService.stream_turn``.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any


class RunSupervisor:
    def __init__(self) -> None:
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self.run_ids: dict[str, str] = {}
        self.steering: dict[str, Any] = {}
        self.approvals: dict[str, dict[str, dict[str, Any]]] = {}
        self.workspaces: dict[str, str] = {}
        # Held while a run claims a workspace and while undo/reset inspect it.
        self.workspace_guard = asyncio.Lock()
        self.runtime_locks: dict[str, asyncio.Lock] = {}
        self.harness_switches: set[str] = set()

    # Queries -------------------------------------------------------------------------
    def is_running(self, thread_id: str) -> bool:
        """Purpose: Whether a run is registered for the thread (it may be cancelling)."""
        return thread_id in self.tasks

    def any_running(self) -> bool:
        return bool(self.tasks)

    def running_threads(self) -> list[str]:
        return list(self.tasks)

    def unfinished(self, thread_id: str) -> asyncio.Task[Any] | None:
        """Purpose: The thread's run task when it has not finished yet."""
        task = self.tasks.get(thread_id)
        return task if task is not None and not task.done() else None

    def run_id(self, thread_id: str) -> str | None:
        return self.run_ids.get(thread_id)

    def steering_for(self, thread_id: str) -> Any | None:
        return self.steering.get(thread_id)

    def steer_ready(self, thread_id: str) -> bool:
        steering = self.steering.get(thread_id)
        return steering is not None and not steering.closed and steering.ready.is_set()

    def accepts_steer(self, thread_id: str, run_id: str, steering: Any | None) -> bool:
        """Purpose: Whether a steer for ``run_id`` can still reach the running turn.

        Input: Thread, run id and the steering run the caller looked up earlier.
        """
        task = self.tasks.get(thread_id)
        return bool(steering and steering.run_id == run_id
                    and task is not None and not task.cancelling()
                    and thread_id not in self.harness_switches)

    def pending_approvals(self, thread_id: str) -> list[dict[str, Any]]:
        return list(self.approvals.get(thread_id, {}).values())

    def is_switching(self, thread_id: str) -> bool:
        return thread_id in self.harness_switches

    def workspace_in_use(self, root: str) -> bool:
        """Purpose: Whether a running turn works in ``root``; hold ``workspace_guard``."""
        return root in self.workspaces.values()

    def runtime_lock(self, thread_id: str) -> asyncio.Lock:
        return self.runtime_locks.setdefault(thread_id, asyncio.Lock())

    # Lifecycle -----------------------------------------------------------------------
    def start(self, thread_id: str, task: asyncio.Task[Any] | None, run_id: str | None) -> str:
        """Purpose: Register a run. Output: Its run id (generated when not given)."""
        if task is not None:
            self.tasks[thread_id] = task
        self.run_ids[thread_id] = run_id or secrets.token_hex(16)
        return self.run_ids[thread_id]

    def attach_steering(self, thread_id: str, steering: Any) -> None:
        self.steering[thread_id] = steering

    def detach_steering(self, thread_id: str) -> None:
        self.steering.pop(thread_id, None)

    def claim_workspace(self, thread_id: str, root: str) -> list[str]:
        """Purpose: Record the run's workspace. Output: Other threads running in it.

        Hold ``workspace_guard`` while calling.
        """
        self.workspaces[thread_id] = root
        return [key for key, value in self.workspaces.items()
                if key != thread_id and value == root]

    def finish(self, thread_id: str) -> None:
        """Purpose: Forget a finished run; hold ``workspace_guard`` while calling."""
        self.workspaces.pop(thread_id, None)
        self.tasks.pop(thread_id, None)
        self.run_ids.pop(thread_id, None)
        self.approvals.pop(thread_id, None)

    async def cancel(self, thread_id: str, run_id: str | None = None) -> dict[str, Any]:
        """Purpose: Cancel the thread's run and wait until it has cleaned up.

        Input: Thread and, optionally, the run id the caller means; another run is left
        alone. Output: ``{"cancelled": bool}``. Raises what the run raised while stopping.
        """
        if run_id is not None and self.run_ids.get(thread_id) != run_id:
            return {"cancelled": False}
        task = self.tasks.get(thread_id)
        if task is not None:
            # The stream owns provider interruption and cleanup. Interrupting
            # here as well races turn/completed and can strand the next request.
            if not task.cancelling():
                steering = self.steering.get(thread_id)
                if steering:
                    steering.stop_accepting()
                task.cancel()
            result, = await asyncio.gather(task, return_exceptions=True)
            if isinstance(result, Exception):
                raise result
        return {"cancelled": task is not None}

    @contextmanager
    def harness_switch(self, thread_id: str) -> Iterator[None]:
        """Purpose: Mark a harness switch in progress; a second one is rejected."""
        if thread_id in self.harness_switches:
            raise ValueError("此会话正在切换 harness，请等待完成。")
        self.harness_switches.add(thread_id)
        try:
            yield
        finally:
            self.harness_switches.discard(thread_id)

    # Approvals -----------------------------------------------------------------------
    def add_approval(self, thread_id: str, request: dict[str, Any]) -> None:
        self.approvals.setdefault(thread_id, {})[request["id"]] = request

    def drop_approval(self, thread_id: str, approval_id: str) -> None:
        self.approvals.get(thread_id, {}).pop(approval_id, None)
