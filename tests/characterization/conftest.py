"""Fixtures for the v0.7.1 backend characterization suite.

Each test gets its own CLEO_HOME, Git workspace and backend process. The only test doubles
sit at the process/network boundary: an OpenAI-compatible HTTP server for chat models and
a scripted ACP agent for development tasks.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from .support.backend import REPO_ROOT, Backend
from .support.fake_llm import FakeLLM
from .support.home import CHAT_API_KEY, CleoHome, build_home

if shutil.which("git") is None:  # pragma: no cover - environment guard
    pytest.skip("characterization tests need git on PATH", allow_module_level=True)


@pytest.fixture
def fake_llm() -> Iterator[FakeLLM]:
    server = FakeLLM().start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def short_root() -> Iterator[Path]:
    """A short, fixed-length root for the test home and workspace.

    On Windows, Git cannot lock ``refs/cleo/undo/<64 hex>`` once the workspace path passes
    roughly 170 characters, and v0.7.1 then silently drops the undo checkpoint (Q12). Deep
    pytest temp directories would make snapshots depend on that threshold.
    ``CLEO_CHAR_TMP`` picks another parent directory when the system temp is unsuitable.
    """
    root = Path(tempfile.mkdtemp(prefix="cleo-char-", dir=os.environ.get("CLEO_CHAR_TMP")))
    try:
        yield root
    finally:
        shutil.rmtree(root, onexc=_remove_read_only)


def _remove_read_only(function, path, _error) -> None:
    """Git object files are read-only on Windows; clear the flag and retry once."""
    try:
        os.chmod(path, stat.S_IWRITE)
        function(path)
    except OSError:
        pass


@pytest.fixture
def cleo_home(short_root: Path, fake_llm: FakeLLM) -> CleoHome:
    return build_home(short_root, fake_llm.base_url)


@pytest.fixture
def replacements(cleo_home: CleoHome, fake_llm: FakeLLM) -> dict[str, str]:
    """Machine-specific strings mapped to placeholders in golden snapshots."""
    values = {
        str(cleo_home.home): "<HOME>",
        str(cleo_home.workspace): "<WORKSPACE>",
        str(cleo_home.user_home): "<USER>",
        str(cleo_home.root): "<ROOT>",
        str(REPO_ROOT): "<REPO>",
        sys.executable: "<PYTHON>",
        fake_llm.base_url: "<LLM_URL>",
    }
    # Windows can report the same directory with a different drive-letter case.
    for raw, placeholder in list(values.items()):
        values.setdefault(raw[:1].lower() + raw[1:], placeholder)
        values.setdefault(os.path.normcase(raw), placeholder)
    return values


@pytest.fixture
def backend(cleo_home: CleoHome) -> Iterator[Backend]:
    """A backend process; tests that characterize graceful shutdown call ``stop()``.

    Teardown hard-stops a still-running process so a detached DreamAgent worker never
    outlives the test, and checks two protocol invariants for the whole session.
    """
    process = Backend(cleo_home).start()
    try:
        yield process
    finally:
        process.kill()
    assert not process.unmatched, f"non-JSON output on stdout: {process.unmatched[:3]}"
    leaked = [line for line in process.stdout_lines if CHAT_API_KEY in line]
    assert not leaked, "an API key crossed the desktop protocol boundary"
