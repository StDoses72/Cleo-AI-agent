from __future__ import annotations

import asyncio
import secrets
import threading
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from cleo.harnesses.models import AgentEvent, EventCallback, emit_event
from cleo.harnesses.questions import QuestionBroker, normalize_questions

_COMMAND_METHOD = "item/commandExecution/requestApproval"
_FILE_METHOD = "item/fileChange/requestApproval"
_PERMISSIONS_METHOD = "item/permissions/requestApproval"
_ELICITATION_METHOD = "mcpServer/elicitation/request"
_LEGACY_COMMAND_METHOD = "execCommandApproval"
_LEGACY_PATCH_METHOD = "applyPatchApproval"
_SUPPORTED_METHODS = {
    _COMMAND_METHOD,
    _FILE_METHOD,
    _PERMISSIONS_METHOD,
    _ELICITATION_METHOD,
    _LEGACY_COMMAND_METHOD,
    _LEGACY_PATCH_METHOD,
}
_DECISIONS = {"accept", "acceptForSession", "decline", "cancel"}


@dataclass(slots=True)
class _PendingApproval:
    request: dict[str, Any]
    method: str
    params: dict[str, Any]
    done: threading.Event = field(default_factory=threading.Event)
    response: dict[str, Any] | None = None


class CodexApprovalBroker:
    """Bridge synchronous app-server approval callbacks to Cleo's async UI."""

    def __init__(self, provider: str = "codex") -> None:
        self.provider = provider
        self.questions = QuestionBroker(provider)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._callback: EventCallback | None = None
        self._pending: dict[str, _PendingApproval] = {}
        self._lock = threading.Lock()

    def bind(
        self,
        loop: asyncio.AbstractEventLoop,
        callback: EventCallback | None,
    ) -> None:
        with self._lock:
            self._loop = loop
            self._callback = callback

    def unbind(self) -> None:
        with self._lock:
            self._loop = None
            self._callback = None

    def handle(self, method: str, params: dict[str, Any] | None) -> dict[str, Any]:
        params = dict(params or {})
        if method == "item/tool/requestUserInput":
            try:
                questions = normalize_questions(params.get("questions"))
            except ValueError:
                return {"answers": {}}
            answers = self.questions.ask_sync(questions, native_id=str(params.get("itemId") or ""))
            return {"answers": {key: {"answers": value} for key, value in (answers or {}).items()}}
        if method not in _SUPPORTED_METHODS:
            return {}
        with self._lock:
            loop = self._loop
            callback = self._callback
            if loop is None or callback is None:
                return self._safe_rejection(method, params)
            request = self._request(method, params)
            pending = _PendingApproval(request=request, method=method, params=params)
            self._pending[request["id"]] = pending

        try:
            dispatched = asyncio.run_coroutine_threadsafe(
                emit_event(callback, self._event("permission_request", method, request)),
                loop,
            )
            dispatched.result()
        except BaseException:
            with self._lock:
                self._pending.pop(request["id"], None)
            return self._safe_rejection(method, params)

        pending.done.wait()
        with self._lock:
            self._pending.pop(request["id"], None)
        return pending.response or self._safe_rejection(method, params)

    async def resolve(self, request_id: str, decision: str) -> dict[str, Any]:
        if decision not in _DECISIONS:
            raise ValueError(f"Unsupported approval decision: {decision}")
        with self._lock:
            pending = self._pending.get(request_id)
            if pending is None:
                raise ValueError("This approval request is no longer pending.")
            available = set(pending.request["availableDecisions"])
            if decision not in available:
                raise ValueError(f"Decision {decision!r} is not available for this request.")
            response = self._response(pending.method, pending.params, decision)
            callback = self._callback
            method = pending.method
            pending.response = response

        try:
            if callback is not None:
                await emit_event(
                    callback,
                    self._event(
                        "permission_response",
                        method,
                        {"id": request_id, "decision": decision},
                    ),
                )
        except Exception:
            # The approval response is already fixed; a closed UI stream must not
            # leave the app-server callback blocked or report a false rejection.
            pass
        finally:
            pending.done.set()
        return {"id": request_id, "decision": decision}

    def cancel_all(self) -> None:
        with self._lock:
            for pending in self._pending.values():
                pending.response = self._response(pending.method, pending.params, "cancel")
                pending.done.set()

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        kind = {
            _COMMAND_METHOD: "command",
            _FILE_METHOD: "file_change",
            _PERMISSIONS_METHOD: "permissions",
            _ELICITATION_METHOD: "elicitation",
            _LEGACY_COMMAND_METHOD: "command",
            _LEGACY_PATCH_METHOD: "file_change",
        }[method]
        raw_decisions = params.get("availableDecisions")
        decisions = [
            value
            for value in (raw_decisions if isinstance(raw_decisions, list) else [])
            if isinstance(value, str) and value in _DECISIONS
        ]
        if not decisions:
            decisions = ["accept", "acceptForSession", "decline", "cancel"]
        command = params.get("command")
        if isinstance(command, list):
            command = " ".join(str(part) for part in command)
        if not command and isinstance(params.get("fileChanges"), dict):
            command = ", ".join(str(path) for path in params["fileChanges"])
        request = {
            "id": f"approval-{secrets.token_hex(8)}",
            "kind": kind,
            "method": method,
            "threadId": str(params.get("threadId") or params.get("conversationId") or ""),
            "turnId": str(params.get("turnId") or ""),
            "itemId": str(params.get("itemId") or params.get("callId") or ""),
            "command": str(command or ""),
            "cwd": str(params.get("cwd") or ""),
            "reason": str(params.get("reason") or ""),
            "availableDecisions": decisions,
            "commandActions": params.get("commandActions") or params.get("parsedCmd") or [],
            "permissions": params.get("permissions") or params.get("additionalPermissions"),
            "grantRoot": params.get("grantRoot"),
            "startedAtMs": params.get("startedAtMs"),
        }
        if method == _ELICITATION_METHOD:
            unsupported = self._unsupported_elicitation(params)
            request.update(
                command=str(params.get("serverName") or "MCP"),
                reason=str(params.get("message") or "工具请求你的确认。"),
                mode=params.get("mode"),
                url=params.get("url") if params.get("mode") == "url" else None,
                unsupportedReason=unsupported,
                availableDecisions=(
                    ["cancel"] if unsupported else ["accept", "decline", "cancel"]
                ),
            )
        return request

    @staticmethod
    def _unsupported_elicitation(params: dict[str, Any]) -> str | None:
        mode = params.get("mode")
        if mode == "url":
            try:
                url = urlsplit(str(params.get("url") or ""))
                if url.scheme in {"https", "http"} and url.hostname:
                    return None
            except ValueError:
                pass
            return "此授权链接无效或使用了不支持的协议。请取消请求并联系工具提供方。"
        if mode == "form":
            schema = params.get("requestedSchema")
            if (
                isinstance(schema, dict)
                and schema.get("type") == "object"
                and not schema.get("properties")
                and not schema.get("required")
                and set(schema) <= {
                    "type", "properties", "required", "additionalProperties",
                    "$schema", "title", "description",
                }
            ):
                return None
        return (
            "此工具需要填写表单或使用尚未支持的授权格式。"
            "Cleo 目前仅支持确认和链接授权，请取消此请求。"
        )

    def _response(
        self,
        method: str,
        params: dict[str, Any],
        decision: str,
    ) -> dict[str, Any]:
        if method == _ELICITATION_METHOD:
            return {
                "action": decision,
                "content": {} if decision == "accept" and params.get("mode") == "form" else None,
            }
        if method in {_COMMAND_METHOD, _FILE_METHOD}:
            return {"decision": decision}
        if method == _PERMISSIONS_METHOD:
            accepted = decision in {"accept", "acceptForSession"}
            return {
                "permissions": params.get("permissions") if accepted else {},
                "scope": "session" if decision == "acceptForSession" else "turn",
            }
        legacy = {
            "accept": "approved",
            "acceptForSession": "approved_for_session",
            "decline": "denied",
            "cancel": "abort",
        }[decision]
        return {"decision": legacy}

    def _safe_rejection(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        # A missing UI or a broken callback is not a user's decision to deny.
        decision = "cancel" if method == _ELICITATION_METHOD else "decline"
        return self._response(method, params, decision)

    def _event(
        self,
        event_type: str,
        method: str,
        payload: dict[str, Any],
    ) -> AgentEvent:
        return AgentEvent(
            provider=self.provider,
            type=event_type,
            data={
                "schema_version": 1,
                "provider_event_type": method,
                "payload": payload,
            },
        )
