"""Bounded local approval bridge for workers in separate harness MCP processes."""

import asyncio
import hashlib
import json
import re
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from cleo.routing.catalog import atomic_json


def _path(store, parent_id, approval_id):
    """Purpose: Keep opaque approval identifiers out of paths.

    Input: Store and host-bound identities. Output: A confined local record path.
    """
    key = hashlib.sha256(f"{parent_id}\0{approval_id}".encode()).hexdigest()
    return Path(store.memory_root) / ".routing" / "approvals" / f"{key}.json"


def _active(store, parent_id, item):
    """Purpose: Reject stale or foreign worker requests.

    Input: Host parent and an approval record. Output: Whether its worker is still running.
    """
    try:
        if not re.fullmatch(r"task_[a-f0-9]{32}", item["task_id"]):
            return False
        child = store.load_manifest(item["child_id"])
        task_path = Path(store.memory_root) / ".routing" / "tasks" / f"{item['task_id']}.json"
        task = json.loads(task_path.read_text(encoding="utf-8"))
        return (item["parent_id"] == parent_id
                and item.get("run_id") == store.load_manifest(parent_id).get(
                    "routing_permission_run_id")
                and item.get("expires_at", 0) > time.time()
                and child.get("parent_session_id") == parent_id
                and child.get("routing_task_id") == item["task_id"]
                and task.get("parent_session_id") == parent_id
                and task.get("status") == "running"
                and any(attempt.get("session_id") == item["child_id"]
                        and attempt.get("status") == "running"
                        for attempt in task.get("attempts", [])))
    except (OSError, ValueError, KeyError, TypeError):
        return False


async def worker_approval(store, adapter, parent_id, child_id, task_id, request, *,
                          run_id=None, timeout_seconds=600):
    """Purpose: Send a worker's native approval to the existing desktop approval UI.

    Input: Host-bound execution and native request. Output: One native decision, or cancellation.
    The delegate's deadline and cancellation bound this wait; no inference is performed.
    """
    path = _path(store, parent_id, request["id"])
    item = {"parent_id": parent_id, "child_id": child_id, "task_id": task_id,
            "run_id": run_id, "expires_at": time.time() + min(timeout_seconds, 3600),
            "request": {**request, "threadId": parent_id}, "status": "pending"}
    atomic_json(path, item)
    try:
        while True:
            saved = json.loads(path.read_text(encoding="utf-8"))
            decision = saved.get("decision")
            if decision is None and not _active(store, parent_id, saved):
                choices = request["availableDecisions"]
                decision = next((value for value in ("cancel", "decline", "reject")
                                 if value in choices), None)
                if decision is None:
                    await adapter.cancel(child_id)
                    break
            if decision is not None:
                await adapter.resolve_approval(child_id, request["id"], decision)
                break
            await asyncio.sleep(0.15)
    finally:
        # Delete transient commands/tool arguments after the decision or cancellation.
        path.unlink(missing_ok=True)


def resolve_worker_approval(store, parent_id, approval_id, decision):
    """Purpose: Claim a live routed approval without resuming a worker in another process.

    Input: UI parent, opaque request ID and native decision. Output: Receipt, or None if unrelated.
    """
    path = _path(store, parent_id, approval_id)
    if not path.is_file():
        return None
    item = json.loads(path.read_text(encoding="utf-8"))
    if not _active(store, parent_id, item) or item.get("status") != "pending":
        raise ValueError("子任务审批已结束，请刷新后重试。")
    if decision not in item["request"]["availableDecisions"]:
        raise ValueError("此审批不支持该选项。")
    atomic_json(path, {**item, "status": "decided", "decision": decision})
    return {"id": approval_id, "decision": decision}


@asynccontextmanager
async def watch_worker_approvals(store, parent_id, emit):
    """Purpose: Project subprocess worker requests through the parent's normal event stream.

    Input: Store, host parent and desktop event sink. Output: A cancellable local polling scope.
    """
    observed = {}

    async def poll():
        """Purpose: Reconcile live requests. Input: Bound host scope. Output: Approval UI events."""
        while True:
            pending = {}
            for path in (Path(store.memory_root) / ".routing" / "approvals").glob("*.json"):
                try:
                    if path.stat().st_size > 128_000:
                        continue
                    item = json.loads(path.read_text(encoding="utf-8"))
                    if item.get("status") == "pending" and _active(store, parent_id, item):
                        pending[item["request"]["id"]] = item
                except (OSError, ValueError, KeyError, TypeError):
                    continue
            for identifier, item in pending.items():
                if identifier not in observed:
                    await emit({"type": "approval-request", "request": item["request"]})
            for identifier in observed.keys() - pending.keys():
                await emit({"type": "approval-resolved", "response": {"id": identifier}})
            observed.clear()
            observed.update(pending)
            await asyncio.sleep(0.25)

    runner = asyncio.create_task(poll())
    try:
        yield
    finally:
        runner.cancel()
        with suppress(asyncio.CancelledError):
            await runner
        for identifier in observed:
            with suppress(OSError, ValueError):
                resolve_worker_approval(store, parent_id, identifier, "cancel")
            await emit({"type": "approval-resolved", "response": {"id": identifier}})
