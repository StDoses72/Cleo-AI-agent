"""JSON-lines stdio server used by the Electron main process."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from threading import Thread
from typing import Any

from cleo.desktop.service import DesktopService


class ProtocolServer:
    def __init__(self, service: DesktopService | None = None) -> None:
        self.service = service or DesktopService()
        self._write_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._stopping = False

    async def run(self) -> None:
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def read_stdin() -> None:
            for line in sys.stdin:
                loop.call_soon_threadsafe(queue.put_nowait, line)
            loop.call_soon_threadsafe(queue.put_nowait, None)

        Thread(target=read_stdin, name="cleo-desktop-stdin", daemon=True).start()
        while not self._stopping:
            line = await queue.get()
            if line is None:
                break
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            if request.get("method") == "shutdown":
                await self._handle(request)
                break
            task = asyncio.create_task(self._handle(request))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.service.shutdown()

    async def _handle(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("id") or "")
        method_name = str(request.get("method") or "")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        self._debug(f"handle {method_name} {request_id}")

        async def emit(event: dict[str, Any]) -> None:
            await self._write({"id": request_id, "type": "event", "event": event})

        try:
            if method_name == "stream_turn":
                await self.service.stream_turn(emit=emit, **params)
                result: Any = None
            elif method_name == "shutdown":
                self._stopping = True
                result = {"stopped": True}
            else:
                method = getattr(self.service, method_name, None)
                if not callable(method) or method_name.startswith("_"):
                    raise ValueError(f"unsupported desktop method: {method_name}")
                result = await method(**params)
            self._debug(f"complete {method_name} {request_id}")
            await self._write({"id": request_id, "type": "result", "result": result})
        except asyncio.CancelledError:
            await self._write({"id": request_id, "type": "result", "result": None})
        except Exception as exc:
            await self._write(
                {
                    "id": request_id,
                    "type": "error",
                    "error": {"name": type(exc).__name__, "message": str(exc)},
                }
            )

    @staticmethod
    def _debug(message: str) -> None:
        if os.environ.get("CLEO_DESKTOP_DEBUG") == "1":
            sys.stderr.write(f"[cleo-protocol] {message}\n")
            sys.stderr.flush()

    async def _write(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False, default=str)
        async with self._write_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()


async def amain() -> None:
    await ProtocolServer().run()


def main() -> None:
    asyncio.run(amain())


if __name__ == "__main__":
    main()
