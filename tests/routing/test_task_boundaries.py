"""Task-boundary classification and actual accounting with offline evaluator fixtures."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cleo.config.settings import AgentProfile
from cleo.routing.catalog import atomic_json
from cleo.routing.evaluator import AssessmentReply
from cleo.routing.models import RoutingSettings
from cleo.runtime.task_tracking import LEGACY_TASK, begin_task_turn
from cleo.runtime.task_usage import task_usage
from cleo.sessions.store import SessionStore


def test_boundary_json_accepts_windows_fences_without_relaxing_schema():
    from cleo.runtime.task_tracking import _parse_decision

    assert _parse_decision('\ufeff```json\r\n{"decision":"continue"}\r\n```').decision == "continue"
    with pytest.raises(ValueError):
        _parse_decision('Explanation: {"decision":"new"}')


def test_task_reference_usd_is_aggregated_from_current_model_usage(ledger):
    store, _, _ = ledger
    atomic_json(store.memory_root / ".routing/catalog.json", {"candidates": [{
        "id": "main", "connection": "codex", "provider": "codex", "backend": "codex",
        "model": "main-one", "policy": {"input_usd_per_million": 2,
                                             "output_usd_per_million": 10}}]})
    asyncio.run(boundary(ledger))
    append(store, "user_message", content="first goal")
    native(store, 120, 100, 20)
    usage = task_usage(store, "root")
    assert usage["referenceUsd"] == pytest.approx(0.0004)
    assert usage["models"][0]["referenceUsd"] == usage["referenceUsd"]


@pytest.fixture
def ledger(tmp_path):
    store = SessionStore(tmp_path / "memory")
    store.create_session(session_id="root", space="non_productivity", project="general",
                         provider="cleo", owner_type="user")
    store.update_manifest("root", runtime_options={"model": "main-one"})
    settings = SimpleNamespace(active_agent_profile=AgentProfile(
        provider="offline", model="fixture-evaluator", api_key="offline-fixture"))
    return store, settings, RoutingSettings(task_tracking_enabled=True)


def append(store, kind, data=None, **kwargs):
    """Purpose: Persist one production-format event. Output: append-only event."""
    return store.append_event(session_id="root", space="non_productivity", project="general",
                              event_type=kind, actor="system", data=data, **kwargs)


def native(store, total, incoming, outgoing):
    """Purpose: Emit a native thread cumulative counter. Output: event."""
    return append(store, "provider_event", {"payload": {"threadId": "native",
                  "tokenUsage": {"total": {"totalTokens": total, "inputTokens": incoming,
                                           "outputTokens": outgoing}}}})


async def boundary(ledger, decision="continue", **kwargs):
    """Purpose: Drive the real classifier seam with a free fixture. Output: persisted boundary."""
    store, settings, policy = ledger
    complete = AsyncMock(return_value=AssessmentReply(json.dumps({"decision": decision}), {
        "input_tokens": 3, "output_tokens": 1, "total_tokens": 4}))
    result = await begin_task_turn(store, settings, store.load_manifest("root"),
                                   "new user message", policy, complete=complete, **kwargs)
    return result, complete


def test_new_task_resets_native_delta_continuations_accumulate_and_history_survives(ledger):
    async def scenario():
        store, _, _ = ledger
        first, complete = await boundary(ledger)
        complete.assert_not_awaited()
        append(store, "user_message", content="first goal")
        native(store, 120, 100, 20)
        followup, _ = await boundary(ledger, "continue")
        assert first["task_id"] == followup["task_id"]
        append(store, "user_message", content="correct the first goal")
        native(store, 150, 125, 25)
        assert task_usage(store, "root")["total"] == 154
        second, _ = await boundary(ledger, "new")
        assert second["task_id"] != first["task_id"] and second["number"] == 2
        append(store, "user_message", content="different goal")
        native(store, 180, 150, 30)
        native(store, 180, 150, 30)
        usage = task_usage(store, "root")
        assert usage["total"] == 34 and usage["input"] == 28 and usage["output"] == 6
        assert usage["history"][0]["total"] == 154
        assert usage["reportedCalls"] == 2 and usage["missingCalls"] == 0
        assert {item["model"]: item["total"] for item in usage["models"]} == {
            "main-one": 30, "fixture-evaluator": 4}
        restarted = SessionStore(store.memory_root)
        assert task_usage(restarted, "root") == usage

    asyncio.run(scenario())


def test_topic_switch_receives_previous_request_and_records_abstract_and_actual_parts(ledger):
    async def scenario():
        store, settings, policy = ledger
        first = await begin_task_turn(store, settings, store.load_manifest("root"),
                                      "独立浏览器和鼠标键盘控制", policy)
        assert first["abstract"] == "独立浏览器和鼠标键盘控制"
        assert first["abstract_source"] == "request_excerpt"
        append(store, "user_message", content="独立浏览器和鼠标键盘控制")
        native(store, 100, 80, 20)
        complete = AsyncMock(return_value=AssessmentReply(
            '```json\n{"decision":"new","abstract":"检查子任务路由连通性"}\n```',
            {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}))
        second = await begin_task_turn(store, settings, store.load_manifest("root"),
                                       "检查这个子任务路由模式能否成功打通", policy,
                                       complete=complete)
        payload = json.loads(complete.call_args.args[2])
        assert payload["previous_user_message"] == "独立浏览器和鼠标键盘控制"
        assert payload["current_task_abstract"] == first["abstract"]
        assert second["number"] == 2 and second["status"] == "confirmed"
        append(store, "user_message", content="检查子任务路由")
        native(store, 120, 95, 25)
        store.create_session(session_id="worker", space="productivity", project="general",
                             provider="claude", owner_type="agent")
        store.update_manifest("worker", parent_session_id="root", usage_task_id=second["task_id"],
                              routing_task_id="task_test", runtime_options={"model": "haiku"})
        atomic_json(store.memory_root / ".routing/tasks/task_test.json", {
            "task_id": "task_test", "parent_session_id": "root", "assessment": {
                "task_type": "analysis", "part": "路由连通性测试"}})
        store.append_events(session_id="worker", space="productivity", project="general", events=[
            {"type": "usage", "actor": "claude",
             "data": {"usage": {"input_tokens": 6, "output_tokens": 2}}}])
        result = task_usage(store, "root")
        assert result["abstract"] == "检查子任务路由连通性"
        assert result["total"] == 32
        models = {item["model"]: item for item in result["models"]}
        assert models["haiku"]["parts"][0]["part"] == "路由连通性测试"
        assert models["haiku"]["total"] == 8
        assert models["fixture-evaluator"]["parts"][0]["part"] == "任务边界判断"
        assert result["history"][0]["total"] == 100

    asyncio.run(scenario())


def test_timeout_is_explained_without_retrying_or_losing_current_task(ledger):
    async def scenario():
        store, settings, policy = ledger
        first, _ = await boundary(ledger)
        complete = AsyncMock(side_effect=TimeoutError)
        result = await begin_task_turn(store, settings, store.load_manifest("root"), "next",
                                       policy, complete=complete)
        complete.assert_awaited_once()
        assert result["task_id"] == first["task_id"]
        assert result["evaluation"]["reason"] == "timeout"
        assert task_usage(store, "root")["boundaryReason"] == "timeout"

    asyncio.run(scenario())


@pytest.mark.parametrize("reply", [
    '{"decision":"uncertain"}', '{"decision":"new","task_id":"evil"}',
    "not JSON", RuntimeError("secret fixture-error"),
])
def test_invalid_or_uncertain_evaluator_preserves_task_and_reports_its_usage(ledger, reply):
    async def scenario():
        store, settings, policy = ledger
        first, _ = await boundary(ledger)
        append(store, "user_message", content="goal")
        complete = AsyncMock(side_effect=reply) if isinstance(reply, Exception) else AsyncMock(
            return_value=AssessmentReply(reply, {"total_tokens": 4}))
        result = await begin_task_turn(store, settings, store.load_manifest("root"), "followup",
                                       policy, complete=complete)
        assert result["task_id"] == first["task_id"] and result["status"] == "unknown"
        assert "secret" not in json.dumps(result)
        assert task_usage(store, "root")["missingCalls"] >= 1

    asyncio.run(scenario())


def test_cancelled_classifier_is_not_retried_and_preserves_possible_cost(ledger):
    async def scenario():
        store, settings, policy = ledger
        first, _ = await boundary(ledger)
        append(store, "user_message", content="goal")
        complete = AsyncMock(side_effect=asyncio.CancelledError)
        with pytest.raises(asyncio.CancelledError):
            await begin_task_turn(store, settings, store.load_manifest("root"), "next", policy,
                                  complete=complete)
        complete.assert_awaited_once()
        usage = task_usage(store, "root")
        assert usage["taskId"] == first["task_id"] and usage["boundaryStatus"] == "cancelled"
        assert any(item["role"] == "evaluator" and item["missingCalls"] == 1
                   for item in usage["breakdown"])

    asyncio.run(scenario())


def test_disabled_tracking_and_budget_do_not_make_evaluator_calls(ledger):
    async def scenario():
        store, settings, policy = ledger
        policy.task_tracking_enabled = False
        complete = AsyncMock(side_effect=AssertionError("No calls allowed"))
        assert await begin_task_turn(store, settings, store.load_manifest("root"), "one", policy,
                                     complete=complete) is None
        assert not any(event["type"] == "task_boundary" for event in store.read_events("root"))
        policy.task_tracking_enabled = True
        await boundary(ledger)
        append(store, "user_message", content="goal")
        policy.max_soft_budget_usd = 1
        result = await begin_task_turn(store, settings, store.load_manifest("root"), "next", policy,
                                       complete=complete)
        assert result["status"] == "unknown" and result["evaluation"]["called"] is False
        complete.assert_not_awaited()

    asyncio.run(scenario())


def test_late_child_and_evaluator_results_remain_with_original_task(ledger):
    async def scenario():
        store, _, _ = ledger
        first, _ = await boundary(ledger)
        append(store, "user_message", content="goal")
        store.create_session(session_id="worker", space="productivity", project="general",
                             provider="claude", owner_type="agent")
        store.update_manifest("worker", parent_session_id="root", usage_task_id=first["task_id"],
                              runtime_options={"model": "sonnet"})
        await boundary(ledger, "new")
        store.append_events(session_id="worker", space="productivity", project="general", events=[
            {"type": "user_message", "actor": "user", "content": "child"},
            {"type": "usage", "actor": "claude",
             "data": {"usage": {"input_tokens": 8, "output_tokens": 2}}},
        ])
        atomic_json(store.memory_root / ".routing/tasks/task_fixture.json", {
            "parent_session_id": "root", "usage_task_id": first["task_id"],
            "evaluator": {"called": True, "model": "other-evaluator", "status": "completed",
                          "usage": {"input_tokens": 4, "output_tokens": 1, "total_tokens": 5}}})
        usage = task_usage(store, "root")
        assert usage["total"] == 4
        assert usage["history"][0]["total"] == 15
        assert {item["model"] for item in usage["history"][0]["models"]} >= {
            "sonnet", "other-evaluator"}

    asyncio.run(scenario())


def test_model_changes_in_one_task_are_not_relabelled_as_latest_model(ledger):
    async def scenario():
        store, _, _ = ledger
        await boundary(ledger)
        append(store, "user_message", content="goal")
        native(store, 100, 80, 20)
        store.update_manifest("root", runtime_options={"model": "main-two"})
        await boundary(ledger)
        append(store, "user_message", content="followup")
        native(store, 125, 100, 25)
        usage = task_usage(store, "root")
        assert {item["model"]: item["total"] for item in usage["models"]} == {
            "main-one": 100, "main-two": 25, "fixture-evaluator": 4}
        assert usage["total"] == 129

    asyncio.run(scenario())


def test_legacy_history_is_not_invented_or_charged_again_on_a_new_task(ledger):
    async def scenario():
        store, _, _ = ledger
        append(store, "user_message", content="historical goal")
        native(store, 1000, 800, 200)
        _, complete = await boundary(ledger, "new")
        complete.assert_not_awaited()
        append(store, "user_message", content="new goal")
        native(store, 1012, 810, 202)
        usage = task_usage(store, "root")
        assert usage["total"] == 12
        assert usage["coverage"] == "since_tracking"
        assert usage["history"][0]["taskId"] == LEGACY_TASK
        assert usage["history"][0]["total"] == 1000

    asyncio.run(scenario())


def test_reported_api_version_does_not_create_a_missing_alias_call(ledger):
    async def scenario():
        store, _, _ = ledger
        await boundary(ledger)
        append(store, "user_message", content="goal")
        append(store, "assistant_message", message={"type": "ai", "data": {
            "id": "versioned", "response_metadata": {"model_name": "model-2026-10"},
            "usage_metadata": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
        }})
        usage = task_usage(store, "root")
        assert usage["total"] == 12 and usage["missingCalls"] == 0
        assert [item["model"] for item in usage["models"]] == ["model-2026-10"]

    asyncio.run(scenario())


def test_disabling_after_segmentation_preserves_history_and_snapshots_model(ledger):
    async def scenario():
        store, _, policy = ledger
        await boundary(ledger)
        append(store, "user_message", content="goal")
        native(store, 10, 8, 2)
        policy.task_tracking_enabled = False
        store.update_manifest("root", runtime_options={"model": "main-two"})
        result, complete = await boundary(ledger)
        complete.assert_not_awaited()
        append(store, "user_message", content="unclassified followup")
        native(store, 15, 12, 3)
        usage = task_usage(store, "root")
        assert result["status"] == "disabled" and usage["total"] == 15
        assert {item["model"]: item["total"] for item in usage["models"]} == {
            "main-one": 10, "main-two": 5}

    asyncio.run(scenario())


def test_task_tracking_configuration_keeps_older_routing_files_compatible(tmp_path):
    from cleo.routing.models import V2_FIELDS, load_policy, save_policy

    path = tmp_path / "routing.json"
    save_policy(path, RoutingSettings(task_tracking_enabled=True))
    assert load_policy(path).task_tracking_enabled is True
    assert json.loads(path.with_name("task-tracking.json").read_text()) == {"enabled": True}
    assert "task_tracking_enabled" not in json.loads(path.read_text())
    assert set(json.loads(path.with_name("routing-v2.json").read_text())) <= V2_FIELDS


def test_real_delegation_captures_parent_task_for_late_worker(service_factory, assessment):
    async def scenario():
        service, _ = service_factory()
        service.store.update_manifest("parent", usage_task_id="work_fixture")
        result = await service.delegate("offline fixture", assessment)
        record = json.loads((service.state_path / "tasks" / (
            result["task_id"] + ".json")).read_text())
        assert record["usage_task_id"] == "work_fixture"
        assert all(service.store.load_manifest(attempt["session_id"])["usage_task_id"]
                   == "work_fixture" for attempt in record["attempts"])

    asyncio.run(scenario())


def test_same_model_used_for_main_and_evaluator_has_one_combined_total(ledger):
    async def scenario():
        store, settings, _ = ledger
        settings.active_agent_profile = settings.active_agent_profile.model_copy(
            update={"model": "main-one"})
        await boundary(ledger)
        append(store, "user_message", content="goal")
        native(store, 10, 8, 2)
        await boundary(ledger)
        usage = task_usage(store, "root")
        assert len(usage["models"]) == 1 and usage["models"][0]["total"] == 14
        assert usage["total"] == 14

    asyncio.run(scenario())
