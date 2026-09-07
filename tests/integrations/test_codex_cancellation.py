import asyncio
from threading import Event
from types import SimpleNamespace

from openai_codex import AsyncTurnHandle
from openai_codex.async_client import AsyncCodexClient
from openai_codex.generated.v2_all import TurnCompletedNotification

from cleo.desktop.service import DesktopService
from cleo.integrations.harnesses.codex import CodexProvider, _CodexRuntime


def test_desktop_cancel_waits_for_cleanup_without_interrupting_twice():
    async def scenario():
        interrupts = []
        ready = asyncio.Event()
        cleanup_started = asyncio.Event()
        release_cleanup = asyncio.Event()

        async def interrupt(*_args):
            interrupts.append("interrupt")

        async def run():
            ready.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await interrupt()
                cleanup_started.set()
                await release_cleanup.wait()

        service = object.__new__(DesktopService)
        service.store = SimpleNamespace(load_manifest=lambda _: {"space": "productivity"})
        service._productivity_sessions = {"thread": object()}
        service._adapter = lambda: SimpleNamespace(cancel=interrupt)
        task = asyncio.create_task(run())
        service._run_tasks = {"thread": task}
        await ready.wait()
        cancellation = asyncio.create_task(service.cancel_run(thread_id="thread"))
        repeated = None
        try:
            await asyncio.wait_for(cleanup_started.wait(), 1)
            repeated = asyncio.create_task(service.cancel_run(thread_id="thread"))
            await asyncio.sleep(0)
            assert not cancellation.done(), "Do not unlock the composer before cleanup finishes"
            assert interrupts == ["interrupt"]
        finally:
            release_cleanup.set()
            await asyncio.gather(task, cancellation)
            if repeated is not None:
                await repeated

    asyncio.run(scenario())


def test_new_turn_cannot_replace_a_stream_still_cancelling():
    async def scenario():
        service = object.__new__(DesktopService)
        service.store = SimpleNamespace(load_manifest=lambda _: {"space": "productivity"})
        service._activate = lambda _: None
        ready = asyncio.Event()
        release = asyncio.Event()

        async def run():
            ready.set()
            await release.wait()

        task = asyncio.create_task(run())
        service._run_tasks = {"thread": task}
        await ready.wait()
        try:
            try:
                await service.stream_turn(
                    thread_id="thread", prompt="next", attachments=[], emit=lambda _: None,
                )
            except RuntimeError as error:
                assert "当前运行尚未结束" in str(error)
            else:
                raise AssertionError("A second stream replaced the active task")
            assert service._run_tasks["thread"] is task
        finally:
            release.set()
            await task

    asyncio.run(scenario())


