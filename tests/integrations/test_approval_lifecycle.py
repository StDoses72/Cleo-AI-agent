import asyncio

import pytest

from cleo.integrations.harnesses.codex_approvals import CodexApprovalBroker


@pytest.mark.parametrize("concurrent_action", ["resolve", "cancel"])
def test_codex_first_decision_cannot_be_overwritten_while_recording(concurrent_action):
    async def scenario():
        broker = CodexApprovalBroker()
        request_ready = asyncio.Event()
        recording = asyncio.Event()
        release_recording = asyncio.Event()
        events = []

        async def emit(event):
            events.append(event)
            if event.type == "permission_request":
                request_ready.set()
            else:
                recording.set()
                await release_recording.wait()

        broker.bind(asyncio.get_running_loop(), emit)
        wire = asyncio.create_task(asyncio.to_thread(
            broker.handle, "item/commandExecution/requestApproval", {"command": "test-command"},
        ))
        first = second = None
        try:
            await asyncio.wait_for(request_ready.wait(), 1)
            identifier = events[0].data["payload"]["id"]
            first = asyncio.create_task(broker.resolve(identifier, "accept"))
            await asyncio.wait_for(recording.wait(), 1)
            if concurrent_action == "resolve":
                second = asyncio.create_task(broker.resolve(identifier, "decline"))
                await asyncio.sleep(0)
            else:
                broker.cancel_all()
            release_recording.set()
            await first
            if second:
                with pytest.raises(ValueError, match="no longer pending"):
                    await second
            assert await asyncio.wait_for(wire, 1) == {"decision": "accept"}
            assert [e.type for e in events] == ["permission_request", "permission_response"]
        finally:
            release_recording.set()
            broker.cancel_all()
            await asyncio.gather(*(t for t in [wire, first, second] if t), return_exceptions=True)

    asyncio.run(scenario())


def test_codex_fixed_decision_survives_request_callback_failure():
    async def scenario():
        broker = CodexApprovalBroker()

        async def emit(event):
            if event.type == "permission_request":
                await broker.resolve(event.data["payload"]["id"], "accept")
                raise ConnectionError("UI disconnected after deciding")

        broker.bind(asyncio.get_running_loop(), emit)
        result = await asyncio.wait_for(asyncio.to_thread(
            broker.handle, "item/fileChange/requestApproval", {},
        ), 1)
        assert result == {"decision": "accept"}
    asyncio.run(scenario())
