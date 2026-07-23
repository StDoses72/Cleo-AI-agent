from cleo.runtime.state import RuntimeState


def test_runtime_recent_threads_are_partitioned_by_space() -> None:
    state = RuntimeState(
        current_space="productivity",
        current_project="cleo",
        projects={
            "non_productivity": ["general", "personal"],
            "productivity": ["cleo"],
        },
        recent_threads={
            "non_productivity": ["personal-session"],
            "productivity": ["code-session"],
        },
    )

    assert state.projects["non_productivity"] == ["general", "personal"]
    assert state.projects["productivity"] == ["cleo"]
    assert state.recent_threads["non_productivity"] == ["personal-session"]
    assert state.recent_threads["productivity"] == ["code-session"]
