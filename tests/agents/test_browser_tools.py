from __future__ import annotations

import json
import os
import subprocess
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

import cleo.agents.tools.browser_tools as browser_module
from cleo.config.settings import BrowserToolSettings


def _fake_settings(tmp_path, **browser_overrides):
    browser = BrowserToolSettings(**browser_overrides)
    directory = SimpleNamespace(
        root_path=tmp_path,
        session_artifacts_path=tmp_path / "artifacts",
    )
    return SimpleNamespace(
        active_tools_profile=SimpleNamespace(browser=browser),
        active_directory_profile=directory,
    )


def test_session_name_is_thread_scoped_and_shell_safe() -> None:
    first = SimpleNamespace(config={"configurable": {"thread_id": "project/thread 1"}})
    second = SimpleNamespace(config={"configurable": {"thread_id": "project/thread 2"}})

    first_name = browser_module._session_name(first)

    assert first_name.startswith("cleo-project-thread-1-")
    assert first_name == browser_module._session_name(first)
    assert first_name != browser_module._session_name(second)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:3000",
        "http://127.0.0.1",
        "http://10.0.0.8",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "https://user:password@example.com",
    ],
)
def test_url_validation_blocks_local_and_unsafe_targets(url: str) -> None:
    with pytest.raises(browser_module.BrowserToolError):
        browser_module._validate_url(url, BrowserToolSettings())


def test_url_validation_accepts_public_dns(monkeypatch) -> None:
    monkeypatch.setattr(
        browser_module.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (browser_module.socket.AF_INET, 1, 6, "", ("93.184.216.34", 443))
        ],
    )

    assert (
        browser_module._validate_url("https://example.com/path", BrowserToolSettings())
        == "https://example.com/path"
    )


def test_browser_environment_does_not_inherit_model_secrets(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "should-not-be-inherited")
    monkeypatch.setenv("PATH", "safe-path")

    environment = browser_module._browser_environment(BrowserToolSettings())

    assert environment["PATH"] == "safe-path"
    assert "OPENAI_API_KEY" not in environment
    assert environment["AGENT_BROWSER_CONTENT_BOUNDARIES"] == "1"


@pytest.mark.skipif(os.name != "nt", reason="Windows npm prefix fallback")
def test_command_resolution_finds_windows_npm_prefix(tmp_path, monkeypatch) -> None:
    npm_prefix = tmp_path / "npm"
    shim = npm_prefix / "agent-browser.cmd"
    native = npm_prefix / "node_modules" / "agent-browser" / "bin"
    native.mkdir(parents=True)
    executable = native / "agent-browser-win32-x64.exe"
    shim.write_text("shim", encoding="utf-8")
    executable.write_bytes(b"binary")
    monkeypatch.setattr(browser_module.platform, "machine", lambda: "AMD64")
    monkeypatch.setattr(browser_module.shutil, "which", lambda _command: None)
    monkeypatch.setenv("APPDATA", str(tmp_path))

    assert browser_module._command_prefix("agent-browser") == [str(executable.resolve())]


def test_agent_browser_invocation_uses_json_args_and_thread_session(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(browser_module, "settings", _fake_settings(tmp_path))
    monkeypatch.setattr(browser_module, "_command_prefix", lambda _command: ["browser-bin"])
    captured = {}
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        captured["command"] = command
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps({"success": True, "data": {"url": "https://example.com"}}),
            stderr="",
        )

    monkeypatch.setattr(browser_module.subprocess, "run", fake_run)
    runtime = SimpleNamespace(config={"configurable": {"thread_id": "thread-a"}})

    result = browser_module._run_agent_browser(
        "open",
        ["open", "https://example.com"],
        runtime,
    )

    command = captured["command"]
    assert result["success"] is True
    assert command[0] == "browser-bin"
    assert command[1:3] == ["--session", browser_module._session_name(runtime)]
    assert "--json" in command
    assert len(calls) == 2
    assert calls[0][0][-2:] == ["get", "url"]
    assert calls[0][1]["stdout"] == subprocess.DEVNULL
    assert captured["kwargs"]["shell"] is False
    assert "OPENAI_API_KEY" not in captured["kwargs"]["env"]


def test_tool_node_injects_thread_runtime(monkeypatch) -> None:
    seen = {}

    def fake_run(_action, _args, runtime):
        seen["session"] = browser_module._session_name(runtime)
        return {"success": True}

    monkeypatch.setattr(browser_module, "_run_agent_browser", fake_run)
    node = ToolNode([browser_module.browser_close])
    builder = StateGraph(MessagesState)
    builder.add_node("tools", node)
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    graph = builder.compile()
    state = {
        "messages": [
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "browser_close", "args": {}, "id": "call-1", "type": "tool_call"}
                ],
            )
        ]
    }

    result = graph.invoke(
        state,
        config={"configurable": {"thread_id": "thread-from-tool-node"}},
    )

    assert result["messages"][-1].status == "success"
    assert seen["session"] == browser_module._session_name(
        SimpleNamespace(config={"configurable": {"thread_id": "thread-from-tool-node"}})
    )


def test_oversized_browser_result_is_saved_as_project_artifact(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        browser_module,
        "settings",
        _fake_settings(tmp_path, max_output_chars=1000),
    )

    result = browser_module._bound_payload(
        {"success": True, "data": {"snapshot": "x" * 3000}},
        "snapshot",
        "cleo-test",
    )

    assert result["success"] is True
    assert result["truncated"] is True
    assert result["artifact_path"].startswith("/artifacts/browser/cleo-test/")
    artifact = tmp_path / result["artifact_path"].lstrip("/")
    assert artifact.is_file()
    assert "x" * 100 in artifact.read_text(encoding="utf-8")
