"""Wrap verified portable builds in native graphical installers on the build host."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str | Path) -> None:
    subprocess.run(list(map(str, args)), check=True)


def build(release: Path) -> Path:
    if sys.platform == "win32":
        bundle = release / "Cleo"
        metadata = json.loads((bundle / "release.json").read_text(encoding="utf-8-sig"))
        compiler = shutil.which("ISCC.exe")
        if not compiler:
            compiler = str(Path(os.environ.get("ProgramFiles(x86)", "C:/Program Files (x86)"))
                           / "Inno Setup 6/ISCC.exe")
        if not Path(compiler).is_file():
            raise FileNotFoundError("Inno Setup 6 is required to build the Windows installer.")
        output = release / "Cleo-windows-x64-setup.exe"
        run(compiler, f"/DBundle={bundle}", f"/DOutput={release}",
            f"/DAppVersion={metadata['version']}",
            ROOT / "scripts/installers/windows.iss")
    elif sys.platform == "darwin":
        bundle = release / "Cleo.app"
        metadata = json.loads((bundle / "Contents/Resources/release.json").read_text())
        target = metadata["platform"]
        if target not in {"macos-arm64", "macos-x64"}:
            raise ValueError(f"Unexpected macOS platform: {target}")
        output = release / f"Cleo-{target}.pkg"
        with tempfile.TemporaryDirectory(prefix="cleo-installer-") as temporary:
            scratch = Path(temporary)
            scripts = scratch / "scripts"
            scripts.mkdir()
            for name in ("preinstall", "postinstall"):
                source = ROOT / "scripts/installers" / f"macos-{name}"
                (scripts / name).write_text(source.read_text().replace("@TARGET@", target))
                (scripts / name).chmod(0o755)
            components = scratch / "components.plist"
            with components.open("wb") as stream:
                plistlib.dump([{
                    "RootRelativeBundlePath": "Cleo.app", "BundleIsRelocatable": False,
                    "BundleIsVersionChecked": True, "BundleOverwriteAction": "upgrade",
                    "BundleHasStrictIdentifier": True,
                }], stream)
            # Stage only this app, not the other release archives beside it.
            payload = scratch / "payload"
            payload.mkdir()
            run("ditto", bundle, payload / "Cleo.app")
            run("pkgbuild", "--root", payload, "--component-plist", components,
                "--scripts", scripts, "--identifier", "ai.cleo.desktop",
                "--version", metadata["version"].split("-")[0],
                "--install-location", "/Applications", output)
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
