from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="The uninstaller is Windows-only.")
SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "uninstall.ps1"


@pytest.fixture
def desktop(tmp_path: Path):
    local = tmp_path / "local" / "Cleo"
    roaming = tmp_path / "roaming" / "Cleo"
    install = tmp_path / "local" / "Programs" / "Cleo"
    files = {
        install / "install.json": json.dumps({"app": "Cleo", "version": "0.4.1"}),
        install / "Cleo.exe": "installed program",
        roaming / "evolution" / "builds" / "old" / "Cleo" / "Cleo.exe": "old program",
        roaming / "evolution" / "downloads" / "old.zip": "old download",
        roaming / "evolution" / "state.json": json.dumps({"active": "old"}),
        roaming / "evolution" / "source" / "draft.py": "uncommitted user work",
        roaming / "evolution" / "source-history-old" / "saved.py": "saved user work",
        roaming / "config" / "cleo.json": "legacy settings",
        local / "runtimes" / "old" / "python.exe": "managed runtime",
        local / "config" / "cleo.json": "current settings",
        local / "data" / "sessions.json": "latest conversation",
        local / "memory" / "MEMORY.md": "personal memory",
        local / "workspace" / "project.txt": "user project",
        tmp_path / "neighbor" / "sentinel": "unrelated data",
    }
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    env = {**os.environ, "APPDATA": str(roaming.parent), "LOCALAPPDATA": str(local.parent)}
    return install, roaming, local, files, env


def uninstall(install: Path, env: dict[str, str], *options: str):
    """Purpose: Run the real uninstaller against an isolated installation fixture.
    Input: Fixture installation, environment and optional uninstall flags.
    Output: Exit status and strictly decoded UTF-8 stdout/stderr.
    """
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", str(SCRIPT), "-InstallRoot", str(install), *options],
        env=env, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )


@pytest.mark.parametrize("purge", [False, True])
def test_uninstall_cleans_programs_and_respects_user_data(desktop, purge: bool) -> None:
    install, roaming, local, files, env = desktop
    result = uninstall(install, env, *(["-PurgeData"] if purge else []))
    assert result.returncode == 0, result.stdout + result.stderr
    removed = [install, roaming / "evolution" / "builds",
               roaming / "evolution" / "downloads", roaming / "evolution" / "state.json",
               local / "runtimes"]
    if purge:
        removed.extend([roaming, local])
    for path in removed:
        assert not path.exists(), f"Uninstall left {path}"
    for path, content in files.items():
        if not any(path.is_relative_to(root) for root in removed):
            assert path.read_text(encoding="utf-8") == content


def test_uninstall_whatif_leaves_programs_and_both_data_roots_unchanged(desktop) -> None:
    install, _, _, files, env = desktop
    result = uninstall(install, env, "-PurgeData", "-WhatIf")
    assert result.returncode == 0, result.stdout + result.stderr
    for path, content in files.items():
        assert path.read_text(encoding="utf-8") == content


def test_uninstall_rejects_an_unmarked_installation_before_touching_data(desktop) -> None:
    install, _, _, files, env = desktop
    marker = install / "install.json"
    marker.unlink()
    result = uninstall(install, env, "-PurgeData")
    assert result.returncode != 0
    assert "unmarked" in result.stderr
    for path, content in files.items():
        if path != marker:
            assert path.read_text(encoding="utf-8") == content


@pytest.mark.parametrize("code_page", [936, 1252])
def test_uninstall_diagnostics_are_utf8_under_legacy_console_encoding(desktop, code_page):
    """Purpose: Preserve readable rejection diagnostics under desktop console encodings.
    Input: Isolated installation fixture and an inherited legacy console code page.
    Output: Strict UTF-8 diagnostics including the original Unicode path; data untouched.
    """
    install, _, _, files, env = desktop
    unmarked = install.parent / "Cleo 测试"
    unmarked.mkdir()
    script = str(SCRIPT).replace("'", "''")
    target = str(unmarked).replace("'", "''")
    command = (
        f"[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding({code_page}); "
        f"& '{script}' -InstallRoot '{target}' -PurgeData"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-Command", command], env=env, capture_output=True, timeout=30,
    )
    assert result.returncode != 0
    error = result.stderr.decode("utf-8")
    assert "unmarked" in error
    assert "Cleo 测试" in error
    for path, content in files.items():
        assert path.read_text(encoding="utf-8") == content


def test_uninstall_rejects_linked_program_storage_before_deleting_anything(desktop) -> None:
    install, roaming, local, files, env = desktop
    link = roaming / "evolution" / "builds" / "linked"
    link_env = {**env, "TEST_LINK": str(link), "TEST_TARGET": str(local / "workspace")}
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
         "New-Item -ItemType Junction -Path $env:TEST_LINK -Target $env:TEST_TARGET"],
        env=link_env, check=True, capture_output=True,
    )
    try:
        result = uninstall(install, env)
        assert result.returncode != 0
        assert "link" in result.stderr.lower()
        for path, content in files.items():
            assert path.read_text(encoding="utf-8") == content
    finally:
        link.rmdir()


@pytest.mark.parametrize("managed", ["evolution", "runtime"])
def test_uninstall_stops_retained_program_processes_only(desktop, managed: str) -> None:
    install, roaming, local, _, env = desktop
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is needed for the standalone test process")
    executable = (roaming / "evolution" / "builds" / "old" / "Cleo" / "Cleo.exe"
                  if managed == "evolution" else local / "runtimes" / "old" / "python.exe")
    shutil.copyfile(node, executable)
    processes = []
    try:
        for command in (executable, node):
            process = subprocess.Popen(
                [str(command), "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            processes.append(process)
            assert process.stdout.readline().strip() == b"ready"
        result = uninstall(install, env)
        assert result.returncode == 0, result.stdout + result.stderr
        assert processes[0].poll() is not None, "Retained program was not stopped"
        assert processes[1].poll() is None, "An unrelated process was stopped"
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            process.stdout.close()
            process.stderr.close()
