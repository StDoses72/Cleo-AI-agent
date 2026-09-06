import json
import subprocess
import time
from pathlib import Path

import pytest

from cleo.desktop import dependencies


@pytest.fixture
def runtime_update(tmp_path, monkeypatch):
    root = tmp_path / "runtimes"
    python = tmp_path / "base-python"
    browser = tmp_path / "base-browser"
    python.mkdir()
    browser.mkdir()
    (python / "user-data.txt").write_text("preserve base")
    (browser / "package.json").write_text('{"dependencies":{"agent-browser":"latest"}}')
    (browser / "package-lock.json").write_text('{"lockfileVersion":3}')
    (browser / ("node.exe" if dependencies.os.name == "nt" else "node")).write_text("node")
    monkeypatch.setattr(dependencies.importlib.metadata, "requires", lambda _: ["example>=1"])
    calls = []

    def run(command, *, cwd=None):
        command = list(map(str, command))
        calls.append(command)
        if "venv" in command:
            destination = Path(command[-1])
            destination.mkdir()
            (destination / "pyvenv.cfg").write_text("include-system-site-packages = false")
        if "compile" in command:
            Path(command[command.index("--output-file") + 1]).write_text("example==2.0\n")
        if "-c" in command:
            return json.dumps({"example": "1.0"})
        return ""

    monkeypatch.setattr(dependencies, "run", run)
    monkeypatch.setattr(dependencies, "validate_runtime", lambda *_: None)
    return root, python, browser, calls


def test_update_publishes_only_a_validated_independent_runtime(runtime_update, monkeypatch):
    root, python, browser, calls = runtime_update

    def validate(candidate_python, candidate_browser):
        assert dependencies.read_state(root).get("active") is None
        assert candidate_python.is_relative_to(root)
        assert candidate_browser.is_relative_to(root)

    monkeypatch.setattr(dependencies, "validate_runtime", validate)
    result = dependencies.update(root, python, browser, None)
    active = dependencies.snapshot_path(root, result["active"])
    assert result["phase"] == "ready"
    assert (active / "python/pyvenv.cfg").exists()
    assert not (active / "python/user-data.txt").exists()
    assert (python / "user-data.txt").read_text() == "preserve base"
    assert any("--upgrade" in command for command in calls)
    assert not (root / "state.json.tmp").exists()


def test_failed_validation_preserves_current_runtime_and_removes_candidate(
    runtime_update, monkeypatch,
):
    root, python, browser, _ = runtime_update
    root.mkdir()
    current = root / ("a" * 32)
    (current / "python").mkdir(parents=True)
    (current / "browser").mkdir()
    for name in ("package.json", "package-lock.json"):
        (current / "browser" / name).write_bytes((browser / name).read_bytes())
    node = "node.exe" if dependencies.os.name == "nt" else "node"
    (current / "browser" / node).write_text("node")
    dependencies.write_state(root, {"active": current.name})

    def fail(*_):
        raise subprocess.CalledProcessError(1, ["python"], stderr="incompatible SDK")

    monkeypatch.setattr(dependencies, "validate_runtime", fail)
    result = dependencies.update(root, python, browser, current.name)
    assert result["phase"] == "error"
    assert result["error"] == "incompatible SDK"
    assert result["active"] == current.name
    assert [path for path in root.iterdir() if path.is_dir()] == [current]


def test_daily_check_keeps_current_and_pending_but_cleans_interrupted_updates(runtime_update):
    root, python, browser, calls = runtime_update
    root.mkdir()
    current, pending, abandoned = (root / (letter * 32) for letter in "abc")
    for path in (current, pending, abandoned):
        path.mkdir()
    dependencies.write_state(root, {"active": pending.name, "checkedAt": time.time()})
    dependencies.update(root, python, browser, current.name)
    assert current.exists() and pending.exists()
    assert not abandoned.exists()
    assert calls == []


def test_invalid_snapshot_cannot_escape_managed_directory(tmp_path):
    root = tmp_path / "runtime"
    assert dependencies.snapshot_path(root, "../user-data") is None
    assert dependencies.snapshot_path(root, str(tmp_path)) is None
    with pytest.raises(ValueError, match="unmanaged"):
        dependencies.remove_snapshot(root, tmp_path)
    assert tmp_path.exists()


def test_unchanged_dependencies_do_not_copy_a_runtime(runtime_update, monkeypatch):
    root, python, browser, _ = runtime_update
    original = dependencies.run

    def run(command, **kwargs):
        if "-c" in command:
            return '{"example":"2.0"}'
        return original(command, **kwargs)

    monkeypatch.setattr(dependencies, "run", run)
    result = dependencies.update(root, python, browser, None)
    assert result["phase"] == "up-to-date"
    assert "active" not in result
    assert not any(path.is_dir() for path in root.iterdir())
