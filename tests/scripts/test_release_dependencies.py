import hashlib
import importlib.util
import json
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "release_dependencies", ROOT / "scripts/release_dependencies.py",
)
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


@pytest.fixture
def packaged(tmp_path, monkeypatch):
    packages = {"openai-codex": "0.155.1", "openai-codex-cli-bin": "0.155.1",
                "claude-agent-sdk": "0.2.145"}
    (tmp_path / "requirements.txt").write_text(
        "".join(f"{name}=={version}\n" for name, version in packages.items()),
    )
    (tmp_path / "ui/runtime").mkdir(parents=True)
    (tmp_path / "ui/package-lock.json").write_text('{"packages":{}}')
    tools = {"@openai/codex": "0.155.1", "agent-browser": "0.38.1", "npm": "11.19.1"}
    lock = {"packages": {f"node_modules/{name}": {"version": version}
                         for name, version in tools.items()}}
    (tmp_path / "ui/runtime/package-lock.json").write_text(json.dumps(lock))
    for name, version in tools.items():
        directory = tmp_path / "browser/node_modules" / name
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"version": version}))
    monkeypatch.setattr(receipt.subprocess, "check_output", lambda *a, **kw: json.dumps(packages))
    return tmp_path, packages


def test_receipt_records_exact_locks_and_installed_versions(packaged):
    root, packages = packaged
    output = root / "dependencies.json"
    receipt.record(root, root / "python", root / "browser", output)
    data = json.loads(output.read_text())
    assert data["python_packages"] == packages
    assert data["lock_sha256"] == {
        name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in receipt.LOCKS
    }


@pytest.mark.parametrize("name", ["openai-codex", "openai-codex-cli-bin", "claude-agent-sdk"])
def test_stale_packaged_sdk_cannot_publish_a_receipt(packaged, name):
    root, packages = packaged
    packages[name] = "0.1.0"
    with pytest.raises(ValueError, match="does not match"):
        receipt.record(root, root / "python", root / "browser", root / "dependencies.json")
    assert not (root / "dependencies.json").exists()


def test_stale_browser_tool_cannot_publish_a_receipt(packaged):
    root, _ = packaged
    (root / "browser/node_modules/agent-browser/package.json").write_text('{"version":"0.1.0"}')
    with pytest.raises(ValueError, match="does not match"):
        receipt.record(root, root / "python", root / "browser", root / "dependencies.json")


def test_all_platforms_test_the_same_freshly_resolved_locks():
    workflow = yaml.safe_load((ROOT / ".github/workflows/desktop-platforms.yml").read_text())
    jobs = workflow["jobs"]
    steps = jobs["dependencies"]["steps"]
    resolve = next(i for i, s in enumerate(steps) if "update_project.py" in s.get("run", ""))
    upload = next(i for i, s in enumerate(steps)
                  if s.get("with", {}).get("name") == "dependency-locks")
    assert resolve < upload
    assert jobs["desktop"]["needs"] == "dependencies"
    steps = jobs["desktop"]["steps"]
    download = next(i for i, s in enumerate(steps)
                    if s.get("with", {}).get("name") == "dependency-locks")
    install = next(i for i, s in enumerate(steps) if "uv pip install" in s.get("run", ""))
    test = next(i for i, s in enumerate(steps) if s.get("run", "").startswith("pytest"))
    package = next(i for i, s in enumerate(steps) if "package:portable" in s.get("run", ""))
    assert download < install < test < package
