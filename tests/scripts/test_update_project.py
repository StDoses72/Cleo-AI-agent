import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

import pytest


def test_node_locks_remain_portable_with_a_symlinked_temporary_directory(tmp_path, monkeypatch):
    if shutil.which("npm.cmd" if os.name == "nt" else "npm") is None:
        pytest.skip("npm is not installed")
    real = tmp_path / "real"
    real.mkdir()
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(real, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            pytest.skip("Creating directory symlinks is not permitted on this host")
        subprocess.run(["cmd", "/c", "mklink", "/J", str(alias), str(real)],
                       check=True, capture_output=True)
    package = tmp_path / "fixture.tgz"
    content = json.dumps({"name": "cleo-lock-fixture", "version": "1.0.0"}).encode()
    with tarfile.open(package, "w:gz") as archive:
        info = tarfile.TarInfo("package/package.json")
        info.size = len(content)
        archive.addfile(info, io.BytesIO(content))
    root = tmp_path / "project"
    for relative in ("ui", "ui/runtime"):
        path = root / relative
        path.mkdir(parents=True)
        manifest = {"name": "lock-test", "version": "1.0.0",
                    "dependencies": {"cleo-lock-fixture": package.as_uri()}}
        (path / "package.json").write_text(json.dumps(manifest))
        (path / "package-lock.json").write_text(json.dumps({
            "name": "lock-test", "version": "1.0.0", "lockfileVersion": 3,
            "packages": {"": manifest},
        }))
    spec = importlib.util.spec_from_file_location(
        "update_project", Path(__file__).resolve().parents[2] / "scripts/update_project.py",
    )
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    original_temporary_directory = tempfile.TemporaryDirectory
    monkeypatch.setattr(updater, "PROJECT_ROOT", root)
    monkeypatch.setattr(updater.tempfile, "TemporaryDirectory", lambda **kwargs:
                        original_temporary_directory(dir=alias, **kwargs))
    monkeypatch.setenv("npm_config_cache", str(tmp_path / "npm-cache"))
    assert updater._update_node_dependencies(check_only=False)
    for relative in ("ui", "ui/runtime"):
        lock = json.loads((root / relative / "package-lock.json").read_text())
        assert "node_modules/cleo-lock-fixture" in lock["packages"]
        assert not any(key.startswith("..") for key in lock["packages"])
