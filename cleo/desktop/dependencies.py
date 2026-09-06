"""Prepare independent desktop runtimes; the next app launch selects a validated snapshot."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path


def run(command: list[str | Path], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        list(map(str, command)), cwd=cwd, check=True, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=900,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return result.stdout


def python_executable(root: Path) -> Path:
    if os.name != "nt":
        return root / "bin/python3"
    return root / ("Scripts/python.exe" if (root / "pyvenv.cfg").exists() else "python.exe")


def codex_executable(browser: Path) -> Path:
    name = "codex.exe" if os.name == "nt" else "codex"
    matches = list((browser / "node_modules/@openai").rglob(name))
    matches = [path for path in matches if path.is_file()]
    if len(matches) != 1:
        raise RuntimeError("The Codex package must contain one native runtime for this platform.")
    return matches[0]


def write_state(root: Path, state: dict) -> None:
    temporary = root / "state.json.tmp"
    temporary.write_text(json.dumps(state) + "\n", encoding="utf-8")
    temporary.replace(root / "state.json")


def read_state(root: Path) -> dict:
    try:
        value = json.loads((root / "state.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def snapshot_path(root: Path, identifier: str | None) -> Path | None:
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
        return None
    path = root / identifier
    if path.is_symlink() or path.resolve().parent != root.resolve():
        return None
    return path


def remove_snapshot(root: Path, path: Path) -> None:
    if snapshot_path(root, path.name) != path:
        raise ValueError(f"Refusing to remove an unmanaged runtime: {path}")
    shutil.rmtree(path)


def create_python_runtime(source: Path, destination: Path) -> None:
    # Reuse the immutable bundled interpreter; each snapshot has isolated dependencies.
    run([sys.executable, "-I", "-m", "uv", "venv", "--python",
         python_executable(source), destination])
    relative = Path("Lib/site-packages" if os.name == "nt" else
                    f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages")
    packages = source / relative
    target = destination / relative
    target.mkdir(parents=True, exist_ok=True)
    for entry in (packages / "cleo", *packages.glob("cleo_ai_agent-*.dist-info")):
        if entry.is_dir():
            shutil.copytree(entry, target / entry.name,
                            ignore=shutil.ignore_patterns("__pycache__"))


def validate_runtime(python: Path, browser: Path) -> None:
    run([python, "-I", "-c", (
        "from cleo.desktop.service import DesktopService; "
        "from deepagents import create_deep_agent; "
        "from deepagents.backends import CompositeBackend, FilesystemBackend; "
        "from langchain.chat_models import init_chat_model; "
        "from langgraph.checkpoint.memory import InMemorySaver; "
        "from cleo.integrations.harnesses.codex import CodexProvider; "
        "from cleo.integrations.harnesses.claude import ClaudeProvider; "
        "from cleo.mcp.memory_server import create_server; "
        "from openai_codex.api import AsyncTurnHandle; "
        "from openai_codex import AsyncCodex, CodexConfig; "
        "assert hasattr(AsyncCodex, 'models')"
    )])
    run([sys.executable, "-I", "-m", "uv", "pip", "check", "--python", python])
    run([codex_executable(browser), "--version"])
    node = browser / ("node.exe" if os.name == "nt" else "node")
    run([node, browser / "node_modules/agent-browser/bin/agent-browser.js", "--version"])


def update(root: Path, base_python: Path, base_browser: Path, current: str | None) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    state = read_state(root)
    if snapshot_path(root, state.get("active")) is None:
        state.pop("active", None)
    # Keep both the runtime used by this app process and an update awaiting restart.
    retained = {current, state.get("active")}
    for path in root.iterdir():
        if snapshot_path(root, path.name) and path.is_dir() and path.name not in retained:
            remove_snapshot(root, path)
    checked_at = state.get("checkedAt", 0)
    if isinstance(checked_at, (int, float)) and 0 <= time.time() - checked_at < 24 * 60 * 60:
        return state

    active = snapshot_path(root, state.get("active"))
    source_python = active / "python" if active and active.is_dir() else base_python
    source_browser = active / "browser" if active and active.is_dir() else base_browser
    python = python_executable(source_python)
    node = source_browser / ("node.exe" if os.name == "nt" else "node")
    npm = source_browser / "node_modules/npm/bin/npm-cli.js"
    state.update(phase="checking", error=None, checkedAt=time.time())
    write_state(root, state)
    candidate = None
    try:
        with tempfile.TemporaryDirectory(prefix="cleo-dependencies-") as temporary:
            scratch = Path(temporary)
            requirements = scratch / "requirements.in"
            # Read the immutable app's requirements, never the updater's own environment.
            requirements.write_text("\n".join(
                item for item in importlib.metadata.requires("cleo-ai-agent") or []
                if "extra ==" not in item
            ), encoding="utf-8")
            lock = scratch / "requirements.txt"
            run([
                sys.executable, "-I", "-m", "uv", "pip", "compile", "--upgrade",
                "--python", python, "--no-header", "--no-annotate", "--no-emit-index-url",
                "--output-file", lock, requirements,
            ])
            installed = json.loads(run([python, "-I", "-c", (
                "import json, importlib.metadata as m; "
                "print(json.dumps({d.metadata['Name'].lower().replace('_','-'): "
                "d.version for d in m.distributions()}))"
            )]))
            wanted = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s;]+)", lock.read_text(), re.M))
            python_changed = any(installed.get(name.lower()) != version
                                 for name, version in wanted.items())
            browser_plan = scratch / "browser"
            browser_plan.mkdir()
            for name in ("package.json", "package-lock.json"):
                shutil.copy2(source_browser / name, browser_plan / name)
            run([node, npm, "update", "--package-lock-only", "--ignore-scripts",
                 "--no-audit", "--no-fund", "--prefer-online"], cwd=browser_plan)
            browser_changed = (
                json.loads((browser_plan / "package-lock.json").read_text())
                != json.loads((source_browser / "package-lock.json").read_text())
            )
            if not python_changed and not browser_changed:
                state.update(phase="up-to-date")
                write_state(root, state)
                return state
            state.update(phase="updating")
            write_state(root, state)
            candidate = root / uuid.uuid4().hex
            candidate.mkdir()
            create_python_runtime(base_python, candidate / "python")
            (candidate / "browser").mkdir()
            shutil.copy2(node, candidate / "browser" / node.name)
            target_python = python_executable(candidate / "python")
            run([sys.executable, "-I", "-m", "uv", "pip", "install", "--python",
                 target_python, "--break-system-packages", "--upgrade", "-r", lock])
            for name in ("package.json", "package-lock.json"):
                shutil.copy2(browser_plan / name, candidate / "browser" / name)
            run([node, npm, "ci", "--no-audit", "--no-fund"], cwd=candidate / "browser")
            validate_runtime(target_python, candidate / "browser")
            # The pointer is published only after installation and validation finish.
            state.update(active=candidate.name, phase="ready", error=None)
            write_state(root, state)
            candidate = None
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        state.update(phase="error", error=str(detail)[-3000:])
        write_state(root, state)
    finally:
        if candidate is not None:
            remove_snapshot(root, candidate)
    return state


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--python-root", type=Path, required=True)
    parser.add_argument("--browser-root", type=Path, required=True)
    parser.add_argument("--current")
    args = parser.parse_args()
    result = update(args.root, args.python_root, args.browser_root, args.current)
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
