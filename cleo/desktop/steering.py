"""Run-bound steering receipts and delivery; never replay an uncertain submission."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from cleo.desktop.projection import steer_item
from cleo.desktop.timeline import TimelineIndex
from cleo.harnesses.control import SteerRejected


def validate_steer(request_id, run_id, text):
    for identifier in (request_id, run_id):
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 128:
            raise ValueError("引导消息缺少有效的请求或运行标识。")
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > 64_000:
        raise ValueError("请输入不超过 64 KB 的补充指令。")


def new_receipt(manifest, request_id, run_id, text, mode, turn_id=None):
    return {
        "id": request_id, "threadId": manifest["id"], "runId": run_id,
        "turnId": turn_id, "text": text, "mode": mode, "status": "queued",
        "revision": -1, "retryable": False, "createdAt": datetime.now(UTC).isoformat(),
    }


async def receipt_view(store, manifest, receipt):
    item = steer_item(receipt)
    location = await asyncio.to_thread(TimelineIndex(store, manifest).location_for, item["id"])
    return {**item, **(location or {})}


async def persist_receipt(store, manifest, receipt, **changes):
    updated = {**receipt, **changes, "revision": receipt["revision"] + 1}
    events = [{
        "id": f"steer-{updated['id']}:{updated['revision']}", "type": "steer",
        "actor": "user" if updated["revision"] == 0 else "system",
        "content": updated["text"], "data": {"payload": updated},
    }]
    if updated["mode"] == "native" and updated["status"] == "received":
        events.append({
            "id": f"steer-user-{updated['id']}", "type": "user_message", "actor": "user",
            "content": updated["text"],
            "data": {"steer_id": updated["id"], "turn_id": updated.get("turnId")},
        })
    appended = await asyncio.to_thread(
        store.append_events, space=manifest["space"], project=manifest["project"],
        session_id=manifest["id"], events=events,
    )
    if not any(event["id"] == events[0]["id"] for event in appended):
        existing = await asyncio.to_thread(TimelineIndex(store, manifest).steer, updated["id"])
        if existing["runId"] != updated["runId"] or existing["text"] != updated["text"]:
            raise ValueError("请求标识已被另一条指令使用。")
        return existing
    return updated


async def recover_steers(store, manifest, *, is_active=None):
    for receipt in await asyncio.to_thread(TimelineIndex(store, manifest).steers, unresolved=True):
        if is_active and is_active():
            return
        if receipt["status"] not in {"queued", "sending"}:
            await persist_receipt(store, manifest, receipt, retryable=False)
            continue
        sending = receipt["status"] == "sending"
        await persist_receipt(
            store, manifest, receipt, status="uncertain" if sending else "cancelled",
            retryable=False, error="上次运行已结束，未确认是否接收。" if sending
            else "上次运行已结束，这条指令未投递。",
        )


class SteeringRun:
    def __init__(self, store, manifest, run_id, mode, emit, deliver_native=None):
        self.store, self.manifest, self.run_id, self.mode = store, manifest, run_id, mode
        self.emit, self.deliver_native = emit, deliver_native
        self.ready = asyncio.Event()
        self.lock = asyncio.Lock()
        self.turn_id = None
        self.turn_ids = set()
        self.native_turn_id = None
        self.closed = False
        self.records = {}
        self.queue = []
        self.batch = []
        self.worker = None
        self.delivery = None

    def bind_turn(self, turn_id):
        self.turn_id = turn_id
        self.turn_ids.add(turn_id)
        self.ready.set()

    def native_ready(self, turn_id):
        self.native_turn_id = turn_id
        self._start_worker()

    async def _save(self, receipt, **changes):
        # The caller holds lock; persistence precedes delivery and visible acknowledgement.
        writing = asyncio.create_task(
            persist_receipt(self.store, self.manifest, receipt, **changes),
        )
        try:
            updated = await asyncio.shield(writing)
        except asyncio.CancelledError:
            updated = await writing
            self.records[updated["id"]] = updated
            raise
        self.records[updated["id"]] = updated
        view = await receipt_view(self.store, self.manifest, updated)
        try:
            await self.emit({"type": "upsert-item", "item": view})
        except (ConnectionError, OSError):
            logging.getLogger(__name__).warning("Steering receipt saved after UI disconnected")
        return updated

    async def submit(self, request_id, text, *, retry=False):
        await self.ready.wait()
        async with self.lock:
            receipt = self.records.get(request_id) or await asyncio.to_thread(
                TimelineIndex(self.store, self.manifest).steer, request_id,
            )
            if receipt:
                if receipt["runId"] != self.run_id or receipt["text"] != text:
                    raise ValueError("请求标识已被另一条指令使用。")
                if (receipt["status"] == "queued" and request_id not in self.queue
                        and receipt.get("turnId") in self.turn_ids and not self.closed):
                    # A log append can succeed before the manifest/API response fails.
                    self.records[request_id] = receipt
                    self.queue.append(request_id)
                    self._start_worker()
                can_retry = (retry and receipt["status"] == "failed" and receipt["retryable"]
                             and not self.closed
                             and receipt.get("nativeTurnId") == self.native_turn_id)
                if not can_retry:
                    return await receipt_view(self.store, self.manifest, receipt)
            else:
                receipt = new_receipt(
                    self.manifest, request_id, self.run_id, text, self.mode, self.turn_id,
                )
            if self.closed:
                receipt = await self._save(
                    receipt, status="failed", retryable=False, error="这一轮已结束，指令未投递。",
                )
            else:
                receipt = await self._save(receipt, status="queued", retryable=False, error=None)
                self.queue.append(request_id)
                self._start_worker()
            return await receipt_view(self.store, self.manifest, receipt)

    def _start_worker(self):
        if (self.mode == "native" and self.native_turn_id and not self.closed and self.queue
                and (self.worker is None or self.worker.done())):
            self.worker = asyncio.create_task(self._deliver())

    async def _deliver(self):
        while True:
            async with self.lock:
                if self.closed or not self.queue:
                    return
                identifier = self.queue.pop(0)
                receipt = await self._save(
                    self.records[identifier], status="sending", nativeTurnId=self.native_turn_id,
                )
                if receipt["status"] != "sending":
                    continue
                if self.closed:
                    await self._save(receipt, status="cancelled", error="运行已停止，指令未投递。")
                    return
            try:
                self.delivery = asyncio.create_task(
                    self.deliver_native(receipt["text"], receipt["nativeTurnId"]),
                )
                await self.delivery
            except SteerRejected as error:
                changes = {"status": "failed", "error": str(error), "retryable": error.retryable}
            except asyncio.CancelledError:
                async with self.lock:
                    await self._save(receipt, status="uncertain", retryable=False,
                                     error="运行已停止，未确认这条指令是否被接收。")
                    self.closed = True
                return
            except Exception:
                changes = {"status": "uncertain", "retryable": False,
                           "error": "连接中断，未确认是否接收。请先查看本轮回复。"}
            else:
                changes = {"status": "received", "retryable": False, "error": None}
            finally:
                self.delivery = None
            async with self.lock:
                await self._save(receipt, **changes)

    async def next_boundary(self):
        async with self.lock:
            if self.closed or not self.queue:
                self.closed = True
                self.ready.set()
                return None
            self.batch, self.queue = self.queue, []
            for identifier in self.batch:
                await self._save(self.records[identifier], status="sending")
            return "\n\n".join(self.records[key]["text"] for key in self.batch), list(self.batch)

    async def boundary_received(self):
        if not self.batch:
            return
        async with self.lock:
            for identifier in self.batch:
                receipt = self.records[identifier]
                if receipt["status"] == "sending":
                    await self._save(receipt, status="received", turnId=self.turn_id, error=None)
            self.batch.clear()

    def stop_accepting(self):
        self.closed = True
        self.ready.set()
        if self.delivery and not self.delivery.done() and not self.delivery.cancelling():
            self.delivery.cancel()

    async def close(self, reason="这一轮已结束，指令未投递。"):
        self.stop_accepting()
        async with self.lock:
            pass  # Wait for any already-claimed receipt write to finish.
        if self.worker:
            await asyncio.gather(self.worker, return_exceptions=True)
        async with self.lock:
            for receipt in list(self.records.values()):
                if receipt["status"] == "queued":
                    await self._save(receipt, status="cancelled", retryable=False, error=reason)
                elif receipt["status"] == "sending":
                    await self._save(receipt, status="uncertain", retryable=False,
                                     error="运行已结束，未确认这条指令是否被接收。")
                elif receipt.get("retryable"):
                    await self._save(receipt, retryable=False)
            self.queue.clear()
