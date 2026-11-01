"""Machine-independent Git settings for process-level characterization fixtures."""

import subprocess

from .support.home import build_home


def test_backend_git_hashes_do_not_depend_on_system_configuration(tmp_path, monkeypatch):
    """Purpose: Isolate newline rules. Input: conflicting config. Output: canonical Git blob."""
    global_config = tmp_path / "global.gitconfig"
    global_config.write_text("[core]\n\tautocrlf = false\n", encoding="utf-8")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    home = build_home(tmp_path / "fixture", "http://127.0.0.1:1")
    (home.workspace / "notes.txt").write_bytes(b"scripted note\r\n")
    # Match the backend's Git invocation, rather than the setup helper's -c flags.
    subprocess.run(["git", "add", "notes.txt"], cwd=home.workspace, check=True,
                   capture_output=True)
    blob = subprocess.check_output(["git", "show", ":notes.txt"], cwd=home.workspace)
    assert blob == b"scripted note\n"
