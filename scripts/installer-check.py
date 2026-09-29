"""Validate the bundled runtime before offering to open Cleo. No network or user setup."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def check(resources: Path) -> None:
    windows = sys.platform == "win32"
    python = resources / "python" / ("python.exe" if windows else "bin/python3")
    browser = resources / "browser"
    node = browser / ("node.exe" if windows else "node")
    with tempfile.TemporaryDirectory(prefix="cleo-install-check-") as temporary:
        # Desktop startup seeds these defaults before importing its backend.
        shutil.copytree(resources / "defaults/config", Path(temporary) / "config")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("PYTHON", "CLEO_", "DYLD_", "LD_"))}
        env.update(HOME=temporary, USERPROFILE=temporary, CLEO_HOME=temporary,
                   XDG_CONFIG_HOME=temporary, XDG_CACHE_HOME=temporary,
                   XDG_DATA_HOME=temporary, APPDATA=temporary, LOCALAPPDATA=temporary,
                   PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1",
                   PATH=os.pathsep.join((str(python.parent), str(browser), os.defpath)))
        commands = [
            [python, "-I", "-B", "-c",
             "import ssl; ssl.create_default_context(); "
             "from cleo.desktop.server import main; "
             "from cleo.desktop.dependencies import "
             "validate_codex_runtime, validate_claude_runtime; "
             "validate_codex_runtime(); validate_claude_runtime()"],
            [node, "--version"],
            [node, browser / "node_modules/agent-browser/bin/agent-browser.js", "--version"],
        ]
        for command in commands:
            result = subprocess.run(list(map(str, command)), cwd=temporary, env=env,
                                    capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise RuntimeError(f"{command[0].name}: {result.stderr or result.stdout}")
    print("Cleo: bundled Python, Node and backend are ready.")


if __name__ == "__main__":
    try:
        check(Path(__file__).resolve().parent)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Cleo installation check failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
