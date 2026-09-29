"""Installer checks must fail before success and avoid the user's runtime configuration."""

import importlib.util
import os
import plistlib
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


checker = load("installer-check")
builder = load("build-installers")


@pytest.fixture
def runtime_resources(tmp_path):
    config = tmp_path / "defaults/config"
    config.mkdir(parents=True)
    (config / "cleo.json").write_text('{"profiles":{}}')
    (config / "harnesses.json").write_text('{"providers":{}}')
    return tmp_path


@pytest.mark.parametrize("failed_step", [None, 0, 1, 2])
def test_runtime_check_validates_all_bundled_tools_and_cleans_up(
    runtime_resources, monkeypatch, failed_step,
):
    calls = []
    monkeypatch.setenv("PYTHONPATH", "must-not-be-used")
    monkeypatch.setenv("CLEO_PYTHON", "must-not-be-used")
    monkeypatch.setenv("DYLD_LIBRARY_PATH", "must-not-be-used")

    def execute(command, *, cwd, env, **kwargs):
        assert Path(cwd).is_dir()
        assert env["HOME"] == env["CLEO_HOME"] == cwd
        assert not {"PYTHONPATH", "CLEO_PYTHON", "DYLD_LIBRARY_PATH"} & env.keys()
        assert Path(command[0]).is_relative_to(runtime_resources)
        for name in ("cleo.json", "harnesses.json"):
            assert (Path(cwd) / "config" / name).read_bytes() == (
                runtime_resources / "defaults/config" / name
            ).read_bytes()
        calls.append((command, cwd))
        return SimpleNamespace(returncode=int(len(calls) - 1 == failed_step),
                               stdout="", stderr="missing libssl.3.dylib")

    monkeypatch.setattr(checker.subprocess, "run", execute)
    if failed_step is None:
        checker.check(runtime_resources)
        assert len(calls) == 3
    else:
        with pytest.raises(RuntimeError, match="missing libssl"):
            checker.check(runtime_resources)
        assert len(calls) == failed_step + 1
    assert all(not Path(cwd).exists() for _, cwd in calls)
    assert "from cleo.desktop.server import main" in calls[0][0][-1]


def test_timeout_does_not_pass_and_removes_the_test_profile(runtime_resources, monkeypatch):
    directories = []

    def timeout(command, *, cwd, **kwargs):
        directories.append(cwd)
        raise subprocess.TimeoutExpired(command, 120)

    monkeypatch.setattr(checker.subprocess, "run", timeout)
    with pytest.raises(subprocess.TimeoutExpired):
        checker.check(runtime_resources)
    assert all(not Path(path).exists() for path in directories)


def test_macos_installer_has_architecture_guard_and_complete_bundle_replacement(
    tmp_path, monkeypatch,
):
    monkeypatch.setattr(builder.sys, "platform", "darwin")
    resources = tmp_path / "Cleo.app/Contents/Resources"
    resources.mkdir(parents=True)
    (resources / "release.json").write_text('{"platform":"macos-arm64","version":"0.6.1"}')
    commands = []

    def run(*command):
        commands.append(command)
        if command[0] != "pkgbuild":
            return
        component_path = Path(command[command.index("--component-plist") + 1])
        properties = plistlib.loads(component_path.read_bytes())
        assert properties[0]["BundleIsRelocatable"] is False
        assert properties[0]["BundleOverwriteAction"] == "upgrade"
        scripts = Path(command[command.index("--scripts") + 1])
        assert "'macos-arm64'" in (scripts / "preinstall").read_text()
        assert "hw.optional.arm64" in (scripts / "preinstall").read_text()
        assert "installer-check.py" in (scripts / "postinstall").read_text()
        Path(command[-1]).write_bytes(b"native package fixture")

    monkeypatch.setattr(builder, "run", run)
    output = builder.build(tmp_path)
    assert output.name == "Cleo-macos-arm64.pkg"
    assert output.with_name(output.name + ".sha256").read_text().endswith(f"  {output.name}\n")
    assert [command[0] for command in commands] == ["ditto", "pkgbuild"]


@pytest.mark.skipif(os.name == "nt", reason="Native POSIX installer script")
@pytest.mark.parametrize("machine,apple_silicon,expected", [
    ("arm64", True, 0), ("x86_64", True, 0), ("x86_64", False, 1),
])
def test_mac_preinstall_rejects_wrong_chip_including_rosetta(
    tmp_path, machine, apple_silicon, expected,
):
    script = tmp_path / "preinstall"
    script.write_text((ROOT / "scripts/installers/macos-preinstall").read_text()
                      .replace("@TARGET@", "macos-arm64"))
    for name, body in {"uname": f"echo {machine}",
                       "sysctl": f"echo {int(apple_silicon)}", "pgrep": "exit 1"}.items():
        path = tmp_path / name
        path.write_text(f"#!/bin/sh\n{body}\n")
        path.chmod(0o755)
    result = subprocess.run(["sh", str(script), "package", "/Applications", "/"],
                            env={**os.environ, "PATH": f"{tmp_path}:/usr/bin:/bin"},
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == expected, result.stderr