def test_cancel_releases_pending_approval_before_interrupt_and_allows_next_turn():
    async def scenario():
        provider = CodexProvider(None)
        approval_ready = asyncio.Event()
        interrupted = asyncio.Event()
        approval_task = None
        calls = []

        async def on_event(event):
            if event.type == "permission_request":
                approval_ready.set()

        class Turn:
            id = "turn"

            async def stream(self):
                nonlocal approval_task
                approval_task = asyncio.create_task(asyncio.to_thread(
                    runtime.approvals.handle,
                    "item/commandExecution/requestApproval",
                    {"command": "test", "threadId": "thread"},
                ))
                await asyncio.shield(approval_task)
                if runtime.user_approvals_enabled:
                    await interrupted.wait()
                yield SimpleNamespace(method="turn/completed", payload=SimpleNamespace(
                    model_dump=lambda **_: {
                        "turn": {"id": self.id, "status": "completed"},
                    },
                ))

            async def interrupt(self):
                calls.append("interrupt")
                # The SDK's reader cannot deliver the interrupt reply until
                # its synchronous approval callback returns.
                await asyncio.shield(approval_task)
                interrupted.set()

        class Thread:
            id = "thread"

            async def turn(self, *_args, **_kwargs):
                return Turn()

        runtime = _CodexRuntime(SimpleNamespace(), Thread(), user_approvals_enabled=True)
        provider._sessions["thread"] = runtime
        task = asyncio.create_task(provider.prompt("thread", "first", on_event))
        await asyncio.wait_for(approval_ready.wait(), 1)
        task.cancel()
        try:
            done, _ = await asyncio.wait({task}, timeout=1)
            assert task in done, "Cancellation is blocked by its own approval callback"
            assert task.cancelled()
            assert calls == ["interrupt"]
            assert not runtime.lock.locked()
            assert runtime.active_turn is None
            runtime.user_approvals_enabled = False
            result = await asyncio.wait_for(provider.prompt("thread", "next"), 1)
            assert result.status == "completed"
        finally:
            runtime.approvals.cancel_all()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_cancellation_drains_the_real_sdk_notification_worker():
    async def scenario():
        low_level = AsyncCodexClient()
        reader_ready = asyncio.Event()
        reader_exited = Event()
        loop = asyncio.get_running_loop()
        original_register = low_level._sync.register_turn_notifications
        original_queue = None
        completion = SimpleNamespace(
            method="turn/completed",
            payload=TurnCompletedNotification.model_validate({
                "threadId": "thread",
                "turn": {
                    "id": "turn", "status": "interrupted", "items": [], "error": None,
                    "itemsView": "full",
                },
            }),
        )

        def register_notifications(turn_id):
            nonlocal original_queue
            original_register(turn_id)
            original_queue = low_level._sync._router._turn_notifications[turn_id]
            original_get = original_queue.get

            def get():
                loop.call_soon_threadsafe(reader_ready.set)
                try:
                    return original_get()
                finally:
                    reader_exited.set()

            original_queue.get = get

        low_level._sync.register_turn_notifications = register_notifications

        async def initialized():
            pass

        async def interrupt(*_args):
            low_level._sync._router.route_notification(completion)

        low_level.turn_interrupt = interrupt
        client = SimpleNamespace(_client=low_level, _ensure_initialized=initialized)
        turn = AsyncTurnHandle(client, "thread", "turn")

        async def start(*_args, **_kwargs):
            return turn

        provider = CodexProvider(None)
        runtime = _CodexRuntime(client, SimpleNamespace(id="thread", turn=start))
        provider._sessions["thread"] = runtime
        task = asyncio.create_task(provider.prompt("thread", "hello"))
        try:
            await asyncio.wait_for(reader_ready.wait(), 1)
            task.cancel()
            done, _ = await asyncio.wait({task}, timeout=1)
            assert task in done
            assert task.cancelled()
            assert reader_exited.is_set(), "SDK notification worker was orphaned"
            assert not runtime.lock.locked()
        finally:
            if original_queue is not None:
                original_queue.put(completion)
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_cancel_during_turn_start_interrupts_the_started_turn():
    async def scenario():
        started = asyncio.Event()
        release_start = asyncio.Event()
        interrupted = asyncio.Event()

        class Turn:
            id = "turn"

            async def stream(self):
                await interrupted.wait()
                yield SimpleNamespace(method="turn/completed", payload=SimpleNamespace(
                    model_dump=lambda **_: {"turn": {"id": "turn", "status": "interrupted"}},
                ))

            async def interrupt(self):
                interrupted.set()

        async def start(*_args, **_kwargs):
            started.set()
            await release_start.wait()
            return Turn()

        provider = CodexProvider(None)
        runtime = _CodexRuntime(SimpleNamespace(), SimpleNamespace(id="thread", turn=start))
        provider._sessions["thread"] = runtime
        task = asyncio.create_task(provider.prompt("thread", "hello"))
        await started.wait()
        task.cancel()
        release_start.set()
        done, _ = await asyncio.wait({task}, timeout=1)
        assert task in done
        assert task.cancelled()
        assert interrupted.is_set()
        assert not runtime.lock.locked()

    asyncio.run(scenario())
