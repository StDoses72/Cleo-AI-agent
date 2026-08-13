from __future__ import annotations

import hashlib
import json
import os
import subprocess
import zipfile
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name != "nt", reason="The desktop downloader is Windows-only.")
def test_download_script_installs_verified_package_and_reports_completion(
    tmp_path: Path,
) -> None:
    package_root = tmp_path / "package" / "Cleo"
    package_root.mkdir(parents=True)
    (package_root / "Cleo.exe").write_bytes(b"test executable")
    (package_root / "release.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "app": "Cleo",
                "version": "9.8.7",
                "platform": "windows-x64",
            }
        ),
        encoding="utf-8",
    )
    archive = tmp_path / "Cleo-windows-x64.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for path in package_root.iterdir():
            bundle.write(path, f"Cleo/{path.name}")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    install_root = tmp_path / "installed" / "Cleo"
    script = Path(__file__).resolve().parents[2] / "scripts" / "download.ps1"

    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-PackagePath",
            str(archive),
            "-Sha256",
            checksum,
            "-InstallRoot",
            str(install_root),
        ],
        check=True,
        capture_output=True,
        input="\n",
        text=True,
    )

    assert "Cleo download and installation complete." in result.stdout
    assert "Press Enter to close this window" in result.stdout
    assert (install_root / "Cleo.exe").is_file()
    install_metadata = json.loads((install_root / "install.json").read_text(encoding="utf-8-sig"))
    assert install_metadata["version"] == "9.8.7"
    assert install_metadata["sha256"] == checksum
