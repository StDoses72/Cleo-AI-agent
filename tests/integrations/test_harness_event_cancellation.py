"""The turn owns accepted ACP notifications even when their RPC tasks outlive prompt."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from acp import start_tool_call, update_tool_call
from acp.schema import PermissionOption

from cleo.harnesses.handoff import DELIVERED_EVENT
from cleo.harnesses.models import AgentEvent
from cleo.harnesses.provider import ProviderSession
from cleo.harnesses.service import AgentService
from cleo.integrations.harnesses.acp import (
    AcpAgentSpec,
    AcpProvider,
    _AcpClientHost,
    _AcpRuntime,
)
from cleo.sessions.store import SessionStore


class NotificationConnection:
    """ACP dispatches notifications independently of the prompt response future."""

    def __init__(self, host, *, running=False, permission=False):
        self.host = host
        self.running = running
        self.permission = permission
        self.queued = asyncio.Event()
        self.returned = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.notifications = []

    async def prompt(self, session_id, prompt):
        self.callback = self.host._callback

        async def notify(update, *, last=False):
            # This callback runs after session_update has entered relay and suspended.
            if last:
                asyncio.get_running_loop().call_soon(self.queued.set)
            await self.host.session_update(session_id, update)

        if self.permission:
            self.notifications.append(asyncio.create_task(self.host.request_permission(
                session_id,
                start_tool_call("permission", "Write file", status="pending"),
                [PermissionOption(option_id="allow", name="Allow", kind="allow_once")],
            )))
        else:
            self.notifications.extend([
                asyncio.create_task(notify(
                    start_tool_call("tool", "Write file", status="in_progress"),
                )),
                asyncio.create_task(notify(
                    update_tool_call("tool", status="completed"), last=True,
                )),
            ])
            await self.queued.wait()
        if self.running:
            await asyncio.Event().wait()
        asyncio.get_running_loop().call_soon(self.returned.set)
        return SimpleNamespace(stop_reason="end_turn")

    async def cancel(self, session_id):
        self.cancelled.set()


def acp_service(tmp_path, *, running=False, permission=False):
    store = SessionStore(tmp_path / "memory")
    host = _AcpClientHost("acp", str(tmp_path), auto_approve=False)
    host.approval_mode = "user"
    host.approvals.enabled = True
    connection = NotificationConnection(host, running=running, permission=permission)
    provider = AcpProvider("acp", AcpAgentSpec(command="unused"))
    provider._sessions["native"] = _AcpRuntime(connection, AsyncMock(), host)
    provider.create_session = AsyncMock(return_value=ProviderSession("native", "native"))
    service = AgentService(tmp_path, session_store=store)
    service.register(provider)
    return service, store, connection


def block_first_write(store):
    started = threading.Event()
    release = threading.Event()
    append = store.append_events

    def append_events(**kwargs):
        if any(event["type"] == "tool_call" for event in kwargs["events"]):
            started.set()
            assert release.wait(10), "test did not release blocked write"
        return append(**kwargs)

    store.append_events = append_events
    return started, release


def test_cancel_drains_accepted_acp_notifications_before_status_and_next_turn(tmp_path):
    async def scenario():
        service, store, connection = acp_service(tmp_path, running=True)
        session = await service.create_session("acp", str(tmp_path))
        started, release = block_first_write(store)
        shown = []
        task = asyncio.create_task(service.prompt(session.id, "go", shown.append))
        try:
            await asyncio.wait_for(connection.queued.wait(), 5)
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            await asyncio.wait_for(connection.cancelled.wait(), 5)
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert all(notification.done() for notification in connection.notifications)
            assert await asyncio.gather(*connection.notifications) == [None, None]
            events = store.read_events(session.id)
            kinds = [event["type"] for event in events]
            assert [kind for kind in kinds if kind.startswith("tool_")] == [
                "tool_call", "tool_result",
            ]
            assert kinds.index("tool_result") < kinds.index("session_cancelled")
            assert store.load_manifest(session.id)["status"] == "cancelled"
            await asyncio.wait_for(connection.callback(AgentEvent(
                provider="acp", type="tool_result", text="late notification",
            )), 5)
            assert store.read_events(session.id) == events
            connection.running = False
            result = await asyncio.wait_for(service.prompt(session.id, "again", shown.append), 5)
            assert result.status == "completed"
        finally:
            release.set()
            task.cancel()
            for notification in connection.notifications:
                notification.cancel()
            await asyncio.gather(task, *connection.notifications, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("cancel_during", ["event_drain", "context_checkpoint"])
def test_cancel_after_acp_return_preserves_terminal_and_handoff_commit(tmp_path, cancel_during):
    async def scenario():
        service, store, connection = acp_service(tmp_path)
        session = await service.create_session("acp", str(tmp_path))
        route = service._sessions[session.id]
        route.context_binding = service._context.prepare(
            session.id, store.read_events(session.id),
        ).binding
        route.handoff_id = "handoff-under-test"
        route.handoff = "Previous context"
        if cancel_during == "event_drain":
            started, release = block_first_write(store)
        else:
            started, release = threading.Event(), threading.Event()
            prepare = service._context.prepare

            def prepare_context(*args):
                started.set()
                assert release.wait(10), "test did not release context checkpoint"
                return prepare(*args)

            service._context.prepare = prepare_context
        task = asyncio.create_task(service.prompt(session.id, "go", lambda event: None))
        try:
            await asyncio.wait_for(connection.returned.wait(), 5)
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            cancelled = asyncio.Event()
            asyncio.get_running_loop().call_soon(cancelled.set)
            await cancelled.wait()
            task.cancel()
            release.set()
            result = await asyncio.wait_for(task, 5)
            assert result.status == "completed"
            assert not connection.cancelled.is_set()
            assert all(notification.done() for notification in connection.notifications)
            assert await asyncio.gather(*connection.notifications) == [None, None]
            events = store.read_events(session.id)
            kinds = [event["type"] for event in events]
            assert kinds.index("tool_result") < kinds.index("session_completed")
            assert "session_cancelled" not in kinds
            assert any(event.get("data", {}).get("provider_event_type") == DELIVERED_EVENT
                       for event in events)
            assert store.load_manifest(session.id)["status"] == "completed"
            assert route.handoff_id is None
        finally:
            release.set()
            task.cancel()
            for notification in connection.notifications:
                notification.cancel()
            await asyncio.gather(task, *connection.notifications, return_exceptions=True)

    asyncio.run(scenario())


@pytest.mark.parametrize("failure_at", ["storage", "callback"])
def test_detached_notification_failure_fails_the_turn(tmp_path, failure_at):
    async def scenario():
        service, store, connection = acp_service(tmp_path)
        session = await service.create_session("acp", str(tmp_path))
        append = store.append_events

        def append_events(**kwargs):
            if failure_at == "storage" and any(
                event["type"] == "tool_result" for event in kwargs["events"]
            ):
                raise OSError("event delivery failed")
            return append(**kwargs)

        def on_event(event):
            if failure_at == "callback" and event.type == "tool_result":
                raise OSError("event delivery failed")

        store.append_events = append_events
        try:
            with pytest.raises(OSError, match="event delivery failed"):
                await service.prompt(session.id, "go", on_event)
            assert all(notification.done() for notification in connection.notifications)
            outcomes = await asyncio.gather(*connection.notifications, return_exceptions=True)
            assert isinstance(outcomes[1], OSError)
            assert store.load_manifest(session.id)["status"] == "failed"
            assert not any(event["type"] == "session_completed"
                           for event in store.read_events(session.id))
        finally:
            await asyncio.gather(*connection.notifications, return_exceptions=True)

    asyncio.run(scenario())


def test_provider_failure_drains_accepted_notifications_before_failed_status(tmp_path):
    async def scenario():
        service, store, connection = acp_service(tmp_path)
        session = await service.create_session("acp", str(tmp_path))
        prompt = connection.prompt

        async def failing_prompt(*args):
            await prompt(*args)
            raise RuntimeError("provider failed")

        connection.prompt = failing_prompt
        started, release = block_first_write(store)
        task = asyncio.create_task(service.prompt(session.id, "go", lambda event: None))
        try:
            await asyncio.wait_for(connection.queued.wait(), 5)
            assert await asyncio.to_thread(started.wait, 5)
            release.set()
            with pytest.raises(RuntimeError, match="provider failed"):
                await asyncio.wait_for(task, 5)
            assert all(notification.done() for notification in connection.notifications)
            assert await asyncio.gather(*connection.notifications) == [None, None]
            kinds = [event["type"] for event in store.read_events(session.id)]
            assert kinds.index("tool_result") < kinds.index("session_failed")
            assert store.load_manifest(session.id)["status"] == "failed"
        finally:
            release.set()
            task.cancel()
            for notification in connection.notifications:
                notification.cancel()
            await asyncio.gather(task, *connection.notifications, return_exceptions=True)

    asyncio.run(scenario())


def test_cancel_with_acp_approval_pending_records_resolution_and_settles_request(tmp_path):
    async def scenario():
        service, store, connection = acp_service(tmp_path, running=True, permission=True)
        session = await service.create_session("acp", str(tmp_path))
        requested = asyncio.Event()

        def on_event(event):
            if event.type == "permission_request":
                requested.set()

        task = asyncio.create_task(service.prompt(session.id, "go", on_event))
        try:
            await asyncio.wait_for(requested.wait(), 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert not connection.host.approvals.pending
            assert all(notification.done() for notification in connection.notifications)
            response, = await asyncio.gather(*connection.notifications)
            assert response.outcome.outcome == "cancelled"
            events = store.read_events(session.id)
            kinds = [event["type"] for event in events]
            assert kinds.index("permission_response") < kinds.index("session_cancelled")
        finally:
            task.cancel()
            for notification in connection.notifications:
                notification.cancel()
            await asyncio.gather(task, *connection.notifications, return_exceptions=True)

    asyncio.run(scenario())
