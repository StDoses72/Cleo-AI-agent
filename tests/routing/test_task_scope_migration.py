"""Old unconfirmed boundary markers must never make lifetime usage the current task."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from cleo.config.settings import AgentProfile
from cleo.routing.catalog import atomic_json
from cleo.routing.evaluator import AssessmentReply
from cleo.routing.models import RoutingSettings
from cleo.runtime.task_scopes import normalize_boundaries
from cleo.runtime.task_tracking import LEGACY_TASK, begin_task_turn
from cleo.runtime.task_usage import task_usage
from cleo.sessions.store import SessionStore


def legacy_store(tmp_path, *, historical_worker=False):
    """Purpose: Reproduce the shipped failure offline. Input: temp root. Output: session store."""
    store = SessionStore(tmp_path / "memory")
    store.create_session(session_id="root", space="non_productivity", project="general",
                         provider="codex", owner_type="user")
    store.update_manifest("root", usage_task_id=LEGACY_TASK,
                          runtime_options={"model": "gpt-6-sol"})
    if historical_worker:
        store.create_session(session_id="old-worker", space="productivity", project="general",
                             provider="claude", owner_type="agent", parent_session_id="root")
        store.update_manifest("old-worker", usage_task_id=LEGACY_TASK)
    store.append_events(session_id="root", space="non_productivity", project="general", events=[
        {"type": "user_message", "actor": "user", "content": "old unrelated work"},
        {"type": "provider_event", "actor": "codex", "data": {"payload": {
            "tokenUsage": {"total": {"totalTokens": 9000000, "inputTokens": 8990000,
                                     "outputTokens": 10000}}}}},
        {"type": "task_boundary", "actor": "system", "data": {
            "task_id": LEGACY_TASK, "number": 0, "decision": "uncertain", "status": "unknown",
            "model": "gpt-6-sol", "provider": "codex", "evaluation": {"called": False,
                "reason": "evaluation_unavailable"}}},
        {"type": "user_message", "actor": "user", "content": "check routing connectivity"},
        {"type": "provider_event", "actor": "codex", "data": {"payload": {
            "tokenUsage": {"total": {"totalTokens": 9000012, "inputTokens": 8990010,
                                     "outputTokens": 10002}}}}},
    ])
    return store


def test_existing_unconfirmed_marker_separates_current_usage_from_legacy_history(tmp_path):
    store = legacy_store(tmp_path)
    before = store.read_events("root")
    usage = task_usage(store, "root")
    assert usage["scope"] == "task"
    assert usage["total"] == 12
    assert usage["taskId"] != LEGACY_TASK
    assert usage["history"][0]["total"] == 9000000
    assert usage["history"][0]["scope"] == "session_history"
    assert usage["abstract"] == "check routing connectivity"
    assert usage["coverage"] == "since_tracking"
    assert store.read_events("root") == before
    assert task_usage(SessionStore(store.memory_root), "root") == usage


def test_multimodal_user_text_can_name_the_tracked_task_without_storing_image_data():
    events, _ = normalize_boundaries("root", [
        {"id": "marker", "type": "task_boundary", "data": {"task_id": LEGACY_TASK}},
        {"type": "user_message", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,fake"}},
            {"type": "text", "text": "check routing connectivity"},
        ]},
    ])
    assert events[0]["data"]["abstract"] == "check routing connectivity"
    assert "base64" not in str(events[0])


def test_classifier_failure_continues_tracked_scope_and_new_goal_resets_it(tmp_path):
    async def scenario():
        store = legacy_store(tmp_path)
        settings = SimpleNamespace(active_agent_profile=AgentProfile(
            provider="offline", model="fixture", api_key="fake-only"))
        policy = RoutingSettings(task_tracking_enabled=True)
        original = task_usage(store, "root")["taskId"]
        failed = AsyncMock(side_effect=RuntimeError("fake unavailable"))
        await begin_task_turn(store, settings, store.load_manifest("root"), "fix the check",
                               policy, complete=failed)
        payload = json.loads(failed.call_args.args[2])
        assert payload["recent_user_messages"] == ["check routing connectivity"]
        assert "old unrelated work" not in payload["recent_user_messages"]
        assert store.load_manifest("root")["usage_task_id"] == original
        store.append_events(session_id="root", space="non_productivity", project="general",
                            events=[{"type": "user_message", "actor": "user", "content": "fix"},
            {"type": "provider_event", "actor": "codex", "data": {"payload": {
                "tokenUsage": {"total": {"totalTokens": 9000015, "inputTokens": 8990012,
                                         "outputTokens": 10003}}}}}])
        current = task_usage(store, "root")
        assert current["taskId"] == original and current["total"] == 15
        assert current["history"][0]["total"] == 9000000
        new = AsyncMock(return_value=AssessmentReply('{"decision":"new","abstract":"New goal"}',
                          {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}))
        result = await begin_task_turn(store, settings, store.load_manifest("root"), "new goal",
                                       policy, complete=new)
        assert result["task_id"] != original and result["number"] == 2
        assert result["coverage"] == "full_task"
        current = task_usage(store, "root")
        assert current["total"] == 4
        earlier = next(task for task in current["history"] if task["taskId"] == original)
        assert earlier["total"] == 15

    asyncio.run(scenario())


def test_migration_keeps_late_workers_and_evaluators_in_their_original_intervals(tmp_path):
    store = legacy_store(tmp_path, historical_worker=True)
    original = task_usage(store, "root")["taskId"]
    store.create_session(session_id="worker", space="productivity", project="general",
                         provider="claude", owner_type="agent", parent_session_id="root")
    store.update_manifest("worker", usage_task_id=LEGACY_TASK)
    started = store.load_manifest("worker")["created_at"]
    store.append_events(session_id="root", space="non_productivity", project="general", events=[
        {"type": "task_boundary", "actor": "system", "data": {"task_id": "work_next",
            "number": 1, "decision": "new", "status": "confirmed", "model": "gpt-6-sol"}},
        {"type": "user_message", "actor": "user", "content": "unrelated goal"},
        {"type": "provider_event", "actor": "codex", "data": {"payload": {"tokenUsage": {
            "total": {"totalTokens": 9000032, "inputTokens": 8990025, "outputTokens": 10007}}}}},
    ])
    store.create_session(session_id="upgrade", space="productivity", project="general",
                         provider="claude", owner_type="agent", parent_session_id="root")
    store.update_manifest("upgrade", usage_task_id=LEGACY_TASK, routing_task_id="task_late")
    for name, tokens in (("old-worker", 8), ("worker", 10), ("upgrade", 6)):
        store.append_events(session_id=name, space="productivity", project="general", events=[
            {"type": "usage", "actor": "claude", "data": {"usage": {
                "input_tokens": tokens - 2, "output_tokens": 2}}}])
    atomic_json(store.memory_root / ".routing/tasks/task_late.json", {
        "parent_session_id": "root", "usage_task_id": LEGACY_TASK, "created_at": started,
        "evaluator": {"called": True, "model": "fixture", "status": "completed",
                      "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}}})
    usage = task_usage(store, "root")
    assert usage["total"] == 20 and usage["taskNumber"] == 2
    previous = {task["taskId"]: task for task in usage["history"]}
    assert previous[original]["total"] == 33
    assert previous[LEGACY_TASK]["total"] == 9000008
