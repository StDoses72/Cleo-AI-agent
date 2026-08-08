from __future__ import annotations

from cleo.cli.productivity_history import (
    event_transcript_entries,
    native_transcript_entries,
)


def test_native_codex_turns_are_normalized_for_transcript_restore() -> None:
    entries = native_transcript_entries(
        (
            {
                "id": "turn-1",
                "items": [
                    {
                        "id": "user-1",
                        "type": "userMessage",
                        "content": [{"type": "text", "text": "Build the page"}],
                    },
                    {
                        "id": "reasoning-1",
                        "type": "reasoning",
                        "summary": ["Inspecting the existing layout"],
                    },
                    {
                        "id": "command-1",
                        "type": "commandExecution",
                        "command": "git status --short",
                        "aggregatedOutput": " M index.html",
                    },
                    {
                        "id": "agent-1",
                        "type": "agentMessage",
                        "text": "The page is ready.",
                    },
                ],
            },
        )
    )

    assert [(entry.kind, entry.text) for entry in entries] == [
        ("user", "Build the page"),
        ("thought", "Inspecting the existing layout"),
        ("terminal", "$ git status --short\nM index.html"),
        ("assistant", "The page is ready."),
    ]


def test_managed_events_are_a_fallback_when_native_history_is_unavailable() -> None:
    entries = event_transcript_entries(
        [
            {"type": "session_created", "content": None},
            {"type": "user_message", "content": "Previous question"},
            {"type": "assistant_message", "content": "Previous answer"},
            {"type": "session_completed", "content": None},
        ]
    )

    assert [(entry.kind, entry.text) for entry in entries] == [
        ("user", "Previous question"),
        ("assistant", "Previous answer"),
    ]
