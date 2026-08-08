from io import StringIO

from rich.console import Console

from cleo.cli.console import CleoCLI
from cleo.harnesses import (
    AgentEvent,
    AgentResult,
    AgentSession,
)
from cleo.runtime.usage import ContextWindowUsage, RateLimitWindowUsage


def _captured_cli() -> tuple[CleoCLI, StringIO]:
    output = StringIO()
    console = Console(file=output, color_system=None, force_terminal=False, width=120)
    return CleoCLI(console), output


def test_cli_renders_one_shot_chat_and_productivity_headers() -> None:
    cli, output = _captured_cli()
    session = AgentSession(
        id="agent_123456789",
        provider="codex",
        project_path="D:/workspace/cleo",
        native_session_id="native-1",
        project="cleo",
    )

    usage = ContextWindowUsage(
        used_tokens=50_000,
        window_tokens=100_000,
        input_tokens=48_000,
        output_tokens=2_000,
    )
    cli.render_chat_header(
        "local-123",
        "cleo",
        model="deepseek-v4-flash",
        context_usage=usage,
    )
    cli.render_productivity_header(
        session,
        model="gpt-5.5",
        context_usage=usage,
    )
    rendered = output.getvalue()
    assert "CLEO" in rendered
    assert "PRODUCTIVITY · CODEX" in rendered
    assert "agent_123456789" in rendered
    assert "deepseek-v4-flash" in rendered
    assert "gpt-5.5" in rendered
    assert "50%" in rendered


def test_productivity_renderer_formats_canonical_events() -> None:
    cli, output = _captured_cli()
    usage = ContextWindowUsage()
    renderer = cli.productivity_renderer(model="gpt-5.5", context_usage=usage)

    renderer(
        AgentEvent(
            provider="codex",
            type="status",
            data={
                "provider_event_type": "thread/tokenUsage/updated",
                "payload": {
                    "tokenUsage": {
                        "total": {"totalTokens": 40_000},
                        "last": {
                            "inputTokens": 9_000,
                            "outputTokens": 1_000,
                            "cachedInputTokens": 2_000,
                        },
                        "modelContextWindow": 100_000,
                    }
                },
            },
        )
    )

    renderer(
        AgentEvent(
            provider="codex",
            type="plan_update",
            data={"payload": {"plan": [{"step": "Inspect"}, {"step": "Implement"}]}},
        )
    )
    renderer(
        AgentEvent(
            provider="codex",
            type="tool_call",
            data={"payload": {"item": {"command": "git status"}}},
        )
    )
    renderer(
        AgentEvent(provider="codex", type="assistant_message_chunk", text="Done")
    )
    renderer(
        AgentEvent(
            provider="codex",
            type="file_change",
            text=(
                "diff --git a/app.py b/app.py\n"
                "--- a/app.py\n"
                "+++ b/app.py\n"
                "-old secret line\n"
                "+new secret line\n"
            ),
            data={"provider_event_type": "turn/diff/updated"},
        )
    )
    renderer.finish(
        AgentResult(
            session_id="agent-1",
            provider="codex",
            native_session_id="native-1",
            turn_id="turn-1",
            status="completed",
            response="Done",
        )
    )

    rendered = output.getvalue()
    assert "PLAN" in rendered
    assert "Inspect → Implement" in rendered
    assert "TOOL" in rendered
    assert "git status" in rendered
    assert "CODEX" in rendered
    assert "COMPLETED" in rendered
    assert "gpt-5.5" in rendered
    assert "40%" in rendered
    assert "DIFF" in rendered
    assert "1 file(s) · +1 -1 · /diff to expand" in rendered
    assert "new secret line" not in rendered
    assert usage.used_tokens == 40_000


def test_productivity_status_prefers_account_rate_limits() -> None:
    cli, output = _captured_cli()
    usage = ContextWindowUsage(used_tokens=40_000, window_tokens=100_000)
    usage.update_rate_limits(
        (
            RateLimitWindowUsage(used_percent=25, window_minutes=300),
            RateLimitWindowUsage(used_percent=10, window_minutes=10_080),
        )
    )

    cli.render_runtime_status("gpt-5.6-sol", usage, accent="magenta")

    rendered = output.getvalue()
    assert "LIMITS" in rendered
    assert "5H 75% left" in rendered
    assert "WEEK 90% left" in rendered
    assert "CONTEXT" not in rendered
