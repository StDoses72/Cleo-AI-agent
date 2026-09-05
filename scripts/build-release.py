"""Native macOS/Linux desktop packages with an independent Python and Node runtime."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*args: str | Path, cwd: Path, env: dict[str, str] | None = None) -> None:
    print("+", " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def locked_version(package: str) -> str:
    match = re.search(
        rf"^{re.escape(package)}==([^;\s]+)", (ROOT / "requirements.txt").read_text(), re.MULTILINE
    )
    if not match:
        raise ValueError(f"Missing locked dependency: {package}")
    return match[1]


def download(url: str, path: Path) -> None:
    print(f"Downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, path.open("wb") as output:
        shutil.copyfileobj(response, output)


def package_macos(bundle: Path, version: str, icon: Path, scratch: Path) -> None:
    contents = bundle / "Contents"
    (contents / "MacOS" / "Electron").rename(contents / "MacOS" / "Cleo")
    info_path = contents / "Info.plist"
    with info_path.open("rb") as stream:
        info = plistlib.load(stream)
    info.update(
        CFBundleExecutable="Cleo",
        CFBundleName="Cleo",
        CFBundleDisplayName="Cleo",
        CFBundleIdentifier="ai.cleo.desktop",
        CFBundleVersion=version.split("-")[0],
        CFBundleShortVersionString=version.split("-")[0],
        CFBundleIconFile="cleo.icns",
    )
    with info_path.open("wb") as stream:
        plistlib.dump(info, stream)
    iconset = scratch / "cleo.iconset"
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = "@2x" if scale == 2 else ""
            run(
                "sips",
                "-z",
                str(size * scale),
                str(size * scale),
                icon,
                "--out",
                iconset / f"icon_{size}x{size}{suffix}.png",
                cwd=scratch,
            )
    run("iconutil", "-c", "icns", iconset, "-o", contents / "Resources" / "cleo.icns", cwd=scratch)
    # These are explicitly local/development artifacts. Developer ID signing and
    # notarization require release credentials and are documented separately.
    run("codesign", "--force", "--deep", "--sign", "-", bundle, cwd=scratch)
    run("codesign", "--verify", "--deep", "--strict", bundle, cwd=scratch)


def build() -> None:
    if sys.platform not in {"darwin", "linux"}:
        raise SystemExit("Use build-release.ps1 on Windows.")
    node = shutil.which("node")
    if not node or not shutil.which("npm") or not shutil.which("uv"):
        raise SystemExit("Building requires Node.js 24+, npm and uv on PATH.")
    if (
        int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True))
        < 24
    ):
        raise SystemExit("Node.js 24 or newer is required for the bundled browser runtime.")
    module = (ROOT / "ui/electron/platform.mjs").as_uri()
    target = json.loads(
        subprocess.check_output(
            [
                node,
                "--input-type=module",
                "-e",
                f"import {{desktopPlatform}} from {json.dumps(module)}; "
                "console.log(JSON.stringify(desktopPlatform()));",
            ],
            text=True,
        )
    )
    machine = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    if machine != target["arch"]:
        raise ValueError(
            "Node and Python must use the same architecture; cross-building is not supported."
        )
    source_package = json.loads((ROOT / "ui/package.json").read_text())
    version = source_package["version"]
    electron = source_package["devDependencies"]["electron"]
    release = ROOT / "release"
    release.mkdir(exist_ok=True)
    scratch_parent = ROOT / ".release-build"
    scratch_parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="native-", dir=scratch_parent) as temporary:
        scratch = Path(temporary)
        ui = scratch / "ui"
        ui.mkdir()
        for name in (
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "vite.config.ts",
            "index.html",
            "src",
            "public",
            "electron",
        ):
            source = ROOT / "ui" / name
            if source.is_dir():
                shutil.copytree(source, ui / name)
            else:
                shutil.copy2(source, ui / name)
        env = {**os.environ, "ELECTRON_SKIP_BINARY_DOWNLOAD": "1"}
        run("npm", "ci", "--no-audit", "--no-fund", cwd=ui, env=env)
        run("npm", "run", "build", cwd=ui)
        archive_name = f"electron-v{electron}-{target['platform']}-{target['arch']}.zip"
        base = f"https://github.com/electron/electron/releases/download/v{electron}"
        electron_archive = scratch / archive_name
        checksums = scratch / "SHASUMS256.txt"
        download(f"{base}/{archive_name}", electron_archive)
        download(f"{base}/SHASUMS256.txt", checksums)
        expected = next(
            line.split()[0]
            for line in checksums.read_text().splitlines()
            if line.split()[-1].lstrip("*") == archive_name
        )
        with electron_archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise ValueError("Electron archive checksum mismatch")
        distribution = scratch / "electron"
        distribution.mkdir()
        if sys.platform == "darwin":
            run("ditto", "-x", "-k", electron_archive, distribution, cwd=scratch)
            bundle = distribution / "Electron.app"
        else:
            run("unzip", "-q", electron_archive, "-d", distribution, cwd=scratch)
            bundle = distribution
            (bundle / "electron").rename(bundle / "Cleo")
        staged_bundle = scratch / target["bundle"]
        bundle.rename(staged_bundle)
        resources = staged_bundle / target["resources"]
        (resources / "default_app.asar").unlink(missing_ok=True)
        shutil.copy2(ui / "public/cleo.png", resources / "cleo.png")
        staging = scratch / "app-staging"
        staging.mkdir()
        for name in ("electron", "dist"):
            shutil.copytree(ui / name, staging / name)
        shutil.copy2(ui / "package.json", staging / "package.json")
        run(ui / "node_modules/.bin/asar", "pack", staging, resources / "app.asar", cwd=ui)
        python_source = scratch / "python-source"
        python_source.mkdir()
        for name in ("pyproject.toml", "README.md", "main.py", "LICENSE"):
            if (ROOT / name).exists():
                shutil.copy2(ROOT / name, python_source / name)
        shutil.copytree(
            ROOT / "cleo",
            python_source / "cleo",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        python_install = scratch / "python-install"
        run(
            "uv",
            "python",
            "install",
            "3.12",
            "--install-dir",
            python_install,
            "--no-bin",
            "--no-registry",
            cwd=scratch,
        )
        python = next(python_install.glob("*/bin/python3"))
        runtime_machine = (
            subprocess.check_output(
                [python, "-c", "import platform; print(platform.machine())"], text=True
            )
            .strip()
            .lower()
        )
        runtime_arch = {"x86_64": "x64", "aarch64": "arm64"}.get(runtime_machine, runtime_machine)
        if runtime_arch != target["arch"]:
            raise ValueError(
                "The downloaded Python architecture does not match the desktop target."
            )
        run(
            "uv",
            "pip",
            "install",
            "--python",
            python,
            "--break-system-packages",
            "--compile-bytecode",
            python_source,
            f"claude-agent-sdk=={locked_version('claude-agent-sdk')}",
            f"openai-codex-cli-bin=={locked_version('openai-codex-cli-bin')}",
            cwd=scratch,
        )
        shutil.copytree(python.parent.parent, resources / "python", symlinks=True)
        # Console entry points must not retain the temporary build interpreter path.
        for script in (resources / "python/bin").iterdir():
            if script.is_symlink() or not script.is_file():
                continue
            data = script.read_bytes()
            if data.startswith(b"#!") and bytes(python_install) in data.split(b"\n", 1)[0]:
                script.write_bytes(b"#!/usr/bin/env python3\n" + data.split(b"\n", 1)[1])
        browser = resources / "browser"
        browser.mkdir()
        run(
            "npm",
            "install",
            "--prefix",
            browser,
            "--no-audit",
            "--no-fund",
            "--omit",
            "dev",
            "agent-browser@0.33.1",
            cwd=scratch,
        )
        shutil.copy2(Path(node).resolve(), browser / "node")
        update = resources / "update"
        update.mkdir()
        for name in ("posix-installer.mjs", "platform.mjs"):
            shutil.copy2(ROOT / "ui/electron" / name, update / name)
        defaults = resources / "defaults"
        for name in ("assets", "config", "memory"):
            (defaults / name).mkdir(parents=True, exist_ok=True)
        for source, destination in (
            ("cleo/images/assets/cleo-startup.png", "assets/startup.png"),
            ("cleo/config/templates/cleo.example.json", "config/cleo.json"),
            ("cleo/config/templates/harnesses.example.json", "config/harnesses.json"),
            ("memory/MEMORY_POLICY.md", "memory/MEMORY_POLICY.md"),
            ("AGENTS.md", "AGENTS.md"),
            ("PERSONA.md", "PERSONA.md"),
        ):
            shutil.copy2(ROOT / source, defaults / destination)
        if (ROOT / "skills").exists():
            shutil.copytree(ROOT / "skills", defaults / "skills")
        metadata = {
            "schema_version": 1,
            "app": "Cleo",
            "version": version,
            "platform": target["id"],
            "python": "3.12",
            "agent_browser": "0.33.1",
            "created_at": datetime.now(UTC).isoformat(),
        }
        metadata_file = (
            resources / "release.json"
            if sys.platform == "darwin"
            else staged_bundle / "release.json"
        )
        metadata_file.write_text(json.dumps(metadata, indent=2) + "\n")
        if sys.platform == "darwin":
            package_macos(staged_bundle, version, ui / "public/cleo.png", scratch)
        final = release / target["bundle"]
        if final.exists():
            raise FileExistsError(
                f"Move the previous build out of the way before building: {final}"
            )
        staged_bundle.rename(final)
        archive = release / target["archive"]
        if sys.platform == "darwin":
            run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", final, archive, cwd=release)
        else:
            run("tar", "-czf", archive, target["bundle"], cwd=release)
        with archive.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        checksum = release / (
            target["archive"].removesuffix(".tar.gz").removesuffix(".zip") + ".sha256"
        )
        checksum.write_text(f"{digest}  {target['archive']}\n")
        metadata.update(archive=target["archive"], sha256=digest, bytes=archive.stat().st_size)
        (release / target["manifest"]).write_text(json.dumps(metadata, indent=2) + "\n")
        if sys.platform == "linux":
            deb = scratch / "deb"
            installed = deb / "opt/Cleo"
            shutil.copytree(final, installed, symlinks=True)
            (installed / "chrome-sandbox").chmod(0o4755)
            (installed / "resources/package-manager").write_text("deb\n")
            control = deb / "DEBIAN"
            control.mkdir(parents=True)
            (control / "control").write_text(
                f"Package: cleo-desktop\nVersion: {version}\nArchitecture: amd64\n"
                "Maintainer: Cleo contributors\nSection: utils\nPriority: optional\n"
                "Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libgbm1, "
                "libasound2 | libasound2t64, libxss1, libxtst6, libx11-xcb1\n"
                "Description: Cleo local AI workspace\n"
            )
            applications = deb / "usr/share/applications"
            applications.mkdir(parents=True)
            (applications / "cleo.desktop").write_text(
                "[Desktop Entry]\nType=Application\nName=Cleo\n"
                "Exec=/opt/Cleo/Cleo --class=Cleo\nIcon=cleo\nTerminal=false\n"
                "Categories=Development;Utility;\nStartupWMClass=Cleo\n"
            )
            icons = deb / "usr/share/icons/hicolor/256x256/apps"
            icons.mkdir(parents=True)
            shutil.copy2(ui / "public/cleo.png", icons / "cleo.png")
            run(
                "dpkg-deb",
                "--root-owner-group",
                "--build",
                deb,
                release / "Cleo-linux-x64.deb",
                cwd=scratch,
            )
            deb_archive = release / "Cleo-linux-x64.deb"
            with deb_archive.open("rb") as stream:
                deb_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            (release / "Cleo-linux-x64.deb.sha256").write_text(f"{deb_hash}  {deb_archive.name}\n")
        print(f"Ready: {archive}", flush=True)


if __name__ == "__main__":
    build()
