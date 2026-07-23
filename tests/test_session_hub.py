from core.integrations.agent_adapter import NativeSession
from core.session_hub import merge_session_rows


def _native(thread_id: str, updated_at: str) -> NativeSession:
    return NativeSession(
        id=thread_id,
        name="Native title",
        preview="Native preview",
        cwd="D:/workspace/cleo",
        status="idle",
        source="vscode",
        model_provider="openai",
        created_at="2026-07-22T10:00:00+00:00",
        updated_at=updated_at,
    )


def test_session_hub_merges_attached_and_unmanaged_native_threads() -> None:
    managed = [
        {
            "id": "agent-attached",
            "native_session_id": "native-attached",
            "space": "productivity",
            "project": "cleo",
            "provider": "codex",
            "status": "completed",
            "updated_at": "2026-07-22T10:00:00+00:00",
        },
        {
            "id": "local-chat",
            "native_session_id": None,
            "space": "non_productivity",
            "project": "general",
            "provider": "cleo",
            "status": "active",
            "updated_at": "2026-07-22T09:00:00+00:00",
        },
    ]

    rows = merge_session_rows(
        managed,
        (
            _native("native-attached", "2026-07-22T12:00:00+00:00"),
            _native("native-only", "2026-07-22T11:00:00+00:00"),
        ),
    )

    assert [row["id"] for row in rows] == [
        "agent-attached",
        "native-only",
        "local-chat",
    ]
    assert rows[0]["origin"] == "cleo+native"
    assert rows[0]["status"] == "idle"
    assert rows[1]["origin"] == "native"
