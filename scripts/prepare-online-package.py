"""Replace bundled dependencies with a reproducible, checksummed installation plan."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def artifact(url: str, version: str, expected: str, scratch: Path) -> dict:
    name = url.rsplit("/", 1)[1]
    path = scratch / name
    with urllib.request.urlopen(url, timeout=120) as response, path.open("wb") as stream:
        shutil.copyfileobj(response, stream)
    if sha(path) != expected:
        raise ValueError(f"Runtime archive checksum mismatch: {name}")
    return {"archive": name, "url": url, "version": version,
            "sha256": expected, "bytes": path.stat().st_size}


def prepare(resources: Path, source: Path, target: str) -> None:
    python = resources / "python" / ("python.exe" if sys.platform == "win32" else "bin/python3")
    node = resources / "browser" / ("node.exe" if sys.platform == "win32" else "node")
    python_version = subprocess.check_output(
        [python, "-I", "-c", "import platform; print(platform.python_version())"],
        text=True).strip()
    node_version = subprocess.check_output([node, "--version"], text=True).strip().removeprefix("v")
    candidates = json.loads(subprocess.check_output(
        ["uv", "python", "list", python_version, "--only-downloads", "--output-format", "json"],
        text=True))
    arch = "aarch64" if target.endswith("arm64") else "x86_64"
    candidate = next(item for item in candidates
                     if item["implementation"] == "cpython" and item["variant"] == "default"
                     and item["arch"] == arch and item["version"] == python_version)
    uv_version = subprocess.check_output(["uv", "--version"], text=True).split()[1]
    metadata_url = (f"https://raw.githubusercontent.com/astral-sh/uv/{uv_version}/"
                    "crates/uv-python/download-metadata.json")
    with urllib.request.urlopen(metadata_url, timeout=60) as response:
        python_metadata = json.load(response)[candidate["key"].replace("-macos-", "-darwin-")]
    python_url, python_sha = python_metadata["url"], python_metadata["sha256"]
    node_platform = {"win32": "win", "darwin": "darwin", "linux": "linux"}[sys.platform]
    node_arch = "arm64" if target.endswith("arm64") else "x64"
    node_file = f"node-v{node_version}-{node_platform}-{node_arch}"
    node_file += ".zip" if sys.platform == "win32" else ".tar.gz"
    node_base = f"https://nodejs.org/dist/v{node_version}"
    with urllib.request.urlopen(node_base + "/SHASUMS256.txt", timeout=60) as response:
        node_sha = next(line.split()[0] for line in response.read().decode().splitlines()
                        if line.split()[-1] == node_file)
    runtime = resources / "runtime"
    runtime.mkdir()
    subprocess.run(["uv", "build", "--wheel", "--out-dir", str(runtime), str(source)], check=True)
    subprocess.run(["uv", "pip", "compile", str(ROOT / "pyproject.toml"),
                    "--constraint", str(ROOT / "requirements.txt"), "--universal",
                    "--python-version", "3.12", "--only-binary=:all:", "--generate-hashes",
                    "--no-header", "--no-annotate", "--no-emit-index-url",
                    "--output-file", str(runtime / "requirements.txt")], check=True,
                   stdout=subprocess.DEVNULL)
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(resources / "browser" / name, runtime / name)
    wheel = next(runtime.glob("*.whl"))
    metadata = json.loads((ROOT / "ui/package.json").read_text())
    with tempfile.TemporaryDirectory(prefix="cleo-runtime-plan-") as temporary:
        scratch = Path(temporary)
        python_artifact = artifact(python_url, python_version, python_sha, scratch)
        python_artifact["archive"] = "python.tar.gz"
        plan = {"schema": 1, "version": metadata["version"], "platform": target,
                "python": python_artifact,
                "node": artifact(f"{node_base}/{node_file}", node_version, node_sha, scratch),
                "wheel": {"archive": wheel.name},
                "files": {path.name: sha(path) for path in runtime.iterdir()}}
    # platform.mjs imports computer/startup.mjs, which imports computer/schemes.mjs.
    for name in ("online-runtime.mjs", "release-downloads.mjs", "platform.mjs",
                 "evolution-tools.mjs", "evolution-store.mjs",
                 "computer/startup.mjs", "computer/schemes.mjs"):
        (resources / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "ui/electron" / name, resources / name)
    (resources / "runtime-plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    # Only these two builder-owned runtime directories are omitted from the release.
    shutil.rmtree(resources / "python")
    shutil.rmtree(resources / "browser")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    prepare(args.resources.resolve(), args.source.resolve(), args.target)
