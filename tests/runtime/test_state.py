import json
from types import SimpleNamespace

import pytest

from cleo.runtime.state import Runtime, RuntimeState


def test_ui_language_survives_restart_and_other_runtime_writes(tmp_path, monkeypatch):
    import cleo.config.settings as config

    path = tmp_path / "shared-home" / "data" / "runtime.json"
    monkeypatch.setattr(config, "settings", SimpleNamespace(
        RUNTIME_STATE_PATH=path, MEMORY_DIR=tmp_path / "shared-home" / "memory",
    ))
    runtime = Runtime()
    assert runtime.ui_language == "zh-CN"
    runtime.set_ui_language("en")
    runtime.update_current_space("productivity")
    assert json.loads(path.read_text(encoding="utf-8"))["ui_language"] == "en"
    # A new process/program version reads the same runtime home.
    restored = Runtime()
    assert restored.ui_language == "en"
    assert restored.current_space == "productivity"
    before = path.read_bytes()
    with pytest.raises(ValueError, match="Unsupported UI language"):
        restored.set_ui_language("system")
    assert restored.ui_language == "en"
    assert path.read_bytes() == before


def test_invalid_language_does_not_reset_other_runtime_state():
    state = RuntimeState.model_validate({"ui_language": "system", "current_thread_id": "keep"})
    assert state.ui_language == "zh-CN"
    assert state.current_thread_id == "keep"


def test_language_save_failure_preserves_the_previous_selection(tmp_path, monkeypatch):
    import cleo.config.settings as config

    path = tmp_path / "runtime.json"
    monkeypatch.setattr(config, "settings", SimpleNamespace(
        RUNTIME_STATE_PATH=path, MEMORY_DIR=tmp_path / "memory",
    ))
    runtime = Runtime()
    before = path.read_bytes()

    def fail(_state):
        raise OSError("disk full")

    monkeypatch.setattr(runtime, "_write_runtime_state", fail)
    with pytest.raises(OSError, match="disk full"):
        runtime.set_ui_language("en")
    assert runtime.ui_language == "zh-CN"
    assert path.read_bytes() == before


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
