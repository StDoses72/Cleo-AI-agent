"""Deterministic OpenAI-compatible chat completions server for characterization tests.

The backend reaches it through an ordinary ``provider: openai`` profile whose ``base_url``
points at this server, so the chat path is exercised exactly as in production up to the
network boundary. Replies are scripted from markers in the latest user message:

- ``[[fail]]``  -> HTTP 500 with an OpenAI-style error body.
- ``[[slow]]``  -> streams one chunk, then holds the connection until the client leaves.
- ``[[delay]]`` -> waits ~1.5 s before answering normally (room for a queued steer).

DreamAgent requests (recognised by their system prompt) get a schema-valid extraction. When
the evidence contains ``[[prefer]]`` the extraction adds one preference citing the first
evidence record; otherwise it is the documented no-change result.
- otherwise     -> ``Echo: <user text>`` streamed in short chunks, then a usage chunk.
"""

from __future__ import annotations

import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

USAGE = {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}


def _latest_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                str(block.get("text", "")) for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
    return ""


DREAM_MARKER = "You maintain a small Markdown file of USER PREFERENCES"


def dream_reply(messages: list[dict[str, Any]]) -> str:
    evidence = _latest_user_text(messages)
    edits = []
    refs = re.findall(r'"record":"([^"]+)"', evidence)
    if "[[prefer]]" in evidence and refs:
        edits.append({"old": "", "new": "Prefers concise weekly plans",
                      "evidence_refs": [refs[0]]})
    return json.dumps({"edits": edits, "conflicts": [], "snapshot": None,
                       "work_item": "", "summary": "Scripted DreamAgent summary."})


def _is_dream(messages: list[dict[str, Any]]) -> bool:
    return any(message.get("role") == "system" and DREAM_MARKER in str(message.get("content"))
               for message in messages)


def reply_for(text: str) -> str:
    first_line = " ".join(text.split())
    return f"Echo: {first_line}"


class FakeLLM:
    """Threaded HTTP server; ``requests`` records every parsed request body."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.release_slow = threading.Event()
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: Any) -> None:
                return

            def do_GET(self) -> None:  # noqa: N802 - http.server API
                if self.path.rstrip("/").endswith("/models"):
                    self._json(200, {"object": "list", "data": [
                        {"id": "fake-chat", "object": "model", "owned_by": "cleo-tests"},
                        {"id": "fake-chat-mini", "object": "model", "owned_by": "cleo-tests"},
                    ]})
                    return
                self._json(404, {"error": {"message": "not found"}})

            def do_POST(self) -> None:  # noqa: N802 - http.server API
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                server.requests.append({"path": self.path, "body": body})
                if not self.path.rstrip("/").endswith("/chat/completions"):
                    self._json(404, {"error": {"message": "not found"}})
                    return
                text = _latest_user_text(body.get("messages") or [])
                if "[[fail]]" in text:
                    self._json(500, {"error": {"message": "fake upstream failure",
                                               "type": "server_error"}})
                    return
                messages = body.get("messages") or []
                answer = dream_reply(messages) if _is_dream(messages) else reply_for(text)
                if not body.get("stream"):
                    self._json(200, {
                        "id": "chatcmpl-fake", "object": "chat.completion", "created": 0,
                        "model": body.get("model"),
                        "choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": answer}}],
                        "usage": USAGE,
                    })
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                try:
                    if "[[slow]]" in text:
                        self._chunk(body, {"role": "assistant", "content": "Working"})
                        # Held until the backend cancels and drops the connection.
                        while not server.release_slow.wait(0.05):
                            self.wfile.write(b": keep-alive\n\n")
                            self.wfile.flush()
                        return
                    if "[[delay]]" in text:
                        time.sleep(1.5)
                    pieces = [answer[index:index + 8] for index in range(0, len(answer), 8)]
                    for index, piece in enumerate(pieces):
                        delta = {"content": piece}
                        if index == 0:
                            delta["role"] = "assistant"
                        self._chunk(body, delta)
                    self._chunk(body, {}, finish_reason="stop")
                    self._event({"id": "chatcmpl-fake", "object": "chat.completion.chunk",
                                 "created": 0, "model": body.get("model"), "choices": [],
                                 "usage": USAGE})
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    return

            def _chunk(self, body: dict[str, Any], delta: dict[str, Any],
                       finish_reason: str | None = None) -> None:
                self._event({
                    "id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 0,
                    "model": body.get("model"),
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
                })

            def _event(self, payload: dict[str, Any]) -> None:
                self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
                self.wfile.flush()
                time.sleep(0.002)

            def _json(self, status: int, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def start(self) -> FakeLLM:
        self._thread.start()
        return self

    def stop(self) -> None:
        self.release_slow.set()
        self._server.shutdown()
        self._server.server_close()

    def chat_requests(self) -> list[dict[str, Any]]:
        return [request["body"] for request in self.requests
                if request["path"].rstrip("/").endswith("/chat/completions")]
