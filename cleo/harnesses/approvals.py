"""Async approval lifecycle shared by providers with native permission callbacks."""

from __future__ import annotations

import asyncio
import logging
import secrets

from cleo.harnesses.models import AgentEvent, EventCallback, emit_event


class PermissionBroker:
    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.enabled = False
        self.callback: EventCallback | None = None
        self.pending: dict[str, tuple[dict, asyncio.Future]] = {}
        self.reviewed_items: set[str] = set()

    def request(self, **fields) -> dict:
        return {
            "id": f"approval-{secrets.token_hex(12)}", "provider": self.provider,
            "kind": "permissions", "method": "can_use_tool", "threadId": "", "turnId": "",
            "itemId": "", "command": "", "cwd": "", "reason": "",
            "commandActions": [], "permissions": None, "grantRoot": None, "startedAtMs": None,
            "availableDecisions": ["accept", "decline", "cancel"], **fields,
        }

    async def _emit(self, kind: str, payload: dict) -> None:
        await emit_event(self.callback, AgentEvent(provider=self.provider, type=kind, data=payload))

    async def record(self, request: dict, decision: str, *, source: str, policy=None) -> dict:
        if request.get("itemId"):
            self.reviewed_items.add(request["itemId"])
        receipt = {"id": request["id"], "decision": decision, "source": source,
                   "request": request, "policy": policy}
        await self._emit("permission_response", receipt)
        return receipt

    async def ask(self, request: dict) -> str:
        if not self.enabled or self.callback is None:
            await self.record(request, "cancel", source="unavailable")
            return "cancel"
        future = asyncio.get_running_loop().create_future()
        self.pending[request["id"]] = (request, future)
        try:
            await self._emit("permission_request", request)
            return await future
        except asyncio.CancelledError:
            if request["id"] in self.pending:
                await self.resolve(request["id"], "cancel", source="lifecycle")
            raise
        except Exception:
            if future.done() and not future.cancelled():
                logging.getLogger(__name__).warning("Approval stream closed after a decision")
                return future.result()
            raise
        finally:
            self.pending.pop(request["id"], None)

    async def resolve(self, identifier: str, decision: str, *, source: str = "user") -> dict:
        pending = self.pending.get(identifier)
        if pending is None:
            raise ValueError("This approval request is no longer pending.")
        request, future = pending
        if decision not in request["availableDecisions"]:
            raise ValueError(f"Decision {decision!r} is not available for this request.")
        # Claim before awaiting persistence: cancellation or duplicate UI replies cannot replace it.
        self.pending.pop(identifier)
        try:
            await self.record(request, decision, source=source)
        except Exception:
            logging.getLogger(__name__).warning("Approval decision could not be recorded")
        finally:
            if not future.done():
                future.set_result(decision)
        return {"id": identifier, "decision": decision}

    async def cancel_all(self) -> None:
        for identifier in list(self.pending):
            if identifier in self.pending:
                await self.resolve(identifier, "cancel", source="lifecycle")
