import asyncio
import io
import sys

from cleo.desktop.server import ProtocolServer


def test_shutdown_cancels_waiting_runs_before_closing_the_service(monkeypatch):
    async def scenario():
        ready = asyncio.Event()
        lifecycle = []

        class Service:
            async def stream_turn(self, **_kwargs):
                lifecycle.append("started")
                ready.set()
                try:
                    await asyncio.Future()
                finally:
                    lifecycle.append("cancelled")

            async def shutdown(self):
                lifecycle.append("shutdown")

        server = ProtocolServer(Service())
        replies = []

        async def write(reply):
            replies.append(reply)

        monkeypatch.setattr(server, "_write", write)
        task = asyncio.create_task(server._handle({"id": "running", "method": "stream_turn"}))
        server._tasks.add(task)
        await ready.wait()
        monkeypatch.setattr(sys, "stdin", io.StringIO('{"id":"close","method":"shutdown"}\n'))
        try:
            await asyncio.wait_for(server.run(), 2)
            assert lifecycle == ["started", "cancelled", "shutdown"]
            assert any(reply["id"] == "close" for reply in replies)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
