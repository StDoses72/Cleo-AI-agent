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
    tools = {"agent-browser": "0.38.1", "npm": "11.19.1"}
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


def test_receipt_records_only_the_browser_tools_the_runtime_ships(packaged):
    root, _ = packaged
    receipt.record(root, root / "python", root / "browser", root / "dependencies.json")
    data = json.loads((root / "dependencies.json").read_text())
    assert data["tools"] == {"agent-browser": "0.38.1", "npm": "11.19.1"}


@pytest.mark.parametrize("where", ["node_modules", "lock"])
def test_a_second_codex_cli_from_npm_cannot_publish_a_receipt(packaged, where):
    """The Codex CLI ships once, inside openai-codex-cli-bin (#142)."""
    root, _ = packaged
    if where == "node_modules":
        duplicate = root / "browser/node_modules/@openai/codex"
        duplicate.mkdir(parents=True)
        (duplicate / "package.json").write_text('{"version": "0.155.1"}')
    else:
        lock_path = root / "ui/runtime/package-lock.json"
        lock = json.loads(lock_path.read_text())
        lock["packages"]["node_modules/@openai/codex"] = {"version": "0.155.1"}
        lock_path.write_text(json.dumps(lock))
    with pytest.raises(ValueError, match="duplicates the Python-bundled Codex CLI"):
        receipt.record(root, root / "python", root / "browser", root / "dependencies.json")
    assert not (root / "dependencies.json").exists()


def test_runtime_manifest_does_not_redistribute_the_codex_cli():
    manifest = json.loads((ROOT / "ui/runtime/package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "ui/runtime/package-lock.json").read_text(encoding="utf-8"))
    assert "@openai/codex" not in manifest.get("dependencies", {})
    assert not any("@openai/codex" in name for name in lock.get("packages", {}))
    assert set(manifest["dependencies"]) == set(receipt.BROWSER_TOOLS)


def test_receipt_selects_only_requirements_for_the_current_platform(packaged):
    root, packages = packaged
    with (root / "requirements.txt").open("a") as stream:
        stream.write("claude-agent-sdk==9.9.9 ; sys_platform == 'unsupported-test-platform'\n")
    receipt.record(root, root / "python", root / "browser", root / "dependencies.json")
    assert json.loads((root / "dependencies.json").read_text())["python_packages"] == packages


def test_all_platforms_package_the_same_freshly_resolved_locks():
    workflow = yaml.safe_load((ROOT / ".github/workflows/desktop-platforms.yml").read_text())
    jobs = workflow["jobs"]
    steps = jobs["dependencies"]["steps"]
    resolve = next(i for i, s in enumerate(steps) if "update_project.py" in s.get("run", ""))
    upload = next(i for i, s in enumerate(steps)
                  if s.get("with", {}).get("name") == "dependency-locks")
    assert resolve < upload
    assert set(steps[upload]["with"]["path"].split()) == set(receipt.LOCKS)
    assert jobs["desktop"]["needs"] == "dependencies"
    steps = jobs["desktop"]["steps"]
    download = next(i for i, s in enumerate(steps)
                    if s.get("with", {}).get("name") == "dependency-locks")
    package_steps = []
    for command, flag in (("package:portable", "--locked-dependencies"),
                          ("build-release.ps1", "-LockedDependencies")):
        index = next(i for i, s in enumerate(steps) if command in s.get("run", ""))
        assert download < index
        step = steps[index]
        assert flag in step["run"], "Every platform must package the shared dependency locks"
        assert "\n" not in step["run"].strip(), "Each Windows command must have its own exit check"
        assert "shell" not in step, "Use the runner's native shell and path encoding"
        package_steps.append(index)
    launch_checks = [i for i, s in enumerate(steps)
                     if "smoke:package-launch" in s.get("run", "")]
    assert len(launch_checks) == 2, "Verify packaged startup on Linux and native Windows/macOS"
    assert max(package_steps) < min(launch_checks)
