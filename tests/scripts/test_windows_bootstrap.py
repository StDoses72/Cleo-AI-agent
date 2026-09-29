import json
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows installer bootstrap")


def test_bad_program_checksum_preserves_the_existing_staging_directory(tmp_path):
    bootstrap = tmp_path / "bootstrap"
    bootstrap.mkdir()
    script = bootstrap / "windows-bootstrap.ps1"
    script.write_bytes((ROOT / "scripts/installers/windows-bootstrap.ps1").read_bytes())
    (bootstrap / "bootstrap.json").write_text(json.dumps({
        "archive": "Cleo-windows-x64.zip", "sha256": "a" * 64,
        "url": "https://example.test/program.zip",
    }))
    stage = tmp_path / "Cleo"
    stage.mkdir()
    marker = stage / "preserve.txt"
    marker.write_text("preserve until a verified replacement is available")
    wrapper = tmp_path / "run.ps1"
    wrapper.write_text('''
param($Bootstrap, $Stage, $SourceDirectory)
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
    [IO.File]::WriteAllText($OutFile, 'corrupt archive')
}
& $Bootstrap -Stage $Stage -SourceDirectory $SourceDirectory
''')
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive",
                             "-ExecutionPolicy", "Bypass", "-File", str(wrapper),
                             str(script), str(stage), str(tmp_path)],
                            env={**os.environ, "TEMP": str(tmp_path), "TMP": str(tmp_path)},
                            capture_output=True, timeout=30)
    assert result.returncode != 0
    assert b"SHA-256" in result.stderr
    assert marker.read_text() == "preserve until a verified replacement is available"
