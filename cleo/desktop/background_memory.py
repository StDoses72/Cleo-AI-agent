"""One cancellable, sequential memory batch, triggered by time or pending-source count."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any


class BackgroundMemory:
    def __init__(
        self, *, settings: Callable[[], dict[str, Any]],
        sources: Callable[[], list[dict[str, Any]]],
        review: Callable[[dict[str, Any]], Awaitable[dict[str, Any] | None]],
        busy: Callable[[], bool], clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._sources = sources
        self._review = review
        self._busy = busy
        self._clock = clock
        self._last_started = clock()
        self._task: asyncio.Task[None] | None = None
        self._attempted: dict[tuple[str, str, str], str] = {}
        self._closed = False
        self._resume_due = False
        self._status = "idle"
        self._last_error: str | None = None
        self._last_run_at: str | None = None

    def state(self) -> dict[str, Any]:
        settings = self._settings()
        return {
            **settings, "running": self._task is not None and not self._task.done(),
            "status": self._status, "lastError": self._last_error,
            "lastRunAt": self._last_run_at,
            "pendingCount": len(self._pending()) if settings["enabled"] else 0,
        }

    def reset_schedule(self) -> None:
        self._last_started = self._clock()
        self._resume_due = False

    def _pending(self) -> list[dict[str, Any]]:
        # A persisted running source may outlive its process. DreamAgent rechecks it
        # under the existing project lock, so a live publisher keeps ownership.
        return [source for source in self._sources() if source["status"] in {"pending", "running"}]

    @staticmethod
    def _key(source: dict[str, Any]) -> tuple[str, str, str]:
        return source["space"], source["project"], source["session_id"]

    def start_if_due(self) -> None:
        settings = self._settings()
        if (self._closed or not settings["enabled"] or not settings["dreamEnabled"]
                or self._busy() or self._task is not None and not self._task.done()):
            return
        pending = self._pending()
        sources = [source for source in pending
                   if self._attempted.get(self._key(source)) != source["source_hash"]]
        if not sources:
            return
        elapsed = self._clock() - self._last_started
        if (not self._resume_due and elapsed < settings["intervalMinutes"] * 60
                and len(pending) < settings["pendingThreshold"]):
            return
        self._resume_due = False
        self._last_started = self._clock()
        self._last_run_at = datetime.now(UTC).isoformat()
        self._status, self._last_error = "running", None
        self._task = asyncio.create_task(self._run(sources))

    async def _run(self, sources: list[dict[str, Any]]) -> None:
        try:
            for source in sources:
                settings = self._settings()
                if (self._closed or self._busy() or not settings["enabled"]
                        or not settings["dreamEnabled"]):
                    break
                # A manual review, new turn or project move may have changed this snapshot.
                current = next((item for item in self._pending()
                                if self._key(item) == self._key(source)), None)
                if current is None or current["source_hash"] != source["source_hash"]:
                    continue
                try:
                    result = await self._review(source)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self._last_error = str(error)
                    result = None
                if isinstance(result, dict) and result.get("status") == "pending":
                    continue  # A recovered snapshot finished; newer events still need a pass.
                self._attempted[self._key(source)] = source["source_hash"]
            self._status = "failed" if self._last_error else "idle"
        except asyncio.CancelledError:
            self._status = "cancelled"
            raise
        except Exception as error:
            self._status, self._last_error = "failed", str(error)

    def request_cancel(self) -> asyncio.Task[None] | None:
        task = self._task
        if task is not None and not task.done():
            self._resume_due = True
            self._status = "cancelled"
            if not task.cancelling():
                task.cancel()
        return task

    async def cancel(self, *, close: bool = False) -> None:
        self._closed = self._closed or close
        task = self.request_cancel()
        if task is not None and not task.done():
            # Cancelling a foreground waiter must not cancel a publisher a second time.
            await asyncio.shield(asyncio.gather(task, return_exceptions=True))
            if task.cancelled():
                self._status = "cancelled"
