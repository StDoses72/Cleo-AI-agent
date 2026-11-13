"""Context occupancy and account usage as each harness reports them; no model or network calls."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

from acp.schema import UsageUpdate
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

from cleo.desktop.presenters import usage_from_events
from cleo.harnesses import AgentAdapter, SessionOptions
from cleo.harnesses.events import CONTEXT_USAGE_EVENT
from cleo.integrations.harnesses.acp import _AcpClientHost
from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime
from cleo.integrations.harnesses.claude_usage import usage_windows
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.runtime.usage import RateLimitWindowUsage


def _readings(events):
    return [event.data["payload"]["contextUsage"] for event in events
            if event.data.get("provider_event_type") == CONTEXT_USAGE_EVENT]


def test_claude_publishes_each_request_once_and_follows_the_reported_window(tmp_path, monkeypatch):
    first = {"input_tokens": 10, "cache_creation_input_tokens": 18751,
             "cache_read_input_tokens": 0, "output_tokens": 7}
    second = {"input_tokens": 12, "cache_creation_input_tokens": 400,
              "cache_read_input_tokens": 18751, "output_tokens": 90}

    class Client:
        query = AsyncMock()
        disconnect = AsyncMock()

        async def receive_messages(self):
            # One request arrives as a thinking message and a text message with the same usage.
            yield AssistantMessage(content=[TextBlock(text="a")], model="opus", usage=first)
            yield AssistantMessage(content=[TextBlock(text="b")], model="opus", usage=first)
            # A subagent fills its own window.
            yield AssistantMessage(content=[TextBlock(text="sub")], model="haiku",
                                   parent_tool_use_id="tool-1",
                                   usage={"input_tokens": 900000, "output_tokens": 1})
            yield AssistantMessage(content=[TextBlock(text="c")], model="opus", usage=second)
            yield AssistantMessage(content=[TextBlock(text="no usage")], model="opus")
            yield ResultMessage(
                subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                session_id="native", result="done",
                model_usage={"opus": {"contextWindow": 1000000},
                             "haiku": {"contextWindow": 200000}},
            )

    async def scenario():
        provider = ClaudeProvider()
        monkeypatch.setattr(provider, "_connect", AsyncMock(return_value=_ClaudeRuntime(
            Client(), SessionOptions(), str(tmp_path), context_window=200000,
        )))
        adapter = AgentAdapter(tmp_path)
        adapter.register(provider)
        try:
            result = await adapter.run("claude", "Do the work")
            assert _readings(result.events) == [
                {"used": 18761, "window": 200000},
                {"used": 19163, "window": 200000},
                # The result names the model's real window.
                {"used": 19163, "window": 1000000},
            ]
            stored = adapter._store.read_events(result.session_id)
            status = [event for event in stored if event["type"] == "status"]
            assert len(status) == 3, "readings are kept as status events a conversation replays"
            view = usage_from_events(stored, 0)
            assert (view["used"], view["limit"]) == (19163, 1000000)
        finally:
            await adapter.aclose()

    asyncio.run(scenario())


def test_claude_reads_its_window_from_the_runtime_or_leaves_it_unknown():
    async def scenario():
        reports = SimpleNamespace(get_context_usage=AsyncMock(return_value={"maxTokens": 1000000}))
        failing = SimpleNamespace(get_context_usage=AsyncMock(side_effect=RuntimeError("closed")))
        odd = SimpleNamespace(get_context_usage=AsyncMock(return_value={"maxTokens": "many"}))
        assert await ClaudeProvider._context_window(reports) == 1000000
        assert await ClaudeProvider._context_window(failing) is None
        assert await ClaudeProvider._context_window(odd) is None
        assert await ClaudeProvider._context_window(SimpleNamespace()) is None

    asyncio.run(scenario())


def test_acp_usage_update_is_a_status_event_with_the_agents_own_numbers(tmp_path):
    async def scenario():
        host = _AcpClientHost("opencode", str(tmp_path), auto_approve=False)
        await host.session_update("native", UsageUpdate(
            sessionUpdate="usage_update", used=79087, size=262144,
            cost={"amount": 0, "currency": "USD"},
        ))
        (event,) = host.events
        assert event.type == "status"
        assert event.data["provider_event_type"] == "usage_update"
        view = usage_from_events([event.model_dump(mode="json")], 0)
        assert (view["used"], view["limit"]) == (79087, 262144)

    asyncio.run(scenario())


def test_codex_reads_account_usage_without_a_task_session(monkeypatch):
    class FakeClient:
        async def request(self, method, params, *, response_model):
            assert (method, params) == ("account/rateLimits/read", None)
            return response_model.model_validate({"rateLimits": {
                "primary": {"usedPercent": 42, "windowDurationMins": 300,
                            "resetsAt": 1_800_000_000},
                "secondary": {"usedPercent": 180, "windowDurationMins": 10_080},
            }})

    @asynccontextmanager
    async def temporary():
        yield SimpleNamespace(_client=FakeClient())

    provider = CodexProvider(default_model="test-model")
    monkeypatch.setattr(provider, "_client", temporary)
    assert asyncio.run(provider.account_usage()) == (
        RateLimitWindowUsage(used_percent=42, window_minutes=300, resets_at=1_800_000_000),
        RateLimitWindowUsage(used_percent=100, window_minutes=10_080),
    )


def test_claude_usage_rows_become_windows_in_the_servers_order():
    reply = {"subscription_type": "max", "rate_limits": {"limits": [
        {"kind": "session", "group": "session", "percent": 37.6,
         "resets_at": "2026-11-13T05:00:00+00:00", "scope": None},
        {"kind": "weekly_all", "group": "weekly", "percent": 6,
         "resets_at": "2026-11-19T18:00:00.933497+00:00", "scope": None},
        {"kind": "weekly_scoped", "group": "weekly", "percent": 11, "resets_at": None,
         "scope": {"model": {"id": None, "display_name": "Opus"}, "surface": None}},
        # A group whose length is not known is left out, as is a row without a number.
        {"kind": "monthly_all", "group": "monthly", "percent": 3},
        {"kind": "weekly_all", "group": "weekly", "percent": None},
        "not a row",
    ]}}
    assert usage_windows(reply) == (
        RateLimitWindowUsage(used_percent=38, window_minutes=300, resets_at=1_794_546_000),
        RateLimitWindowUsage(used_percent=6, window_minutes=10_080, resets_at=1_795_111_200),
        RateLimitWindowUsage(used_percent=11, window_minutes=10_080, scope="Opus"),
    )
    # An account without plan limits, a failed fetch and an older runtime all read as no rows.
    for empty in ({"rate_limits": {"limits": None}}, {"rate_limits": None}, {}, None, "error"):
        assert usage_windows(empty) == ()
