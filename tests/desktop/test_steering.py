import asyncio
from unittest.mock import AsyncMock

import pytest

from cleo.desktop.steering import SteeringRun, new_receipt, persist_receipt, recover_steers
from cleo.desktop.timeline import TimelineIndex
from cleo.harnesses.context import project
from cleo.harnesses.control import SteerRejected
from cleo.sessions.store import SessionStore


def fixture(tmp_path, mode="native", deliver=None):
    store = SessionStore(tmp_path / "memory")
    manifest = store.create_session(
        session_id="thread", space="productivity", project="workspace",
        provider="codex", owner_type="user",
    )
    store.append_events(session_id="thread", space="productivity", project="workspace", events=[
        {"id": "original", "type": "user_message", "actor": "user", "content": "original goal"},
    ])
    run = SteeringRun(store, manifest, "run", mode, AsyncMock(), deliver)
    run.bind_turn("original")
    return store, manifest, run


def test_native_delivery_is_ordered_and_retries_are_idempotent(tmp_path):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def deliver(text, native_id):
            calls.append((text, native_id))
            entered.set()
            await release.wait()

        store, manifest, run = fixture(tmp_path, deliver=deliver)
        run.native_ready("native-turn")
        try:
            await run.submit("one", "first")
            await asyncio.wait_for(entered.wait(), 2)
            await run.submit("two", "second")
            await run.submit("one", "first")
            assert calls == [("first", "native-turn")]
            release.set()
            await asyncio.wait_for(asyncio.shield(run.worker), 2)
            replay = await run.submit("one", "first")
            assert replay["steer"]["status"] == "received"
            assert calls == [("first", "native-turn"), ("second", "native-turn")]
            with pytest.raises(ValueError, match="另一条指令"):
                await run.submit("one", "changed")
            index = TimelineIndex(store, manifest)
            messages = index.page()["items"]
            assert [m["content"] for m in messages] == ["original goal", "first", "second"]
            records = project(store.read_events("thread"))
            assert [r["text"] for r in records if r["type"] == "user_message"] == [
                "original goal", "first", "second",
            ]
        finally:
            release.set()
            await run.close()
    asyncio.run(scenario())


def test_boundary_batch_preserves_all_input_without_duplicate_bubbles(tmp_path):
    async def scenario():
        deliver = AsyncMock()
        store, manifest, run = fixture(tmp_path, "boundary", deliver)
        await run.submit("one", "first")
        await run.submit("two", "second")
        assert (await run.submit("one", "first"))["steer"]["status"] == "queued"
        assert await run.next_boundary() == ("first\n\nsecond", ["one", "two"])
        assert run.records["one"]["status"] == "sending"
        store.append_events(session_id="thread", space="productivity", project="workspace", events=[
            {"id": "followup", "type": "user_message", "actor": "user",
             "content": "first\n\nsecond",
             "data": {"steer_ids": ["one", "two"]}},
        ])
        run.bind_turn("followup")
        await run.boundary_received()
        assert await run.next_boundary() is None
        await run.close()
        deliver.assert_not_awaited()
        messages = TimelineIndex(store, manifest).page()["items"]
        assert [m["content"] for m in messages] == ["original goal", "first", "second"]
        assert messages[-1]["steer"]["turnId"] == "followup"
        assert all(m["steer"]["status"] == "received" for m in messages[1:])
    asyncio.run(scenario())


def test_cancel_queued_and_inflight_receipts_never_retargets_them(tmp_path):
    async def scenario():
        entered = asyncio.Event()

        async def deliver(*_):
            entered.set()
            await asyncio.Event().wait()

        store, manifest, run = fixture(tmp_path, deliver=deliver)
        run.native_ready("native")
        await run.submit("one", "in flight")
        await asyncio.wait_for(entered.wait(), 2)
        await run.submit("two", "still queued")
        await asyncio.wait_for(run.close(), 2)
        assert run.records["one"]["status"] == "uncertain"
        assert run.records["two"]["status"] == "cancelled"
        assert (await run.submit("one", "in flight", retry=True))["steer"]["status"] == "uncertain"
        new_run = SteeringRun(store, manifest, "other-run", "native", AsyncMock(), AsyncMock())
        new_run.bind_turn("new-turn")
        with pytest.raises(ValueError, match="另一条指令"):
            await new_run.submit("one", "in flight")
        await new_run.close()
    asyncio.run(scenario())


