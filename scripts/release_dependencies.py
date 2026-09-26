"""Record and verify the dependency snapshot used by a packaged desktop app."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from packaging.requirements import Requirement

LOCKS = ("requirements.txt", "ui/package-lock.json", "ui/runtime/package-lock.json")


def record(root: Path, python: Path, browser: Path, output: Path) -> None:
    packages = json.loads(subprocess.check_output([
        str(python), "-I", "-c",
        "import json, importlib.metadata as m; "
        "from cleo.desktop.dependencies import validate_claude_runtime, validate_codex_runtime; "
        "validate_codex_runtime(); validate_claude_runtime(); "
        "print(json.dumps({d.metadata['Name'].lower().replace('_','-'): "
        "d.version for d in m.distributions()}))",
    ], text=True, timeout=60))
    wanted = {}
    for line in (root / "requirements.txt").read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        requirement = Requirement(line)
        if requirement.marker is None or requirement.marker.evaluate():
            wanted[requirement.name] = next(iter(requirement.specifier)).version
    for name in ("openai-codex", "openai-codex-cli-bin", "claude-agent-sdk"):
        if packages.get(name) != wanted.get(name) or name not in wanted:
            raise ValueError(f"Packaged {name} does not match the resolved dependency lock")
    tools = {}
    runtime_lock = json.loads((root / "ui/runtime/package-lock.json").read_text())
    for name in ("@openai/codex", "agent-browser", "npm"):
        installed = json.loads((browser / "node_modules" / name / "package.json").read_text())
        if installed["version"] != runtime_lock["packages"][f"node_modules/{name}"]["version"]:
            raise ValueError(f"Packaged {name} does not match the resolved dependency lock")
        tools[name] = installed["version"]
    receipt = {
        "schema_version": 1,
        "lock_sha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                        for name in LOCKS},
        "python_packages": packages,
        "tools": tools,
    }
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--browser", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    record(args.root, args.python, args.browser, args.output)
