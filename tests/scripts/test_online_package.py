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
@pytest.mark.parametrize("uv_version,metadata_directory", [
    ("0.12.19", "uv-python"), ("0.12.24", "uv-python-managed"),
])
def test_runtime_plan_uses_upstream_hashes_and_omits_bundled_dependencies(
    tmp_path, monkeypatch, platform, target, arch, os_name, uv_version, metadata_directory,
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
            return f"uv {uv_version}"
        return "3.12.14" if "-c" in command else "v24.20.0"

    def fetch(url, **kwargs):
        if url.endswith("download-metadata.json"):
            assert url.startswith(f"https://raw.githubusercontent.com/astral-sh/uv/{uv_version}/")
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


URL = ("https://raw.githubusercontent.com/astral-sh/uv/0.12.19"
       "/crates/uv-python/download-metadata.json")


def http_error(code, reason):
    return urllib.error.HTTPError(URL, code, reason, None, None)


class Dropped(io.BytesIO):
    """A response whose connection is lost after the first few bytes of the body."""

    def read(self, *args):
        if self.tell():
            raise ConnectionResetError(10054, "Connection reset by peer")
        return super().read(4)


@pytest.fixture
def network(monkeypatch):
    """Purpose: Serve scripted outcomes in order instead of opening a socket.

    Output: ``serve(*outcomes)``; an exception is raised, anything else is the response.
    The fixture records each requested URL in ``calls`` and each backoff in ``waits``.
    """
    class Network:
        def __init__(self):
            self.calls: list[str] = []
            self.waits: list[float] = []

        def serve(self, *outcomes):
            pending = list(outcomes)

            def urlopen(url, **kwargs):
                self.calls.append(url)
                outcome = pending.pop(0)
                if isinstance(outcome, BaseException):
                    raise outcome
                return outcome

            monkeypatch.setattr(builder.urllib.request, "urlopen", urlopen)

    state = Network()
    monkeypatch.setattr(builder.time, "sleep", state.waits.append)
    return state


@pytest.mark.parametrize("failure", [
    pytest.param(http_error(503, "Backend.max_conn reached"), id="503"),
    pytest.param(http_error(500, "Internal Server Error"), id="500"),
    pytest.param(urllib.error.URLError(TimeoutError("timed out")), id="connect-timeout"),
    pytest.param(TimeoutError("The read operation timed out"), id="read-timeout"),
    pytest.param(urllib.error.URLError(ConnectionResetError(10054, "Connection reset by peer")),
                 id="connection-reset"),
    pytest.param(builder.http.client.RemoteDisconnected("Remote end closed connection"),
                 id="remote-disconnected"),
    pytest.param(builder.http.client.IncompleteRead(b"half"), id="incomplete-read"),
    pytest.param(urllib.error.URLError(builder.ssl.SSLEOFError(8, "EOF in violation of protocol")),
                 id="tls-stream-closed"),
])
def test_a_transient_download_failure_is_tried_again(network, failure):
    network.serve(failure, io.BytesIO(b"metadata"))

    assert builder.fetch(URL, 60) == b"metadata"
    assert network.calls == [URL, URL]
    assert network.waits == [builder.RETRY_DELAYS[0]]


@pytest.mark.parametrize("code", [400, 403, 404, 429])
def test_a_client_error_fails_at_once(network, code):
    network.serve(http_error(code, "refused"), io.BytesIO(b"never read"))

    with pytest.raises(urllib.error.HTTPError) as raised:
        builder.fetch(URL, 60)
    assert raised.value.code == code
    assert network.calls == [URL] and network.waits == []


def test_other_failures_are_not_retried(network):
    network.serve(urllib.error.URLError(builder.ssl.SSLCertVerificationError("bad certificate")),
                  io.BytesIO(b"never read"))

    with pytest.raises(urllib.error.URLError):
        builder.fetch(URL, 60)
    assert network.calls == [URL] and network.waits == []


def test_retries_stop_after_the_last_delay(network):
    attempts = len(builder.RETRY_DELAYS) + 1
    network.serve(*(http_error(503, "Backend.max_conn reached") for _ in range(attempts)),
                  io.BytesIO(b"never read"))

    with pytest.raises(urllib.error.HTTPError) as raised:
        builder.fetch(URL, 60)
    assert raised.value.code == 503
    assert len(network.calls) == attempts
    assert network.waits == list(builder.RETRY_DELAYS)
    assert network.waits == sorted(network.waits), "each wait is at least as long as the last"


def test_an_archive_cut_off_mid_download_is_fetched_again_from_the_start(tmp_path, network):
    payload = b"verified runtime archive"
    digest = hashlib.sha256(payload).hexdigest()
    url = "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip"
    network.serve(Dropped(payload), io.BytesIO(payload))

    record = builder.artifact(url, "24.20.0", digest, tmp_path)

    assert (tmp_path / "node-v24.20.0-win-x64.zip").read_bytes() == payload
    assert record == {"archive": "node-v24.20.0-win-x64.zip", "url": url, "version": "24.20.0",
                      "sha256": digest, "bytes": len(payload)}
    assert network.calls == [url, url] and network.waits == [builder.RETRY_DELAYS[0]]
