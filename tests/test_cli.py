from io import StringIO

from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from rich.console import Console

from core.cli import CleoCLI, SlashCommandCompleter
from core.integrations.agent_adapter import (
    AgentEvent,
    AgentResult,
    AgentSession,
    HarnessModel,
    NativeSession,
)
from core.usage import ContextWindowUsage


def _captured_cli() -> tuple[CleoCLI, StringIO]:
    output = StringIO()
    console = Console(file=output, color_system=None, force_terminal=False, width=120)
    return CleoCLI(console), output


def test_cli_renders_chat_productivity_and_session_hub() -> None:
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
    cli.render_session_hub(
        [
            {
                "id": session.id,
                "space": "productivity",
                "project": "cleo",
                "provider": "codex",
                "status": "running",
                "updated_at": "2026-07-22T10:30:00+00:00",
            }
        ]
    )

    rendered = output.getvalue()
    assert "CLEO" in rendered
    assert "PRODUCTIVITY · CODEX" in rendered
    assert "SESSION HUB" in rendered
    assert "agent_123456789" in rendered
    assert "productivity" in rendered
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
    assert usage.used_tokens == 40_000


def test_slash_command_completer_uses_mode_and_saved_sessions() -> None:
    completer = SlashCommandCompleter(
        "productivity",
        sessions=[
            {
                "id": "agent_saved123",
                "project": "cleo",
                "provider": "codex",
                "status": "completed",
                "native_session_id": "native-1",
            },
            {
                "id": "agent_without_native",
                "project": "cleo",
                "provider": "codex",
                "status": "created",
                "native_session_id": None,
            },
        ],
        native_sessions=(
            NativeSession(
                id="native-thread-1",
                name="Native work",
                preview="Inspect the repository",
                cwd="D:/workspace/cleo",
                status="idle",
                source="vscode",
                model_provider="openai",
                created_at="2026-07-22T10:00:00+00:00",
                updated_at="2026-07-22T10:30:00+00:00",
            ),
        ),
        models=(
            HarnessModel(
                id="gpt-5.6-sol",
                display_name="GPT-5.6 Sol",
                description="",
                is_default=True,
                default_effort="medium",
                supported_efforts=("medium", "high"),
            ),
        ),
    )

    command_values = {
        item.text
        for item in completer.get_completions(
            Document("/c"),
            CompleteEvent(completion_requested=True),
        )
    }
    resume_values = [
        item.text
        for item in completer.get_completions(
            Document("/resume agent_"),
            CompleteEvent(completion_requested=True),
        )
    ]
    chat_values = {
        item.text
        for item in SlashCommandCompleter("chat").get_completions(
            Document("/r"),
            CompleteEvent(completion_requested=True),
        )
    }
    native_values = [
        item.text
        for item in completer.get_completions(
            Document("/resume-native native-"),
            CompleteEvent(completion_requested=True),
        )
    ]
    model_values = [
        item.text
        for item in completer.get_completions(
            Document("/model gpt-"),
            CompleteEvent(completion_requested=True),
        )
    ]
    project_values = [
        item.text
        for item in SlashCommandCompleter(
            "chat",
            projects=("general", "cleo", "research"),
        ).get_completions(
            Document("/project re"),
            CompleteEvent(completion_requested=True),
        )
    ]
    move_project_values = [
        item.text
        for item in SlashCommandCompleter(
            "chat",
            projects=("general", "cleo", "research"),
        ).get_completions(
            Document("/project move re"),
            CompleteEvent(completion_requested=True),
        )
    ]

    assert command_values == {"/cd", "/compact", "/cwd"}
    assert resume_values == ["agent_saved123"]
    assert native_values == ["native-thread-1"]
    assert model_values == ["gpt-5.6-sol"]
    assert project_values == ["research"]
    assert move_project_values == ["research"]
    assert chat_values == {"/rename", "/resume"}
