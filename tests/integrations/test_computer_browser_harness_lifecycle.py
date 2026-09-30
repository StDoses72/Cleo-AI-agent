"""Mocked process-lifecycle regressions; never launch Electron or send desktop input."""

import importlib.util
import signal
import socket
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def harness_runtime(monkeypatch):
    """Purpose: Isolate every process, thread and socket used by the native harness.

    Input: pytest's monkeypatch fixture.
    Output: The loaded module and controllable mock runtime; no processes are launched.
    """
    path = Path(__file__).with_name("test_computer_browser_native.py")
    spec = importlib.util.spec_from_file_location("browser_harness_lifecycle", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    process = MagicMock(pid=54321)
    process.poll.return_value = None
    process.wait.return_value = 0
    connection = MagicMock()
    runtime = SimpleNamespace(
        module=module, process=process, connection=connection,
        ready=True, descriptor="test-descriptor", socket_thread_error=False,
    )

    def thread_factory(target, daemon):
        """Purpose: Simulate readiness without running a background thread.

        Input: The bound reader target and daemon flag.
        Output: A mock thread that supplies startup metadata or an injected failure.
        """
        thread = MagicMock(ident=None)

        def start():
            """Purpose: Inject the requested startup outcome.

            Input: The enclosing mock runtime.
            Output: Readiness metadata, or a simulated socket-reader startup failure.
            """
            if target.__name__ == "read":
                harness = target.__self__
                harness.descriptor = runtime.descriptor
                harness.port, harness.token = 12345, "test-token"
            elif runtime.socket_thread_error:
                raise RuntimeError("reader failed")

        thread.start.side_effect = start
        return thread

    ready = MagicMock()
    ready.wait.side_effect = lambda timeout: runtime.ready
    runtime.popen = MagicMock(return_value=process)
    runtime.run = MagicMock()
    runtime.killpg = MagicMock()
    runtime.send = MagicMock()
    monkeypatch.setattr(module.subprocess, "Popen", runtime.popen)
    monkeypatch.setattr(module.subprocess, "run", runtime.run)
    monkeypatch.setattr(module.os, "killpg", runtime.killpg, raising=False)
    monkeypatch.setattr(module.socket, "create_connection", MagicMock(return_value=connection))
    monkeypatch.setattr(module.threading, "Thread", thread_factory)
    monkeypatch.setattr(module.threading, "Event", lambda: ready)
    monkeypatch.setattr(module.Harness, "send", runtime.send)
    return runtime


@pytest.mark.parametrize("failure", ["timeout", "descriptor", "connection", "reader"])
def test_startup_failure_reaps_owned_process(harness_runtime, tmp_path, failure):
    """Purpose: Verify constructor failures cannot bypass process cleanup.

    Input: A mocked runtime and each startup failure point.
    Output: The original failure propagates after reaping and closing owned resources.
    """
    runtime = harness_runtime
    if failure == "timeout":
        runtime.ready = False
    elif failure == "descriptor":
        runtime.descriptor = None
    elif failure == "connection":
        runtime.module.socket.create_connection.side_effect = OSError("connect failed")
    else:
        runtime.socket_thread_error = True
    with pytest.raises((AssertionError, OSError, RuntimeError)):
        runtime.module.Harness(tmp_path)
    runtime.process.wait.assert_called_once_with(15)
    runtime.process.stdout.close.assert_called_once()
    runtime.run.assert_not_called()
    if failure == "reader":
        runtime.connection.close.assert_called_once()


def test_graceful_close_releases_socket_and_reaps(harness_runtime, tmp_path):
    """Purpose: Keep normal shutdown graceful and idempotent.

    Input: A successfully connected mock harness.
    Output: Quit precedes resource cleanup, with no forceful process termination.
    """
    runtime = harness_runtime
    harness = runtime.module.Harness(tmp_path)
    harness.close()
    runtime.send.assert_called_once_with("quit", timeout=10)
    runtime.connection.shutdown.assert_called_once_with(socket.SHUT_RDWR)
    runtime.connection.close.assert_called_once()
    runtime.process.wait.assert_called_once_with(15)
    runtime.process.stdout.close.assert_called_once()
    runtime.run.assert_not_called()
    runtime.process.poll.return_value = 0
    harness.close()
    runtime.send.assert_called_once()


def test_windows_timeout_terminates_only_owned_tree_then_waits(
    harness_runtime, tmp_path, monkeypatch,
):
    """Purpose: Prevent renderer orphans when graceful Windows shutdown times out.

    Input: A mock harness whose initial wait expires.
    Output: A hidden, bounded taskkill for the owned PID tree, followed by reaping.
    """
    runtime = harness_runtime
    monkeypatch.setattr(runtime.module, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(runtime.module.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    harness = runtime.module.Harness(tmp_path)
    runtime.process.wait.side_effect = [subprocess.TimeoutExpired("electron", 15), 0]
    harness.close()
    args, kwargs = runtime.run.call_args
    assert Path(args[0][0]).is_absolute()
    assert args[0][1:] == ["/PID", "54321", "/T", "/F"]
    assert kwargs["timeout"] == 15
    assert kwargs["creationflags"] == 0x08000000
    assert runtime.process.wait.call_args_list[-1].args == (10,)
    runtime.process.kill.assert_not_called()
    runtime.killpg.assert_not_called()
    assert runtime.popen.call_args.kwargs["start_new_session"] is False


def test_posix_timeout_terminates_owned_session_then_waits(harness_runtime, tmp_path, monkeypatch):
    """Purpose: Keep non-Windows fallback limited to the harness's process group.

    Input: A mock POSIX harness whose graceful wait expires.
    Output: Its fresh process group is killed and the main process is reaped.
    """
    runtime = harness_runtime
    monkeypatch.setattr(runtime.module, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(runtime.module.signal, "SIGKILL", 9, raising=False)
    harness = runtime.module.Harness(tmp_path)
    runtime.process.wait.side_effect = [subprocess.TimeoutExpired("electron", 15), 0]
    harness.close()
    runtime.killpg.assert_called_once_with(54321, signal.SIGKILL)
    runtime.run.assert_not_called()
    assert runtime.popen.call_args.kwargs["start_new_session"] is True
    assert runtime.process.wait.call_args_list[-1].args == (10,)


def test_unreaped_process_is_reported_as_cleanup_failure(harness_runtime, tmp_path):
    """Purpose: Never report shutdown completion while the process still runs.

    Input: A mock process that times out before and after forceful cleanup.
    Output: Cleanup raises TimeoutExpired rather than returning success.
    """
    runtime = harness_runtime
    harness = runtime.module.Harness(tmp_path)
    runtime.process.wait.side_effect = subprocess.TimeoutExpired("electron", 10)
    with pytest.raises(subprocess.TimeoutExpired):
        harness.close()
    runtime.connection.close.assert_called_once()
    runtime.process.stdout.close.assert_not_called()
