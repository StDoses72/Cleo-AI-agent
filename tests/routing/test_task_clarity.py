"""Regression checks for task identity and context occupancy; no model/network calls."""

from cleo.desktop.presenters import usage_from_events
from cleo.harnesses.events import capture_context_usage
from cleo.harnesses.models import AgentEvent
from cleo.routing.models import TaskAssessment
from cleo.runtime.usage import ContextWindowUsage


def test_current_context_uses_last_request_not_session_consumption():
    data = {"provider_event_type": "thread/tokenUsage/updated", "payload": {"tokenUsage": {
        "total": {"totalTokens": 10969091},
        "last": {"inputTokens": 41558, "outputTokens": 260},
        "modelContextWindow": 258000,
    }}}
    event = AgentEvent(provider="codex", type="status", data=data)
    live = ContextWindowUsage()
    capture_context_usage(event, live)
    persisted = usage_from_events([event.model_dump(mode="json")], 258000)
    # The request's input side; the reply's 260 tokens become input on the next request.
    assert live.used_tokens == persisted["used"] == 41558
    assert live.ratio < 1


def test_every_harness_means_the_input_side_of_its_latest_request():
    from cleo.harnesses.events import context_usage_data, request_input_tokens

    # Claude reports per request; cache reads and writes are input the model was sent.
    used = request_input_tokens({"input_tokens": 10, "cache_creation_input_tokens": 18751,
                                 "cache_read_input_tokens": 3000, "output_tokens": 42})
    assert used == 21761
    assert request_input_tokens({"output_tokens": 42}) is None
    claude = AgentEvent(provider="claude", type="status", data=context_usage_data(used, 200000))
    # OpenCode and other ACP agents send the occupancy and the window themselves.
    acp = AgentEvent(provider="opencode", type="status", data={
        "provider_event_type": "usage_update", "schema_version": 1,
        "payload": {"sessionUpdate": "usage_update", "used": 79087, "size": 262144,
                    "cost": {"amount": 0.0, "currency": "USD"}},
    })
    for event, expected in ((claude, (21761, 200000)), (acp, (79087, 262144))):
        live = ContextWindowUsage()
        capture_context_usage(event, live)
        persisted = usage_from_events([event.model_dump(mode="json")], 0)
        assert (live.used_tokens, live.window_tokens) == expected
        assert (persisted["used"], persisted["limit"]) == expected
    # A reading without a window keeps the window already known.
    kept = ContextWindowUsage(window_tokens=128000)
    capture_context_usage(
        AgentEvent(provider="claude", type="status", data=context_usage_data(500, None)), kept)
    assert (kept.used_tokens, kept.window_tokens) == (500, 128000)
    # An unrelated event leaves the reading alone.
    capture_context_usage(AgentEvent(provider="opencode", type="provider_event", data={
        "provider_event_type": "current_mode_update", "payload": {"used": 1, "size": 2}}), kept)
    assert kept.used_tokens == 500


def test_missing_latest_context_never_reuses_lifetime_or_stale_occupancy():
    events = [{"data": {"tokenUsage": {"last": {"totalTokens": 200},
                                      "modelContextWindow": 1000}}},
              {"data": {"tokenUsage": {"total": {"totalTokens": 900000}}}}]
    assert usage_from_events(events, 1000)["used"] is None


def test_responsibility_label_is_validated_and_redacted():
    task = TaskAssessment(task_type="analysis", complexity="low", acceptance_criteria=["done"],
                          part="连通性测试 api_key=secret-fixture")
    assert "secret-fixture" not in task.part
