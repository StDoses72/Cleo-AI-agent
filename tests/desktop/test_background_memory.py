from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.config.settings import ActiveProfiles
from cleo.desktop.background_memory import BackgroundMemory
from cleo.desktop.configuration import (
    read_background_memory_settings,
    save_background_memory_settings,
)
from cleo.desktop.service import DesktopService
from cleo.memory.paths import memory_state_path
from cleo.memory.state import get_session_source, mark_consolidation_started, touch_session_source
from cleo.sessions.store import SessionStore


def source(name="one", digest="first"):
    return {"space": "non_productivity", "project": "general", "session_id": name,
            "source_hash": digest, "status": "pending"}


def controller(*, sources=None, review=None, enabled=True, threshold=5):
    settings = {"enabled": enabled, "dreamEnabled": True,
                "intervalMinutes": 30, "pendingThreshold": threshold}
    entries = sources if sources is not None else [source()]
    now, busy = [0.0], [False]
    runner = BackgroundMemory(settings=lambda: settings, sources=lambda: entries,
                              review=review or AsyncMock(), busy=lambda: busy[0],
                              clock=lambda: now[0])
    return runner, settings, entries, now, busy


def test_settings_default_off_and_persist_validated_schedule(tmp_path):
    path = tmp_path / "cleo.json"
    path.write_text(json.dumps({"active_profiles": {"agent": "chat"}}), encoding="utf-8")
    assert read_background_memory_settings(path) == {
        "enabled": False, "dreamEnabled": True, "intervalMinutes": 30, "pendingThreshold": 5,
    }
    saved = save_background_memory_settings(path, True, 12, 3)
    assert saved["enabled"] and saved["intervalMinutes"] == 12 and saved["pendingThreshold"] == 3
    active = ActiveProfiles.model_validate(json.loads(path.read_text())["active_profiles"])
    assert active.background_memory_enabled
    assert active.background_memory_interval_minutes == 12
    before = path.read_bytes()
    for interval, threshold in [(0, 1), (1441, 1), (True, 1), (1, 0), (1, 1001), (1, 1.5)]:
        with pytest.raises(ValueError):
            save_background_memory_settings(path, True, interval, threshold)
        assert path.read_bytes() == before
    with pytest.raises(ValueError):
        save_background_memory_settings(path, "true")
    assert save_background_memory_settings(path, False)["intervalMinutes"] == 12


def test_disabled_state_does_not_scan_sources():
    runner, _, _, _, _ = controller(enabled=False)
    runner._sources = lambda: pytest.fail("disabled background work must not scan sources")
    runner.start_if_due()
    assert runner.state()["pendingCount"] == 0


def test_disk_settings_are_validated_before_scheduling(tmp_path):
    path = tmp_path / "cleo.json"
    raw = {"active_profiles": {"agent": "chat", "background_memory_enabled": "false"}}
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert read_background_memory_settings(path)["enabled"] is False
    raw["active_profiles"]["background_memory_interval_minutes"] = 0
    path.write_text(json.dumps(raw), encoding="utf-8")
    with pytest.raises(ValueError):
        read_background_memory_settings(path)


def test_interval_and_backlog_trigger_once_per_source_hash():
    async def check():
        review = AsyncMock()
        runner, _, entries, now, _ = controller(review=review)
        runner.start_if_due()
        assert not runner.state()["running"]
        now[0] = 1800
        runner.start_if_due()
        runner.start_if_due()
        await runner._task
        review.assert_awaited_once_with(entries[0])
        now[0] += 1800
        runner.start_if_due()
        assert not runner.state()["running"]
        entries[0] = source(digest="changed")
        runner.start_if_due()
        await runner._task
        assert review.await_count == 2
        batch, _, _, _, _ = controller(
            sources=[source(str(index)) for index in range(5)], review=review,
        )
        batch.start_if_due()
        await batch._task
        assert review.await_count == 7
    asyncio.run(check())


def test_batch_is_serial_snapshot_and_failure_does_not_block_other_sources():
    async def check():
        entered, release = asyncio.Event(), asyncio.Event()
        seen = []
        entries = [source("first"), source("second")]

        async def review(item):
            seen.append(item["session_id"])
            if item["session_id"] == "first":
                entered.set()
                await release.wait()
                raise RuntimeError("provider offline")

        runner, _, _, _, _ = controller(sources=entries, review=review, threshold=1)
        runner.start_if_due()
        await entered.wait()
        entries.append(source("next batch"))
        runner.start_if_due()
        assert seen == ["first"]
        release.set()
        await runner._task
        assert seen == ["first", "second"]
        assert runner.state()["status"] == "failed"
        assert runner.state()["lastError"] == "provider offline"
        runner.start_if_due()
        await runner._task
        assert seen == ["first", "second", "next batch"]
    asyncio.run(check())


