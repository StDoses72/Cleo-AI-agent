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


def test_runtime_project_paths_and_removed_projects_are_partitioned_by_space() -> None:
    state = RuntimeState(
        projects={
            "non_productivity": ["general", "notes"],
            "productivity": ["cleo", "removed-code"],
        },
        project_paths={
            "non_productivity": {"notes": "D:/notes"},
            "productivity": {"cleo": "D:/cleo", "removed-code": "D:/old"},
        },
        removed_projects={
            "non_productivity": [],
            "productivity": ["removed-code"],
        },
    )

    assert state.project_paths["non_productivity"] == {"notes": "D:/notes"}
    assert state.project_paths["productivity"] == {"cleo": "D:/cleo"}
    assert state.projects["productivity"] == ["cleo"]
    assert state.removed_projects["productivity"] == ["removed-code"]