@pytest.mark.parametrize("known_rejection", [True, False])
def test_only_a_confirmed_rejection_can_be_retried(tmp_path, known_rejection):
    async def scenario():
        failure = SteerRejected("temporary rejection", retryable=True) if known_rejection else (
            ConnectionError("acknowledgement lost")
        )
        deliver = AsyncMock(side_effect=[failure, None])
        _, _, run = fixture(tmp_path, deliver=deliver)
        run.native_ready("native")
        await run.submit("one", "instruction")
        await asyncio.wait_for(asyncio.shield(run.worker), 2)
        await run.submit("one", "instruction")
        assert deliver.await_count == 1
        await run.submit("one", "instruction", retry=True)
        if known_rejection:
            await asyncio.wait_for(asyncio.shield(run.worker), 2)
            assert deliver.await_count == 2
            assert run.records["one"]["status"] == "received"
        else:
            assert deliver.await_count == 1
            assert run.records["one"]["status"] == "uncertain"
        await run.close()
    asyncio.run(scenario())


def test_recovery_does_not_resend_queued_or_uncertain_messages(tmp_path):
    async def scenario():
        store, manifest, _ = fixture(tmp_path)
        for identifier, state in (("queued", "queued"), ("sending", "sending")):
            receipt = new_receipt(manifest, identifier, "old-run", identifier, "native")
            await persist_receipt(store, manifest, receipt, status=state)
        await recover_steers(store, manifest)
        receipts = TimelineIndex(store, manifest).steers()
        assert [r["status"] for r in receipts] == ["cancelled", "uncertain"]
        count = len(store.read_events("thread"))
        await recover_steers(store, manifest)
        assert len(store.read_events("thread")) == count
    asyncio.run(scenario())


def test_retry_recovers_a_saved_receipt_after_manifest_write_failure(tmp_path, monkeypatch):
    async def scenario():
        deliver = AsyncMock()
        store, _, run = fixture(tmp_path, deliver=deliver)
        run.native_ready("native")
        append = store.append_events
        failed = False

        def fail_after_append(**kwargs):
            nonlocal failed
            result = append(**kwargs)
            if not failed and kwargs["events"][0]["type"] == "steer":
                failed = True
                raise OSError("manifest write failed after durable append")
            return result

        monkeypatch.setattr(store, "append_events", fail_after_append)
        with pytest.raises(OSError, match="manifest write"):
            await run.submit("one", "must survive")
        deliver.assert_not_awaited()
        await run.submit("one", "must survive")
        await asyncio.wait_for(asyncio.shield(run.worker), 2)
        assert run.records["one"]["status"] == "received"
        deliver.assert_awaited_once_with("must survive", "native")
        await run.close()
    asyncio.run(scenario())


def test_same_request_id_cannot_race_with_different_content(tmp_path):
    async def scenario():
        store, manifest, _ = fixture(tmp_path)
        attempts = await asyncio.gather(*(
            persist_receipt(store, manifest, new_receipt(manifest, "same", "run", text, "native"))
            for text in ("one", "two")
        ), return_exceptions=True)
        assert len([r for r in attempts if isinstance(r, ValueError)]) == 1
        saved = TimelineIndex(store, manifest).steer("same")
        assert next(r for r in attempts if isinstance(r, dict))["text"] == saved["text"]
    asyncio.run(scenario())


@pytest.mark.parametrize("finish_first", [True, False])
def test_message_at_end_boundary_is_received_or_explicitly_rejected(tmp_path, finish_first):
    async def scenario():
        _, _, run = fixture(tmp_path, mode="boundary")
        async def submit():
            return await run.submit("one", "late input")
        operations = [run.next_boundary, submit] if finish_first else [submit, run.next_boundary]
        results = await asyncio.gather(*(operation() for operation in operations))
        receipt = results[1 if finish_first else 0]["steer"]
        continuation = results[0 if finish_first else 1]
        if continuation is None:
            assert receipt["status"] == "failed"
        else:
            assert continuation == ("late input", ["one"])
        await run.close()
    asyncio.run(scenario())
