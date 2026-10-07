from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from cleo.desktop.runs import RunSupervisor


def test_start_claim_and_finish_track_one_run_per_thread() -> None:
    runs = RunSupervisor()
    generated = runs.start("a", None, None)
    assert len(generated) == 32 and runs.run_id("a") == generated
    assert not runs.is_running("a")  # No task registered outside an event loop task.
    assert runs.start("b", SimpleNamespace(done=lambda: False), "run-b") == "run-b"
    assert runs.is_running("b") and runs.any_running() and runs.running_threads() == ["b"]
    assert runs.unfinished("b") is not None

    assert runs.claim_workspace("a", "/repo") == []
    assert runs.claim_workspace("b", "/repo") == ["a"]
    assert runs.workspace_in_use("/repo") and not runs.workspace_in_use("/other")
    runs.add_approval("b", {"id": "ap", "tool": "shell"})
    assert runs.pending_approvals("b") == [{"id": "ap", "tool": "shell"}]
    runs.drop_approval("b", "ap")
    runs.drop_approval("missing", "ap")
    assert runs.pending_approvals("b") == []

    runs.add_approval("b", {"id": "left"})
    runs.finish("b")
    assert not runs.is_running("b") and runs.run_id("b") is None
    assert runs.pending_approvals("b") == [] and runs.claim_workspace("c", "/repo") == ["a"]


def test_cancel_targets_only_the_named_run_and_waits_for_cleanup() -> None:
    async def scenario():
        runs = RunSupervisor()
        cleaned = asyncio.Event()

        async def run():
            try:
                await asyncio.Future()
            finally:
                cleaned.set()

        task = asyncio.create_task(run())
        await asyncio.sleep(0)
        runs.start("t", task, "run-1")
        stopped = []
        runs.attach_steering("t", SimpleNamespace(stop_accepting=lambda: stopped.append(True)))

        assert await runs.cancel("t", "other") == {"cancelled": False}
        assert not task.cancelled()
        assert await runs.cancel("t", "run-1") == {"cancelled": True}
        assert cleaned.is_set() and task.cancelled() and stopped == [True]
        assert await runs.cancel("idle") == {"cancelled": False}

    asyncio.run(scenario())


def test_cancel_reraises_what_the_run_raised_while_stopping() -> None:
    async def scenario():
        runs = RunSupervisor()

        async def run():
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                raise RuntimeError("cleanup failed") from None

        task = asyncio.create_task(run())
        await asyncio.sleep(0)
        runs.start("t", task, None)
        with pytest.raises(RuntimeError, match="cleanup failed"):
            await runs.cancel("t")

    asyncio.run(scenario())


def test_harness_switch_is_exclusive_and_always_released() -> None:
    runs = RunSupervisor()
    with pytest.raises(KeyError), runs.harness_switch("t"):
        assert runs.is_switching("t")
        with pytest.raises(ValueError, match="正在切换"), runs.harness_switch("t"):
            pass
        raise KeyError("boom")
    assert not runs.is_switching("t")


def test_steers_reach_only_a_live_run_that_is_not_switching() -> None:
    runs = RunSupervisor()
    task = SimpleNamespace(cancelling=lambda: 0, done=lambda: False)
    steering = SimpleNamespace(run_id="run-1", closed=False, ready=asyncio.Event())
    runs.start("t", task, "run-1")
    runs.attach_steering("t", steering)

    assert runs.accepts_steer("t", "run-1", steering)
    assert not runs.accepts_steer("t", "run-2", steering)
    assert not runs.accepts_steer("t", "run-1", None)
    assert not runs.steer_ready("t")
    steering.ready.set()
    assert runs.steer_ready("t")
    with runs.harness_switch("t"):
        assert not runs.accepts_steer("t", "run-1", steering)
    runs.detach_steering("t")
    assert runs.steering_for("t") is None and not runs.steer_ready("t")
