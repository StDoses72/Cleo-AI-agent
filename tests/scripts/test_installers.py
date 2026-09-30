"""Installer checks must fail before success and avoid the user's runtime configuration."""

import importlib.util
import os
import re
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
    (resources / "runtime-plan.json").write_text('{}')
    (tmp_path / "release-macos-arm64.json").write_text(
        '{"platform":"macos-arm64","version":"0.6.1",'
        '"archive":"Cleo-macos-arm64.zip","sha256":"' + "a" * 64 + '"}',
    )
    commands = []

    def run(*command):
        commands.append(command)
        if command[0] != "pkgbuild":
            return
        assert "--nopayload" in command
        scripts = Path(command[command.index("--scripts") + 1])
        assert "'macos-arm64'" in (scripts / "preinstall").read_text()
        assert "hw.optional.arm64" in (scripts / "preinstall").read_text()
        postinstall = (scripts / "postinstall").read_text()
        assert 'online-runtime.mjs" --system' in postinstall
        assert "CLEO_INSTALL_PROGRESS_STDOUT=1 ELECTRON_RUN_AS_NODE=1" in postinstall
        assert "echo 'Cleo installer: Extracting Cleo'" in postinstall
        assert "/v0.6.1/Cleo-macos-arm64.zip" in postinstall
        assert "a" * 64 in postinstall
        assert "previous.app" in postinstall
        Path(command[-1]).write_bytes(b"native package fixture")

    monkeypatch.setattr(builder, "run", run)
    output = builder.build(tmp_path)
    assert output.name == "Cleo-macos-arm64.pkg"
    assert output.with_name(output.name + ".sha256").read_text().endswith(f"  {output.name}\n")
    assert [command[0] for command in commands] == ["pkgbuild"]


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_windows_installer_waits_silently_and_polls_cancellable_progress_interactively():
    script = source("scripts/installers/windows.iss")
    code = script.split("[Code]", 1)[1]
    # No local compiler runs in tests, so check block balance with strings and comments removed.
    stripped = re.sub(r"'(?:[^']|'')*'|\{[^}]*\}|//[^\n]*", "''", code).lower()
    words = re.findall(r"\b(begin|try|case|end)\b", stripped)
    assert words.count("end") * 2 == len(words)
    # ISPP would read a continuation line such as "#13#10 + ..." as a preprocessor directive.
    assert not re.search(r"^\s*#", code, re.MULTILINE)
    # CI installs with /VERYSILENT: keep the blocking wait and its exit code, and touch no UI.
    silent = code.split("if WizardSilent then begin", 1)[1].split("end else", 1)[0]
    assert "StartBootstrap(ewWaitUntilTerminated, ExitCode)" in silent
    assert not re.search(r"RuntimePage|MsgBox|WizardForm", silent)
    assert "Started := RunBootstrapWithProgress(ExitCode)" in code
    assert "StartBootstrap(ewNoWait, ResultCode)" in code
    assert "CreateOutputProgressPage(" in code
    assert "RuntimePage.Hide" in code.split("finally", 1)[1]
    assert "CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);" in code
    assert "Cancel := False;" in code and "WizardForm.CancelButton.Enabled := True;" in code
    # Cancellation asks the bootstrap to stop, force-stops its tree, then removes staging.
    assert "SaveStringToFile(BootstrapFile('cancel')" in code
    assert "'/PID ' + IntToStr(Pid) + ' /T /F'" in code
    assert "DelTree(ExpandConstant('{tmp}\\Cleo'), True, True, True);" in code
    assert "' Failed step: ' + RuntimeStageLabel" in code
    assert "Details are in the log file:" in code and "PreparingLabel" not in code
    start = code.split("function StartBootstrap", 1)[1].split("function ReadExitMarker", 1)[0]
    declared = re.search(r"^param\((.*)\)$", source("scripts/installers/windows-bootstrap.ps1"),
                         re.MULTILINE).group(1)
    assert set(re.findall(r'" (-\w+) "', start)) == {
        f"-{name}" for name in re.findall(r"\[string\]\$(\w+)", declared)}


def test_installer_stage_labels_match_across_platform_scripts():
    table = source("ui/electron/online-runtime.mjs").split("INSTALL_STAGES", 1)[1].split("});")[0]
    stages = dict(re.findall(r'^\s+"?([\w-]+)"?: "([^"]+)",$', table, re.MULTILINE))
    assert list(stages)[:2] == ["program-download", "extract"] and list(stages)[-1] == "done"
    bootstrap = source("scripts/installers/windows-bootstrap.ps1")
    assert dict(re.findall(r"'([\w-]+)' = '([^']+)'", bootstrap)) == {
        key: stages[key] for key in ("program-download", "extract")}
    for name in ("linux-online-postinst", "macos-online-postinstall"):
        script = source(f"scripts/installers/{name}")
        for key in ("program-download", "extract"):
            assert f"echo 'Cleo installer: {stages[key]}'" in script
        assert "CLEO_INSTALL_PROGRESS_STDOUT=1 ELECTRON_RUN_AS_NODE=1" in script
    assert "CLEO_INSTALL_PROGRESS_STDOUT=1" in source("scripts/installers/linux-postinst")


@pytest.mark.skipif(os.name == "nt", reason="Native POSIX installer script")
@pytest.mark.parametrize("machine,apple_silicon,expected", [
    ("arm64", True, 0), ("x86_64", True, 0), ("x86_64", False, 1),
])
def test_mac_preinstall_rejects_wrong_chip_including_rosetta(
    tmp_path, machine, apple_silicon, expected,
):
    script = tmp_path / "preinstall"
    script.write_text((ROOT / "scripts/installers/macos-preinstall").read_text(encoding="utf-8")
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
