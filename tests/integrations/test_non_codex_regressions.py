"""Regression coverage for CLI diagnostics, continuation and SDK tool results."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from claude_agent_sdk import ResultMessage, ToolResultBlock, UserMessage

from cleo.config.settings import AgentProfile
from cleo.harnesses.control import SessionOptions
from cleo.integrations import claude_cli, subscriptions
from cleo.integrations.harnesses.claude import ClaudeProvider, _ClaudeRuntime
from cleo.integrations.runtime_diagnostics import StderrCapture, diagnostic_text
from cleo.integrations.subscriptions import AgentMcp


def cli_fixture(tmp_path, monkeypatch, messages, *, stderr=b"", exit_code=0):
    """Purpose: Exercise the real CLI consumer with deterministic process output.
    Input: Stream messages, stderr and exit code supplied by each regression.
    Output: Provider and recorded CLI arguments; no external process or user data.
    """
    launches = []
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")
    monkeypatch.setattr(subscriptions, "executable", lambda _: "claude")

    async def spawn(*args, **kwargs):
        launches.append(args)
        out, err = asyncio.StreamReader(), asyncio.StreamReader()
        out.feed_data(b"".join(json.dumps(m).encode() + b"\n" for m in messages))
        out.feed_eof()
        err.feed_data(stderr)
        err.feed_eof()

        async def noop():
            return exit_code

        return SimpleNamespace(
            stdout=out, stderr=err, returncode=exit_code, wait=noop,
            stdin=SimpleNamespace(write=lambda _: None, drain=noop, close=lambda: None),
        )

    monkeypatch.setattr(claude_cli.asyncio, "create_subprocess_exec", spawn)
    return claude_cli.ClaudeCliProvider(profile, AgentMcp(profile, tmp_path, "")), launches


@pytest.mark.parametrize("messages,code,expected", [
    ([], 7, ["exit_code=7", "result=missing", "unknown option"]),
    ([], 0, ["exit_code=0", "result=missing"]),
    ([{"type": "result", "is_error": True, "subtype": "error_during_execution",
       "errors": ["Model unavailable"]}], 0,
     ["result=error", "error_during_execution", "Model unavailable"]),
])
def test_cli_failure_reports_observed_branch(tmp_path, monkeypatch, messages, code, expected):
    provider, _ = cli_fixture(tmp_path, monkeypatch, messages, exit_code=code,
                              stderr=b"unknown option; Authorization: Bearer private-value")

    async def exercise():
        session = await provider.create_session(str(tmp_path))
        with pytest.raises(RuntimeError) as caught:
            await provider.prompt(session.id, "hello")
        message = str(caught.value)
        for part in expected:
            assert part in message
        assert "private-value" not in message
        assert "Check its login, quota" not in message
        assert not provider._processes

    asyncio.run(exercise())


def test_cli_retains_native_session_for_followup(tmp_path, monkeypatch):
    provider, launches = cli_fixture(tmp_path, monkeypatch, [
        {"type": "result", "is_error": False, "session_id": "native-123", "result": "hello"},
    ])

    async def exercise():
        session = await provider.create_session(str(tmp_path))
        await provider.prompt(session.id, "Remember a word")
        await provider.prompt(session.id, "What word?")

    asyncio.run(exercise())
    assert "--resume" not in launches[0]
    assert launches[1][launches[1].index("--resume") + 1] == "native-123"


def test_sdk_forwards_tool_results_from_user_messages():
    async def exercise():
        async def query(_):
            pass

        async def receive_response():
            yield UserMessage(content=[ToolResultBlock(tool_use_id="read-1", content="fixture")])
            yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1,
                                is_error=False, num_turns=1, session_id="native", result="done")

        provider = ClaudeProvider()
        provider._sessions["local"] = _ClaudeRuntime(
            client=SimpleNamespace(query=query, receive_response=receive_response),
            options=SessionOptions(), cwd=".",
        )
        received = []
        turn = await provider.prompt("local", "Read fixture", received.append)
        assert turn.status == "completed"
        assert [event.type for event in received] == ["tool_result"]
        assert received[0].data["tool_use_id"] == "read-1"
        assert received[0].data["content"] == "fixture"
        assert turn.events == tuple(received)

    asyncio.run(exercise())


def test_diagnostics_redact_before_truncation_and_bound_stderr(monkeypatch):
    monkeypatch.setenv("EXAMPLE_API_KEY", "environment-credential")
    raw = ('Authorization: Bearer bearer-value\n{"access_token":"json-value"}\n'
           'api_key=plain-value https://user:password@example.com/?token=url-value '
           'sk-ant-secret-value person@example.com environment-credential submitted prompt')
    safe = diagnostic_text(raw, prompt="submitted prompt")
    for secret in ("bearer-value", "json-value", "plain-value", "url-value",
                   "sk-ant-secret-value", "person@example.com", "environment-credential",
                   "submitted prompt", "user:password"):
        assert secret not in safe
    assert "<redacted>" in safe

    async def exercise():
        stream = asyncio.StreamReader()
        stream.feed_data(b"initial failure\naccess_token=" + b"x" * 40000)
        stream.feed_eof()
        capture = StderrCapture()
        await capture.drain(stream)
        assert len(capture.data) <= 16384
        assert stream.at_eof()
        assert capture.text() == "initial failure [stderr truncated]"

    asyncio.run(exercise())


def test_cli_reports_mcp_status_without_assuming_it_caused_failure(tmp_path, monkeypatch):
    provider, _ = cli_fixture(tmp_path, monkeypatch, [
        {"type": "system", "subtype": "init", "mcp_servers": [
            {"name": "cleo-tools", "status": "failed"},
        ]},
    ])

    async def exercise():
        session = await provider.create_session(str(tmp_path))
        with pytest.raises(RuntimeError, match="result=missing; cleo-tools=failed"):
            await provider.prompt(session.id, "hello")

    asyncio.run(exercise())


@pytest.mark.parametrize("name", ["gemini", "copilot", "grok", "opencode", "custom-acp"])
def test_acp_turns_forward_tool_results_and_reuse_session(tmp_path, monkeypatch, name):
    from acp import update_agent_message_text

    from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider, _AcpClientHost

    provider = AcpProvider(name, AcpAgentSpec(command=name))
    host = _AcpClientHost(name, str(tmp_path), auto_approve=False)
    calls = []

    async def new_session(**kwargs):
        return SimpleNamespace(session_id="native-acp", config_options=[])

    async def prompt(session_id, blocks):
        calls.append((session_id, blocks[0].text))
        for kind in ("tool_call", "tool_call_update"):
            payload = {"sessionUpdate": kind, "toolCallId": "read-1", "status": "completed"}
            update = SimpleNamespace(model_dump=lambda value=payload, **_: value)
            await host.session_update(session_id, update)
        await host.session_update(session_id, update_agent_message_text(f"reply-{len(calls)}"))
        return SimpleNamespace(stop_reason="end_turn")

    async def close(*_):
        pass

    async def connect(_):
        return (SimpleNamespace(new_session=new_session, prompt=prompt),
                SimpleNamespace(__aexit__=close), host, None)

    monkeypatch.setattr(provider, "_connect", connect)

    async def exercise():
        session = await provider.create_session(str(tmp_path))
        for index in range(2):
            events = []
            turn = await provider.prompt(session.id, f"prompt-{index}", events.append)
            assert turn.status == "completed"
            assert turn.response == f"reply-{index + 1}"
            assert [event.type for event in events] == [
                "tool_call", "tool_result", "assistant_message_chunk",
            ]
            assert turn.events == tuple(events)
        await provider.close(session.id)
        assert [call[0] for call in calls] == ["native-acp", "native-acp"]

    asyncio.run(exercise())


@pytest.mark.parametrize("approve,expected", [(False, "reject"), (True, "allow")])
def test_acp_permissions_follow_configuration(tmp_path, approve, expected):
    from cleo.integrations.harnesses.acp import _AcpClientHost

    host = _AcpClientHost("acp", str(tmp_path), auto_approve=approve)
    options = [SimpleNamespace(kind="allow_once", option_id="allow", name="Allow once"),
               SimpleNamespace(kind="reject_once", option_id="reject", name="Reject once")]
    host.begin_turn(None)
    result = asyncio.run(host.request_permission("native", {}, options))
    assert result.outcome.option_id == expected
