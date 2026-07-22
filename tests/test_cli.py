from io import StringIO

from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document
from rich.console import Console

from core.cli import CleoCLI, SlashCommandCompleter
from core.integrations.agent_adapter import AgentEvent, AgentResult, AgentSession


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

    cli.render_chat_header("local-123", "cleo")
    cli.render_productivity_header(session)
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


def test_productivity_renderer_formats_canonical_events() -> None:
    cli, output = _captured_cli()
    renderer = cli.productivity_renderer()

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

    assert command_values == {"/cd", "/cwd"}
    assert resume_values == ["agent_saved123"]
    assert chat_values == {"/resume"}
