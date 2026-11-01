"""Offline actual usage accounting: no prompts, estimates or credentials."""
import asyncio
from types import SimpleNamespace

from cleo.routing.catalog import atomic_json
from cleo.runtime.task_usage import event_usage, task_usage


def api_event(key, incoming=10, outgoing=2):
    """Purpose: Build a reported API call. Output: persisted message fixture."""
    return {"id": key, "type": "assistant_message", "message": {"type": "ai", "data": {
        "id": key, "usage_metadata": {"input_tokens": incoming, "output_tokens": outgoing,
                                        "total_tokens": incoming + outgoing}}}}


def test_api_dedup_and_failed_cancelled_rewound_work_remains_counted():
    first = api_event("one")
    result = event_usage([{"type": "user_message"}, first, first,
                          {"type": "session_cancelled"}, {"type": "rewind"},
                          {"type": "user_message"}, api_event("two", 20, 4)])
    assert result == {"total": 36, "input": 30, "output": 6, "reportedCalls": 2,
                      "missingCalls": 0, "complete": True, "cacheRead": 0,
                      "cacheWrite": 0, "reportedCostUsd": None}


def test_native_cumulative_does_not_count_notifications_or_bridge_twice():
    def native(total):
        return {"type": "provider_event", "data": {"payload": {
            "threadId": "native", "tokenUsage": {"total": {
                "totalTokens": total, "inputTokens": total - 2, "outputTokens": 2}}}}}
    bridge = api_event("bridge")
    bridge["message"]["data"]["response_metadata"] = {"cleo_native_usage": True}
    result = event_usage([{"type": "user_message"}, native(12), native(12), bridge,
                          {"type": "user_message"}, native(24),
                          {"type": "user_message"}, {"type": "session_failed"}])
    assert result["total"] == 24 and result["reportedCalls"] == 2
    assert result["missingCalls"] == 1 and not result["complete"]


def test_claude_includes_reported_cache_tokens_and_unknown_is_not_zero():
    events = [{"type": "user_message"}, {"type": "usage", "data": {
        "call_id": "one", "usage": {"input_tokens": 10, "output_tokens": 2,
                                    "cache_read_input_tokens": 100,
                                    "cache_creation_input_tokens": 20}}}]
    assert event_usage(events)["total"] == 132
    result = event_usage([{"type": "user_message"}, {"type": "session_cancelled"}])
    assert result["total"] is None and result["missingCalls"] == 1


def test_intermediate_api_call_without_usage_is_disclosed():
    unknown = api_event("missing")
    unknown["message"]["data"].pop("usage_metadata")
    result = event_usage([{"type": "user_message"}, unknown, api_event("final")])
    assert result["total"] == 12
    assert result["missingCalls"] == 1 and not result["complete"]


def test_real_delegate_persistence_counts_worker_usage_across_session_spaces(
    service_factory, assessment,
):
    async def scenario():
        service, _ = service_factory(events=[{"type": "usage", "data": {
            "call_id": "worker-call", "usage": {"input_tokens": 10, "output_tokens": 2,
                                                   "cache_read_input_tokens": 20}}}])
        result = await service.delegate("offline", assessment)
        assert result["status"] == "completed"
        usage = task_usage(service.store, "parent")
        assert usage["total"] == 32 and usage["input"] == 30 and usage["output"] == 2
        assert usage["reportedCalls"] == 1 and usage["missingCalls"] == 0
        import json
        record = json.loads((service.state_path / "tasks" / (
            result["task_id"] + ".json")).read_text(encoding="utf-8"))
        assert record["attempts"][0]["usage"]["input_tokens"] == 30
        assert record["attempts"][0]["usage"]["cached_input_tokens"] == 20
    asyncio.run(scenario())


def test_task_sums_descendants_and_evaluator_once_without_unrelated_session(tmp_path):
    manifests = {"root": {"id": "root", "space": "chat", "project": "test"},
                 "child": {"id": "child", "parent_session_id": "root"},
                 "other": {"id": "other"}}
    store = SimpleNamespace(memory_root=tmp_path, load_manifest=manifests.__getitem__,
                            list_sessions=lambda **_: list(manifests.values()),
                            read_events=lambda key: [{"type": "user_message"}, api_event(key)])
    atomic_json(tmp_path / ".routing/tasks/task_a.json", {
        "parent_session_id": "root", "evaluator": {"status": "completed", "called": True, "usage": {
            "total_tokens": 5, "input_tokens": 4, "output_tokens": 1}}})
    result = task_usage(store, "root")
    assert result["total"] == 29 and result["reportedCalls"] == 3
    assert [item["role"] for item in result["breakdown"]].count("worker") == 1
