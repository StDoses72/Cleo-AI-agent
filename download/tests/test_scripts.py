"""Exercise the shipped downloader scripts with local network fixtures."""

import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SITE = Path(__file__).resolve().parents[1] / "site"
PAYLOAD = b"Cleo download fixture"
HASH = hashlib.sha256(PAYLOAD).hexdigest()


class DownloaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cleo-download-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "Downloads with spaces"
        self.output.mkdir()
        self.fixture = {
            "system": "Linux",
            "architecture": "x86_64",
            "apple_silicon": False,
            "version": "v0.3.0",
            "corrupt": False,
            "wrong_name": False,
            "fail_download": False,
        }
        self.config = self.root / "fixture.json"
        self.log = self.root / "requests.txt"

    def run_script(self, expected_success=True):
        self.config.write_text(json.dumps(self.fixture))
        if os.name == "nt":
            script = self.root / "run.ps1"
            script.write_text(
                r"""
param($Source, $Config, $OutputDirectory, $Log)
$ErrorActionPreference = 'Stop'
$fixture = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    return @{ tag_name = $fixture.version; draft = $false; prerelease = $false }
}
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
    Add-Content -LiteralPath $Log -Value $Uri
    if ($Uri.EndsWith('.sha256')) {
        $name = if ($fixture.wrong_name) { 'other.zip' } else { 'Cleo-windows-x64.zip' }
        [IO.File]::WriteAllText($OutFile, 'HASH  ' + $name + "`n")
    } else {
        if ($fixture.fail_download) { throw 'Network fixture failure' }
        $data = if ($fixture.corrupt) { 'corrupt' } else { 'Cleo download fixture' }
        [IO.File]::WriteAllText($OutFile, $data)
    }
}
& ([scriptblock]::Create([IO.File]::ReadAllText($Source))) -OutputDirectory $OutputDirectory
""".replace("HASH", HASH),
                encoding="utf-8",
            )
            powershell = (
                Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            )
            command = [
                str(powershell),
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                str(SITE / "download.ps1"),
                str(self.config),
                str(self.output) + os.sep,
                str(self.log),
            ]
            env = os.environ.copy()
            # Do not pass PowerShell 7 module paths into Windows PowerShell 5.1.
            env = {key: value for key, value in env.items() if key.upper() != "PSMODULEPATH"}
        else:
            bin_dir = self.root / "bin"
            bin_dir.mkdir(exist_ok=True)
            code = (
                f"#!{sys.executable}\n"
                + """
import hashlib, json, os, pathlib, sys
fixture = json.loads(pathlib.Path(os.environ['CLEO_DOWNLOAD_FIXTURE']).read_text())
name = pathlib.Path(sys.argv[0]).name
if name == 'uname':
    print(fixture['system'] if sys.argv[-1] == '-s' else fixture['architecture'])
elif name == 'sysctl':
    print('1' if fixture['apple_silicon'] else '0')
else:
    uri = sys.argv[-1]
    with open(os.environ['CLEO_DOWNLOAD_LOG'], 'a') as log: log.write(uri + '\\n')
    if '-w' in sys.argv:
        base = 'https://github.com/StDoses72/Cleo-AI-agent/releases/tag/'
        print(base + fixture['version'], end='')
    else:
        output = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
        if uri.endswith('.sha256'):
            stem = uri.rsplit('/', 1)[1].removesuffix('.sha256')
            extension = '.tar.gz' if 'linux' in stem else '.zip'
            archive = 'other.zip' if fixture['wrong_name'] else stem + extension
            digest = hashlib.sha256(b'Cleo download fixture').hexdigest()
            output.write_text(digest + '  ' + archive + '\\n')
        else:
            if fixture['fail_download']: sys.exit(22)
            output.write_bytes(b'corrupt' if fixture['corrupt'] else b'Cleo download fixture')
"""
            )
            names = (
                ["curl"] if self.fixture.get("native_detection") else ["uname", "sysctl", "curl"]
            )
            for name in names:
                executable = bin_dir / name
                executable.write_text(code)
                executable.chmod(0o755)
            command = ["sh", str(SITE / "download.sh"), str(self.output)]
            env = dict(
                os.environ,
                PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                CLEO_DOWNLOAD_FIXTURE=str(self.config),
                CLEO_DOWNLOAD_LOG=str(self.log),
            )
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode == 0, expected_success, result.stdout + result.stderr)
        self.assertFalse(
            list(self.output.glob(".cleo-download.*")), "temporary files must always be removed"
        )
        return result

    def test_verified_download_and_existing_identical_file(self):
        self.run_script()
        name = "Cleo-windows-x64.zip" if os.name == "nt" else "Cleo-linux-x64.tar.gz"
        self.assertEqual((self.output / name).read_bytes(), PAYLOAD)
        self.assertIn("Already verified", self.run_script().stdout)
        self.assertTrue(
            all(
                "/download/v0.3.0/" in url or url.endswith("/latest")
                for url in self.log.read_text().splitlines()
            )
        )

    def test_corrupt_download_is_discarded(self):
        self.fixture["corrupt"] = True
        result = self.run_script(False)
        self.assertIn("SHA-256 mismatch", result.stderr)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_network_failure_is_cleaned(self):
        self.fixture["fail_download"] = True
        self.run_script(False)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_wrong_checksum_filename_is_rejected(self):
        self.fixture["wrong_name"] = True
        self.run_script(False)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_existing_different_file_is_preserved(self):
        name = "Cleo-windows-x64.zip" if os.name == "nt" else "Cleo-linux-x64.tar.gz"
        (self.output / name).write_bytes(b"keep this file")
        self.run_script(False)
        self.assertEqual((self.output / name).read_bytes(), b"keep this file")

    @unittest.skipIf(os.name == "nt", "POSIX system detection")
    def test_native_and_rosetta_mac_detection(self):
        self.fixture["system"] = "Darwin"
        for architecture, apple_silicon, target in [
            ("x86_64", False, "x64"),
            ("arm64", True, "arm64"),
            ("x86_64", True, "arm64"),
        ]:
            with self.subTest(architecture=architecture, apple_silicon=apple_silicon):
                self.fixture.update(architecture=architecture, apple_silicon=apple_silicon)
                self.run_script()
                path = self.output / f"Cleo-macos-{target}.zip"
                self.assertEqual(path.read_bytes(), PAYLOAD)
                path.unlink()

    @unittest.skipIf(os.name == "nt", "POSIX system detection")
    def test_actual_host_detection(self):
        self.fixture["native_detection"] = True
        self.run_script()
        if sys.platform == "darwin":
            architecture = "arm64" if platform.machine() == "arm64" else "x64"
            name = f"Cleo-macos-{architecture}.zip"
        else:
            name = "Cleo-linux-x64.tar.gz"
        self.assertEqual((self.output / name).read_bytes(), PAYLOAD)

    @unittest.skipIf(os.name == "nt", "POSIX system detection")
    def test_unsupported_architecture_stops_before_network(self):
        self.fixture["architecture"] = "aarch64"
        self.run_script(False)
        self.assertFalse(self.log.exists())

    def test_invalid_release_is_rejected(self):
        self.fixture["version"] = "v0.3.0/../../other"
        self.run_script(False)
        self.assertEqual(list(self.output.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