def test_recovered_snapshot_can_process_remaining_events_with_same_queued_hash():
    async def check():
        review = AsyncMock(side_effect=[{"status": "pending"}, {"status": "complete"}])
        runner, _, _, _, _ = controller(review=review, threshold=1)
        runner.start_if_due()
        await runner._task
        runner.start_if_due()
        await runner._task
        assert review.await_count == 2
    asyncio.run(check())


def test_foreground_and_dream_disabled_block_batches_and_cancel_can_resume():
    async def check():
        entered = asyncio.Event()
        cleaned = asyncio.Event()

        async def review(_source):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        runner, settings, _, _, busy = controller(review=review, threshold=1)
        settings["dreamEnabled"] = False
        runner.start_if_due()
        assert not runner.state()["running"]
        settings["dreamEnabled"], busy[0] = True, True
        runner.start_if_due()
        assert not runner.state()["running"]
        busy[0] = False
        runner.start_if_due()
        await entered.wait()
        await runner.cancel()
        assert cleaned.is_set() and runner.state()["status"] == "cancelled"
        review_again = AsyncMock()
        runner._review = review_again
        runner.start_if_due()
        await runner._task
        review_again.assert_awaited_once()
        await runner.cancel(close=True)
        runner._attempted.clear()
        runner.start_if_due()
        assert not runner.state()["running"]
    asyncio.run(check())


def test_cancelled_waiter_does_not_cancel_background_publication_twice():
    async def check():
        entered, cleanup_started, release, cleaned = (asyncio.Event() for _ in range(4))

        async def review(_source):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleanup_started.set()
                await release.wait()
                cleaned.set()
                raise

        runner, _, _, _, _ = controller(review=review, threshold=1)
        runner.start_if_due()
        await entered.wait()
        waiter = asyncio.create_task(runner.cancel())
        await cleanup_started.wait()
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert runner._task.cancelling() == 1
        assert runner.state()["running"] and not cleaned.is_set()
        release.set()
        await asyncio.gather(runner._task, return_exceptions=True)
        assert cleaned.is_set()
    asyncio.run(check())


def test_interrupted_timer_batch_resumes_without_waiting_another_interval():
    async def check():
        entered = asyncio.Event()

        async def review(_source):
            entered.set()
            await asyncio.Event().wait()

        runner, _, _, now, _ = controller(review=review)
        now[0] = 1800
        runner.start_if_due()
        await entered.wait()
        await runner.cancel()
        now[0] += 1
        runner._review = AsyncMock()
        runner.start_if_due()
        await runner._task
        runner._review.assert_awaited_once()
    asyncio.run(check())


def make_service(tmp_path, factory):
    path = tmp_path / "cleo.json"
    path.write_text(json.dumps({"active_profiles": {"agent": "chat"}}), encoding="utf-8")
    save_background_memory_settings(path, True, 30, 1)
    settings = SimpleNamespace(MEMORY_DIR=tmp_path / "memory",
                               SESSION_INDEX_PATH=tmp_path / "sessions.sqlite3", PROFILE_DIR=path)
    store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    store.create_session(session_id="one", space="non_productivity", project="general",
                         provider="cleo", owner_type="user")
    state_path = memory_state_path(settings.MEMORY_DIR, "non_productivity")
    touch_session_source(space="non_productivity", project="general", session_id="one",
                         source_hash="hash", last_event_seq=1, path=state_path)
    service = DesktopService(settings_model=settings, store=store,
                             runtime=SimpleNamespace(is_project_removed=lambda *_: False),
                             dream_agent_factory=factory)
    return service, state_path


def test_service_uses_non_forced_dream_and_preserves_failure_for_manual_review(tmp_path):
    async def check():
        invoke = AsyncMock(side_effect=RuntimeError("no model configured"))
        service, path = make_service(tmp_path, lambda: SimpleNamespace(invoke=invoke))
        assert (await service.run_background_memory_review())["running"]
        await service._background_memory._task
        invoke.assert_awaited_once_with(space="non_productivity", project="general",
                                       session_id="one", force=False)
        assert get_session_source("non_productivity", "general", "one", path=path)[
            "status"] == "failed"
        assert (await service.run_background_memory_review())["lastError"] == "no model configured"
        assert invoke.await_count == 1
    asyncio.run(check())


