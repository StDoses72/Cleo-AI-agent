import hashlib
import importlib.util
import io
import json
import re
import urllib.error
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "online_package", Path(__file__).resolve().parents[2] / "scripts/prepare-online-package.py",
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


@pytest.mark.parametrize("platform,target,arch,os_name", [
    ("win32", "windows-x64", "x86_64", "windows"),
    ("darwin", "macos-arm64", "aarch64", "macos"),
    ("darwin", "macos-x64", "x86_64", "macos"),
    ("linux", "linux-x64", "x86_64", "linux"),
])
@pytest.mark.parametrize("metadata_directory", ["uv-python", "uv-python-managed"])
def test_runtime_plan_uses_upstream_hashes_and_omits_bundled_dependencies(
    tmp_path, monkeypatch, platform, target, arch, os_name, metadata_directory,
):
    resources = tmp_path / "resources"
    (resources / "python").mkdir(parents=True)
    (resources / "browser").mkdir()
    for name in ("package.json", "package-lock.json"):
        (resources / "browser" / name).write_text('{}')
    monkeypatch.setattr(builder.sys, "platform", platform)
    key = f"cpython-3.12.14-{os_name}-{arch}-none"
    python_url = "https://github.com/astral-sh/python-build-standalone/python.tar.gz"
    node_os = {"win32": "win", "darwin": "darwin", "linux": "linux"}[platform]
    node_arch = "arm64" if arch == "aarch64" else "x64"
    node_file = f"node-v24.20.0-{node_os}-{node_arch}"
    node_file += ".zip" if platform == "win32" else ".tar.gz"
    payload = b"verified runtime archive"
    digest = hashlib.sha256(payload).hexdigest()

    def output(command, **kwargs):
        if "list" in command:
            return json.dumps([{"key": key, "implementation": "cpython", "variant": "default",
                                "arch": arch, "version": "3.12.14"}])
        if command == ["uv", "--version"]:
            return "uv 0.12.21"
        return "3.12.14" if "-c" in command else "v24.20.0"

    def fetch(url, **kwargs):
        if url.endswith("download-metadata.json"):
            assert url.startswith("https://raw.githubusercontent.com/astral-sh/uv/0.12.21/")
            if f"/crates/{metadata_directory}/" not in url:
                raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
            data = json.dumps({key.replace("-macos-", "-darwin-"): {
                "url": python_url, "sha256": digest,
            }}).encode()
        elif url.endswith("SHASUMS256.txt"):
            data = f"{digest}  {node_file}\n".encode()
        else:
            data = payload
        return io.BytesIO(data)

    def run(command, **kwargs):
        if "build" in command:
            output = Path(command[command.index("--out-dir") + 1])
            (output / "cleo-0.6.0-py3-none-any.whl").write_bytes(b"application code")
        else:
            assert "--only-binary=:all:" in command and "--generate-hashes" in command
            Path(command[command.index("--output-file") + 1]).write_text("locked hashes")

    monkeypatch.setattr(builder.subprocess, "check_output", output)
    monkeypatch.setattr(builder.subprocess, "run", run)
    monkeypatch.setattr(builder.urllib.request, "urlopen", fetch)
    builder.prepare(resources, tmp_path, target)
    plan = json.loads((resources / "runtime-plan.json").read_text())
    assert plan["platform"] == target
    assert plan["python"]["sha256"] == plan["node"]["sha256"] == digest
    assert plan["python"]["url"] == python_url
    assert not (resources / "python").exists()
    assert not (resources / "browser").exists()
    # Installers run these modules outside the app bundle, so every relative import must ship.
    modules = list(resources.rglob("*.mjs"))
    assert resources / "online-runtime.mjs" in modules
    for module in modules:
        for target in re.findall(r"""(?:from|import)\s*\(?\s*["'](\.{1,2}/[^"']+)["']""",
                                 module.read_text(encoding="utf-8")):
            assert (module.parent / target).is_file(), f"{module.name} imports missing {target}"
    assert plan["files"] == {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (resources / "runtime").iterdir()
    }
