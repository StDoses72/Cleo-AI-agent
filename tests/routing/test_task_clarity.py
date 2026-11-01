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
    assert live.used_tokens == persisted["used"] == 41818
    assert live.ratio < 1


def test_missing_latest_context_never_reuses_lifetime_or_stale_occupancy():
    events = [{"data": {"tokenUsage": {"last": {"totalTokens": 200},
                                      "modelContextWindow": 1000}}},
              {"data": {"tokenUsage": {"total": {"totalTokens": 900000}}}}]
    assert usage_from_events(events, 1000)["used"] is None


def test_responsibility_label_is_validated_and_redacted():
    task = TaskAssessment(task_type="analysis", complexity="low", acceptance_criteria=["done"],
                          part="连通性测试 api_key=secret-fixture")
    assert "secret-fixture" not in task.part
