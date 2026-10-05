"""Drive the real desktop backend process over its JSON-lines stdio protocol.

This mirrors ``ui/electron/backend.mjs``: one ``python -m cleo.desktop.server`` child,
one JSON object per line, responses correlated by ``id``. Nothing inside the backend is
patched; only the environment (CLEO_HOME and config paths) is chosen by the test.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .home import CleoHome

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TIMEOUT = 90.0


class BackendError(Exception):
    """A ``{"type": "error"}`` reply; ``name`` is the Python exception class name."""

    def __init__(self, name: str, message: str) -> None:
        super().__init__(f"{name}: {message}")
        self.name = name
        self.message = message


class Stream:
    """Events and the final reply of one request, readable while it is still running."""

    def __init__(self, backend: Backend, request_id: str) -> None:
        self._backend = backend
        self.id = request_id
        self.events: list[dict[str, Any]] = []
        self.reply: dict[str, Any] | None = None

    def _pump(self, timeout: float) -> bool:
        try:
            message = self._backend._queue(self.id).get(timeout=timeout)
        except queue.Empty:
            return False
        if message.get("type") == "event":
            self.events.append(message["event"])
        else:
            self.reply = message
        return True

    def wait_for(self, predicate: Callable[[dict[str, Any]], bool],
                 timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        seen = 0
        while True:
            for event in self.events[seen:]:
                if predicate(event):
                    return event
            seen = len(self.events)
            if self.reply is not None:
                raise AssertionError(f"stream ended before the expected event: {self.reply}")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no matching event; stderr:\n{self._backend.stderr_tail()}")
            self._pump(min(remaining, 0.5))

    def finish(self, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while self.reply is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"request {self.id} did not finish; stderr:\n{self._backend.stderr_tail()}")
            self._pump(min(remaining, 0.5))
        return self.reply

    def result(self, timeout: float = DEFAULT_TIMEOUT) -> Any:
        reply = self.finish(timeout)
        if reply["type"] == "error":
            raise BackendError(reply["error"]["name"], reply["error"]["message"])
        return reply["result"]


class Backend:
    def __init__(self, home: CleoHome, *, extra_env: dict[str, str] | None = None) -> None:
        self.home = home
        self._extra_env = extra_env or {}
        self._process: subprocess.Popen[str] | None = None
        self._queues: dict[str, queue.Queue[dict[str, Any]]] = {}
        self._queues_lock = threading.Lock()
        self._stderr: list[str] = []
        self.unmatched: list[str] = []
        self.stdout_lines: list[str] = []

    # Process lifecycle -------------------------------------------------------------
    def start(self) -> Backend:
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("CLEO_", "CODEX_", "CLAUDE_"))}
        env.update(self.home.env())
        env["PYTHONPATH"] = os.pathsep.join(
            part for part in (str(REPO_ROOT), os.environ.get("PYTHONPATH")) if part)
        env.update(self._extra_env)
        self._process = subprocess.Popen(
            [sys.executable, "-m", "cleo.desktop.server"],
            cwd=REPO_ROOT, env=env, text=True, encoding="utf-8", bufsize=1,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        return self

    def _read_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        for line in self._process.stdout:
            self.stdout_lines.append(line)
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                self.unmatched.append(line)
                continue
            self._queue(str(message.get("id", ""))).put(message)

    def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        for line in self._process.stderr:
            self._stderr.append(line)

    def stderr_tail(self, lines: int = 40) -> str:
        return "".join(self._stderr[-lines:])

    def _queue(self, request_id: str) -> queue.Queue[dict[str, Any]]:
        with self._queues_lock:
            return self._queues.setdefault(request_id, queue.Queue())

    @property
    def returncode(self) -> int | None:
        return None if self._process is None else self._process.poll()

    def wait_exit(self, timeout: float = 30) -> int:
        assert self._process is not None
        return self._process.wait(timeout=timeout)

    def stop(self) -> None:
        """Graceful exit exactly as Electron performs it (``shutdown`` request)."""
        if self._process is None or self._process.poll() is not None:
            return
        try:
            self.call("shutdown", timeout=30)
            self._process.wait(timeout=30)
        except Exception:
            self.kill()

    def kill(self) -> None:
        """Hard stop: skips shutdown hooks such as the detached DreamAgent worker."""
        if self._process is None or self._process.poll() is not None:
            return
        self._process.kill()
        self._process.wait(timeout=10)

    # Requests ----------------------------------------------------------------------
    def write_line(self, line: str) -> None:
        assert self._process is not None and self._process.stdin is not None
        self._process.stdin.write(line + "\n")
        self._process.stdin.flush()

    def request(self, method: str, params: Any = None, *, request_id: str | None = None) -> Stream:
        request_id = request_id or uuid.uuid4().hex
        self._queue(request_id)
        payload: dict[str, Any] = {"id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.write_line(json.dumps(payload, ensure_ascii=False))
        return Stream(self, request_id)

    def call(self, method: str, *, timeout: float = DEFAULT_TIMEOUT, **params: Any) -> Any:
        return self.request(method, params).result(timeout)

    def call_error(self, method: str, *, timeout: float = DEFAULT_TIMEOUT,
                   **params: Any) -> BackendError:
        try:
            result = self.call(method, timeout=timeout, **params)
        except BackendError as error:
            return error
        raise AssertionError(f"{method} unexpectedly succeeded: {result!r}")

    def stream_turn(self, thread_id: str, prompt: str, *, attachments: list | None = None,
                    run_id: str | None = None) -> Stream:
        params: dict[str, Any] = {"thread_id": thread_id, "prompt": prompt,
                                  "attachments": attachments or []}
        if run_id is not None:
            params["run_id"] = run_id
        return self.request("stream_turn", params)

    def run_turn(self, thread_id: str, prompt: str, **kwargs: Any) -> list[dict[str, Any]]:
        stream = self.stream_turn(thread_id, prompt, **kwargs)
        stream.result(kwargs.pop("timeout", DEFAULT_TIMEOUT) if "timeout" in kwargs else 120)
        return stream.events
