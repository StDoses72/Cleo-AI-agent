"""Wrap verified portable builds in native graphical installers on the build host."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str | Path) -> None:
    subprocess.run(list(map(str, args)), check=True)


def bootstrap_manifest(release: Path, target: str) -> dict:
    name = "release.json" if target == "windows-x64" else f"release-{target}.json"
    manifest = json.loads((release / name).read_text(encoding="utf-8-sig"))
    version = manifest["version"]
    tag = f"alpha-{version[:-6]}" if version.endswith("-alpha") else f"v{version}"
    return {**manifest, "url": "https://github.com/StDoses72/Cleo-AI-agent/releases/download/"
            f"{tag}/{manifest['archive']}"}


def build(release: Path) -> Path:
    if sys.platform == "win32":
        bundle = release / "Cleo"
        metadata = json.loads((bundle / "release.json").read_text(encoding="utf-8-sig"))
        if not (bundle / "resources/runtime-plan.json").is_file():
            raise ValueError("Build the Windows package with -Online before creating an installer.")
        compiler = shutil.which("ISCC.exe")
        if not compiler:
            compiler = str(Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"))
                           / "Inno Setup 6/ISCC.exe")
        if not Path(compiler).is_file():
            raise FileNotFoundError("Inno Setup 6 is required to build the Windows installer.")
        output = release / "Cleo-windows-x64-setup.exe"
        with tempfile.TemporaryDirectory(prefix="cleo-installer-") as temporary:
            bootstrap = Path(temporary)
            (bootstrap / "bootstrap.json").write_text(
                json.dumps(bootstrap_manifest(release, "windows-x64")))
            shutil.copy2(ROOT / "scripts/installers/windows-bootstrap.ps1", bootstrap)
            size = sum(path.stat().st_size for path in bundle.rglob("*") if path.is_file())
            run(compiler, f"/DBootstrap={bootstrap}", f"/DBundleSize={size}",
                f"/DOutput={release}", f"/DAppVersion={metadata['version']}",
                ROOT / "scripts/installers/windows.iss")
    elif sys.platform == "darwin":
        bundle = release / "Cleo.app"
        metadata = json.loads((bundle / "Contents/Resources/release.json").read_text())
        if not (bundle / "Contents/Resources/runtime-plan.json").is_file():
            raise ValueError("Build the macOS package with --online before creating its installer.")
        target = metadata["platform"]
        if target not in {"macos-arm64", "macos-x64"}:
            raise ValueError(f"Unexpected macOS platform: {target}")
        output = release / f"Cleo-{target}.pkg"
        manifest = bootstrap_manifest(release, target)
        with tempfile.TemporaryDirectory(prefix="cleo-installer-") as temporary:
            scratch = Path(temporary)
            scripts = scratch / "scripts"
            scripts.mkdir()
            for name in ("preinstall", "postinstall"):
                source = ROOT / "scripts/installers" / (
                    "macos-preinstall" if name == "preinstall" else "macos-online-postinstall")
                text = source.read_text().replace("@TARGET@", target)
                for key in ("archive", "sha256", "url"):
                    text = text.replace(f"@{key.upper()}@", manifest[key])
                (scripts / name).write_text(text)
                (scripts / name).chmod(0o755)
            run("pkgbuild", "--nopayload",
                "--scripts", scripts, "--identifier", "ai.cleo.desktop",
                "--version", metadata["version"].split("-")[0], output)
    else:
        raise ValueError("Linux uses the deb already produced by build-release.py.")
    with output.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    output.with_name(output.name + ".sha256").write_text(f"{digest}  {output.name}\n")
    print(f"Installer ready: {output}")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, default=ROOT / "release")
    build(parser.parse_args().release.resolve())
