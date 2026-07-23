from pathlib import Path


def test_directory_profile_exposes_new_session_paths(tmp_path: Path) -> None:
    from cleo.config.settings import DirectoryProfile

    profile = DirectoryProfile(
        root_dir=tmp_path,
        memory_dir="memory",
        memory_policy_path="memory/MEMORY_POLICY.md",
        session_index_path="memory/sessions.sqlite3",
        session_artifacts_dir="data/session_artifacts",
    )

    assert profile.memory_path == tmp_path / "memory"
    assert profile.memory_policy_file == tmp_path / "memory" / "MEMORY_POLICY.md"
    assert profile.session_index_file == tmp_path / "memory" / "sessions.sqlite3"
    assert profile.session_artifacts_path == tmp_path / "data" / "session_artifacts"
