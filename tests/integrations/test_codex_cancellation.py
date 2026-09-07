import asyncio
from types import SimpleNamespace

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
