import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import zipfile
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows installer bootstrap")
POWERSHELL = (Path(os.environ.get("SystemRoot", "C:/Windows"))
              / "System32/WindowsPowerShell/v1.0/powershell.exe")
FAKE_RUNTIME = """
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const keys = ["ELECTRON_RUN_AS_NODE", "CLEO_INSTALL_PROGRESS", "CLEO_INSTALL_CANCEL"];
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const seen = Object.fromEntries(keys.map(key => [key, process.env[key]]));
writeFileSync(join(root, "runtime-env.json"), JSON.stringify(seen));
if (existsSync(join(root, "hold"))) {
  // Like online-runtime.mjs, stop only when the installer asks through the cancel file.
  const timer = setInterval(() => {
    if (!existsSync(process.env.CLEO_INSTALL_CANCEL)) return;
    clearInterval(timer);
    process.exitCode = 1;
  }, 50);
} else {
  const progress = { stage: "done", label: "Runtime ready" };
  try { writeFileSync(process.env.CLEO_INSTALL_PROGRESS, JSON.stringify(progress)); } catch {}
  console.log("fake runtime ran");
}
"""


@contextmanager
def serve(payload, *, stall=None):
    """Serve one archive locally; with a stall event, pause after the first chunk until set."""
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                if stall is None:
                    self.wfile.write(payload)
                else:
                    self.wfile.write(payload[:65536])
                    self.wfile.flush()
                    stall.wait(30)
                    self.wfile.write(payload[65536:])
            except OSError:
                pass

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/Cleo-windows-x64.zip"
    finally:
        if stall is not None:
            stall.set()
        server.shutdown()
        server.server_close()


def prepare(tmp_path, payload, url, *, digest=None):
    bootstrap = tmp_path / "bootstrap"
    bootstrap.mkdir()
    script = bootstrap / "windows-bootstrap.ps1"
    script.write_bytes((ROOT / "scripts/installers/windows-bootstrap.ps1").read_bytes())
    (bootstrap / "bootstrap.json").write_text(json.dumps({
        "archive": "Cleo-windows-x64.zip", "sha256": digest or hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload), "url": url,
    }))
    return bootstrap


def command(tmp_path, bootstrap, *, source=None, progress=None):
    return [str(POWERSHELL), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(bootstrap / "windows-bootstrap.ps1"), "-Stage", str(tmp_path / "Cleo"),
            "-SourceDirectory", str(source or tmp_path / "empty"),
            "-Progress", str(progress or bootstrap / "progress.json"),
            "-Cancel", str(bootstrap / "cancel"), "-Log", str(tmp_path / "install.log")]


def environment(tmp_path):
    return {**os.environ, "TEMP": str(tmp_path), "TMP": str(tmp_path)}


@pytest.fixture(scope="module")
def program(tmp_path_factory):
    node = shutil.which("node")
    if not node or not node.lower().endswith(".exe"):
        pytest.skip("A node.exe stands in for the packaged Cleo.exe")
    archive = tmp_path_factory.mktemp("program") / "Cleo-windows-x64.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
        bundle.write(node, "Cleo/Cleo.exe")
        bundle.writestr("Cleo/resources/online-runtime.mjs", FAKE_RUNTIME)
    return archive.read_bytes()


def test_bad_program_checksum_preserves_the_existing_staging_directory(tmp_path):
    payload = b"corrupt archive" * 10000
    stage = tmp_path / "Cleo"
    stage.mkdir()
    marker = stage / "preserve.txt"
    marker.write_text("preserve until a verified replacement is available")
    with serve(payload) as url:
        bootstrap = prepare(tmp_path, payload, url, digest="a" * 64)
        result = subprocess.run(command(tmp_path, bootstrap), env=environment(tmp_path),
                                capture_output=True, timeout=60)
    assert result.returncode != 0
    assert b"SHA-256" in result.stderr
    assert marker.read_text() == "preserve until a verified replacement is available"
    progress = json.loads((bootstrap / "progress.json").read_text())
    assert progress["stage"] == "program-download" and progress["label"] == "Downloading Cleo"
    assert progress["bytes"] == progress["totalBytes"] == len(payload)
    assert "SHA-256" in (tmp_path / "install.log").read_text()
    assert (bootstrap / "bootstrap.exit").read_text() == "1"
    assert int((bootstrap / "bootstrap.pid").read_text()) > 0
    assert not list(bootstrap.glob("progress.json.*"))
    assert not (bootstrap / "program.zip.partial").exists()