def test_service_disable_waits_for_cancel_and_leaves_source_pending(tmp_path):
    async def check():
        entered, cleaned = asyncio.Event(), asyncio.Event()

        async def invoke(**_kwargs):
            mark_consolidation_started("non_productivity", "general", "one", "hash", path=path)
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        service, path = make_service(tmp_path, lambda: SimpleNamespace(invoke=invoke))
        await service.run_background_memory_review()
        await entered.wait()
        result = await service.save_background_memory_settings(enabled=False)
        assert cleaned.is_set() and not result["enabled"] and not result["running"]
        assert get_session_source("non_productivity", "general", "one", path=path)[
            "status"] == "pending"
    asyncio.run(check())


def test_old_background_failure_does_not_fail_a_new_source_revision(tmp_path):
    async def check():
        async def invoke(**_kwargs):
            touch_session_source(space="non_productivity", project="general", session_id="one",
                                 source_hash="new revision", last_event_seq=2, path=path)
            raise RuntimeError("old source request failed")

        service, path = make_service(tmp_path, lambda: SimpleNamespace(invoke=invoke))
        await service.run_background_memory_review()
        await service._background_memory._task
        latest = get_session_source("non_productivity", "general", "one", path=path)
        assert latest["source_hash"] == "new revision" and latest["status"] == "pending"
    asyncio.run(check())


def test_pending_count_excludes_child_removed_and_missing_sessions(tmp_path):
    service, path = make_service(tmp_path, lambda: SimpleNamespace(invoke=AsyncMock()))
    for name, owner in [("child", "agent"), ("removed", "user")]:
        service.store.create_session(session_id=name, space="non_productivity", project=name,
                                     provider="cleo", owner_type=owner)
    for name in ("child", "removed", "missing"):
        touch_session_source(space="non_productivity", project=name, session_id=name,
                             source_hash="hash", last_event_seq=1, path=path)
    service.runtime.is_project_removed = lambda _space, project: project == "removed"
    assert asyncio.run(service.get_background_memory_state())["pendingCount"] == 1


def test_scheduler_uses_last_valid_config_snapshot(tmp_path):
    service, _ = make_service(tmp_path, lambda: SimpleNamespace(invoke=AsyncMock()))
    service._config = SimpleNamespace(snapshot=SimpleNamespace(settings=SimpleNamespace(
        active_profiles=ActiveProfiles(agent="chat"),
    )))
    service.settings.PROFILE_DIR.write_text("invalid JSON", encoding="utf-8")
    assert asyncio.run(service.get_background_memory_state())["enabled"] is False


def test_hot_reload_disabling_background_cancels_current_source(tmp_path):
    async def check():
        entered = asyncio.Event()

        async def invoke(**_kwargs):
            mark_consolidation_started("non_productivity", "general", "one", "hash", path=path)
            entered.set()
            await asyncio.Event().wait()

        service, path = make_service(tmp_path, lambda: SimpleNamespace(invoke=invoke))
        await service.run_background_memory_review()
        await entered.wait()
        service._settings_changed(
            None, SimpleNamespace(active_profiles=ActiveProfiles(agent="chat")),
        )
        await asyncio.gather(service._background_memory._task, return_exceptions=True)
        assert not (await service.get_background_memory_state())["running"]
        assert get_session_source("non_productivity", "general", "one", path=path)[
            "status"] == "pending"
    asyncio.run(check())


@pytest.mark.parametrize("method,params", [
    ("delete_thread", {"thread_id": "one"}),
    ("remove_project", {"project_id_value": "chat:general"}),
    ("reset_workspace", {}),
    ("review_memory_source", {"space": "non_productivity", "project": "general",
                              "session_id": "one", "action": "consolidate"}),
])
def test_memory_mutations_wait_for_publication_and_block_scheduler(tmp_path, method, params):
    async def check():
        entered, cleanup, published, mutation, done = (asyncio.Event() for _ in range(5))

        async def invoke(**_kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleanup.set()
                await published.wait()
                raise

        async def mutate(**_kwargs):
            mutation.set()
            await done.wait()
            return {"completed": True}

        service, _ = make_service(tmp_path, lambda: SimpleNamespace(invoke=invoke))
        setattr(service, f"_{method}", mutate)
        await service.run_background_memory_review()
        await entered.wait()
        operation = asyncio.create_task(getattr(service, method)(**params))
        await cleanup.wait()
        assert not mutation.is_set()
        published.set()
        await mutation.wait()
        assert not (await service.run_background_memory_review())["running"]
        assert service._memory_operations == 1
        done.set()
        assert await operation == {"completed": True}
        assert service._memory_operations == 0
    asyncio.run(check())