@pytest.mark.parametrize("nearby", [False, True])
def test_streamed_or_nearby_program_runs_the_runtime_with_the_progress_and_cancel_files(
    tmp_path, program, nearby,
):
    source = tmp_path / "source"
    source.mkdir()
    if nearby:
        (source / "Cleo-windows-x64.zip").write_bytes(program)
    with serve(program) as url:
        bootstrap = prepare(tmp_path, program, "http://127.0.0.1:9/offline.zip" if nearby else url)
        # A progress file that cannot be written never affects installation.
        progress = tmp_path / "missing" / "progress.json" if nearby else bootstrap / "progress.json"
        result = subprocess.run(command(tmp_path, bootstrap, source=source, progress=progress),
                                env=environment(tmp_path), capture_output=True, timeout=180)
    assert result.returncode == 0, result.stderr.decode(errors="replace")
    assert (tmp_path / "Cleo/Cleo.exe").is_file()
    runtime = json.loads((tmp_path / "runtime-env.json").read_text())
    assert runtime == {"ELECTRON_RUN_AS_NODE": "1", "CLEO_INSTALL_PROGRESS": str(progress),
                       "CLEO_INSTALL_CANCEL": str(bootstrap / "cancel")}
    log = (tmp_path / "install.log").read_text()
    assert "fake runtime ran" in log and "ready to install" in log
    assert (bootstrap / "bootstrap.exit").read_text() == "0"
    if not nearby:
        assert json.loads(progress.read_text())["stage"] == "done"


def wait_for(condition, message):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if condition():
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    pytest.fail(message)


def test_cancel_file_stops_a_download_and_removes_the_partial_archive(tmp_path):
    payload = os.urandom(1024 * 1024)
    stall = threading.Event()
    with serve(payload, stall=stall) as url:
        bootstrap = prepare(tmp_path, payload, url)
        process = subprocess.Popen(command(tmp_path, bootstrap), env=environment(tmp_path),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            wait_for(lambda: json.loads((bootstrap / "progress.json").read_text()).get("bytes"),
                     "The download never reported progress.")
            (bootstrap / "cancel").write_text("cancel")
            _, stderr = process.communicate(timeout=30)
        finally:
            process.kill()
    assert process.returncode != 0
    assert b"cancelled" in stderr
    assert (bootstrap / "bootstrap.exit").read_text() == "1"
    assert not (bootstrap / "program.zip.partial").exists()
    assert not (bootstrap / "program.zip").exists()
    assert not (tmp_path / "Cleo").exists()


def test_cancel_during_runtime_preparation_waits_for_the_runtime_to_stop(tmp_path, program):
    (tmp_path / "hold").write_text("wait for cancel")
    with serve(program) as url:
        bootstrap = prepare(tmp_path, program, url)
        process = subprocess.Popen(command(tmp_path, bootstrap), env=environment(tmp_path),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            wait_for((tmp_path / "runtime-env.json").exists, "The runtime never started.")
            assert json.loads((bootstrap / "progress.json").read_text())["stage"] == "extract"
            (bootstrap / "cancel").write_text("cancel")
            _, stderr = process.communicate(timeout=30)
        finally:
            process.kill()
    assert process.returncode != 0
    assert b"cancelled" in stderr
    assert "Failed: Installation cancelled." in (tmp_path / "install.log").read_text()
    assert (bootstrap / "bootstrap.exit").read_text() == "1"
