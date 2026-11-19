"""Antigravity SDK harness against a fake SDK: no network, no credentials, no localharness."""
import asyncio
import enum
import sys
import types as pytypes
from types import SimpleNamespace

import pytest

from cleo.harnesses.control import SessionOptions
from cleo.integrations.harnesses.antigravity import AntigravityProvider, AntigravityUnavailable


class _Level(enum.StrEnum):
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    EXTRA_HIGH = "xhigh"


class _Conversation:
    def __init__(self, steps, conversation_id="conv-1"):
        self.steps = steps
        self.sent = []
        self.cancelled = 0
        self.conversation_id = conversation_id

    async def send(self, prompt):
        self.sent.append(prompt)

    async def receive_steps(self):
        for step in self.steps:
            if isinstance(step, BaseException):
                raise step
            yield step

    async def cancel(self):
        self.cancelled += 1


class _Agent:
    instances = []

    def __init__(self, config):
        self.config = config
        self.conversation = _Conversation(list(_Agent.script))
        self.entered = self.exited = False
        _Agent.instances.append(self)

    @property
    def conversation_id(self):
        return self.config.kwargs.get("conversation_id") or self.conversation.conversation_id

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, *_):
        self.exited = True


class _Config:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


def _step(*, source="MODEL", target="TARGET_USER", status="ACTIVE", text="", thinking="",
          calls=(), depth=0, error="", content="", index=0):
    return SimpleNamespace(
        source=source, target=target, status=status, content_delta=text, thinking_delta=thinking,
        tool_calls=list(calls), depth=depth, parent_trajectory_id="" if depth == 0 else "parent",
        trajectory_id="t", step_index=index, error=error, content=content,
    )


@pytest.fixture
def fake_sdk(monkeypatch):
    sdk = pytypes.ModuleType("google.antigravity")
    sdk.Agent = _Agent
    sdk.LocalAgentConfig = _Config
    sdk.GeminiModelOptions = lambda **kw: SimpleNamespace(**kw)
    sdk.GeminiAPIEndpoint = lambda **kw: SimpleNamespace(kind="api", **kw)
    sdk.VertexEndpoint = lambda **kw: SimpleNamespace(kind="vertex", **kw)
    sdk.ModelTarget = lambda **kw: SimpleNamespace(**kw)
    sdk.ModelType = SimpleNamespace(TEXT="text")
    sdk.ThinkingLevel = _Level
    sdk.types = SimpleNamespace(SessionContinuationMode=SimpleNamespace(RESUME="resume"))
    policy = pytypes.ModuleType("google.antigravity.hooks.policy")
    policy.ask_user = lambda tool, handler=None, name="": SimpleNamespace(
        tool=tool, handler=handler)
    hooks = pytypes.ModuleType("google.antigravity.hooks")
    hooks.policy = policy
    monkeypatch.setitem(sys.modules, "google.antigravity", sdk)
    monkeypatch.setitem(sys.modules, "google.antigravity.hooks", hooks)
    monkeypatch.setitem(sys.modules, "google.antigravity.hooks.policy", policy)
    _Agent.instances = []
    _Agent.script = []
    return sdk


def _provider(tmp_path, **kwargs):
    kwargs.setdefault("environment", {"GEMINI_API_KEY": "fixture"})
    return AntigravityProvider("antigravity", save_root=tmp_path / "save", **kwargs)


def test_auth_status_names_the_billing_owner_and_what_is_missing(tmp_path):
    assert _provider(tmp_path).auth_status() == {
        "auth": "api_key", "billing": "gemini_api_key", "ready": True, "reason": None}
    missing = _provider(tmp_path, environment={}).auth_status()
    assert not missing["ready"] and "GEMINI_API_KEY" in missing["reason"]
    vertex = _provider(tmp_path, auth="vertex", environment={"GOOGLE_CLOUD_PROJECT": "p"})
    status = vertex.auth_status()
    assert status["billing"] == "google_cloud_project" and not status["ready"]
    assert "GOOGLE_CLOUD_LOCATION" in status["reason"]
    ready = _provider(tmp_path, auth="vertex", project="p", location="us-central1", environment={})
    assert ready.auth_status()["ready"]


def test_missing_sdk_or_key_fails_with_an_actionable_reason(tmp_path, monkeypatch, fake_sdk):
    with pytest.raises(AntigravityUnavailable, match="GEMINI_API_KEY"):
        asyncio.run(_provider(tmp_path, environment={}).check_connection(str(tmp_path)))
    monkeypatch.setitem(sys.modules, "google.antigravity", None)
    with pytest.raises(AntigravityUnavailable, match="pip install google-antigravity"):
        asyncio.run(_provider(tmp_path).check_connection(str(tmp_path)))


def test_models_offer_the_default_and_thinking_levels(tmp_path, fake_sdk):
    models = asyncio.run(_provider(tmp_path, default_model="gemini-x").list_models())
    assert [model.id for model in models] == ["gemini-x", "gemini-4-hydrogen"]
    assert models[0].is_default and models[0].supported_efforts[-1] == "xhigh"


def test_a_turn_streams_text_thinking_and_tools(tmp_path, fake_sdk):
    call = SimpleNamespace(id="c1", name="run_command", args={"CommandLine": "ls"})
    _Agent.script = [
        _step(thinking="plan"),
        _step(text="Hel"),
        _step(source="MODEL", target="TARGET_ENVIRONMENT", calls=[call]),
        _step(source="SYSTEM", target="TARGET_USER", status="DONE", calls=[call], content="a.txt"),
        _step(depth=1, text="subagent text is not the reply"),
        _step(text="lo", status="DONE"),
    ]

    async def scenario():
        provider = _provider(tmp_path)
        session = await provider.create_session(str(tmp_path), "gemini-x")
        events = []

        async def collect(event):
            events.append(event)

        turn = await provider.prompt(session.id, "hi", collect)
        return provider, session, turn, events

    provider, session, turn, events = asyncio.run(scenario())
    config = _Agent.instances[0].config.kwargs
    assert config["workspaces"] == [str(tmp_path.resolve())]
    assert config["models"][0].name == "gemini-x" and config["models"][0].endpoint.kind == "api"
    assert turn.status == "completed" and turn.response == "Hello"
    assert turn.native_session_id == "conv-1"
    assert [event.type for event in events] == [
        "thought", "assistant_message_chunk", "tool_call", "tool_result",
        "assistant_message_chunk"]


def test_resume_reopens_the_saved_conversation(tmp_path, fake_sdk):
    session = asyncio.run(_provider(tmp_path).resume_session("c" * 32, str(tmp_path)))
    config = _Agent.instances[0].config.kwargs
    assert session.native_id == "c" * 32 and config["conversation_id"] == "c" * 32
    assert config["session_continuation_mode"] == "resume"


@pytest.mark.parametrize("failure,status", [
    (type("AntigravityCancelledError", (Exception,), {})(), "cancelled"),
    (RuntimeError("quota exhausted"), "failed"),
])
def test_sdk_errors_end_the_turn_with_a_status(tmp_path, fake_sdk, failure, status):
    _Agent.script = [_step(text="partial"), failure]

    async def scenario():
        provider = _provider(tmp_path)
        session = await provider.create_session(str(tmp_path))
        return await provider.prompt(session.id, "hi")

    turn = asyncio.run(scenario())
    assert turn.status == status
    assert (turn.error == "quota exhausted") == (status == "failed")


def test_approvals_read_freely_contain_files_and_follow_the_mode(tmp_path, fake_sdk):
    project = tmp_path / "project"
    project.mkdir()

    async def scenario():
        provider = _provider(tmp_path, approval_mode="deny_all")
        session = await provider.create_session(str(project))
        runtime = provider._sessions[session.id]

        def call(name, **args):
            return SimpleNamespace(id=name, name=name, args=args, canonical_path=None)

        decide = provider._decide
        results = {
            "read": await decide(runtime, call("view_file", path=str(project / "a.py")), None),
            "outside": await decide(runtime, call("view_file", path=str(tmp_path / "x")), None),
            "write_denied": await decide(runtime, call("edit_file", path=str(project / "a")), None),
        }
        await provider.update_session_options(session.id, approval_mode="auto_allow")
        results["command_auto"] = await decide(runtime, call("run_command", CommandLine="ls"), None)
        await provider.update_session_options(session.id, approval_mode="user")
        await provider.enable_user_approvals(session.id)
        asked = []

        async def answer(event):
            if event.type == "permission_request":
                asked.append(event.data)
                await provider.resolve_approval(session.id, event.data["id"], "accept")

        runtime.approvals.callback = answer
        results["user_accept"] = await decide(runtime, call("run_command", CommandLine="ls"), None)
        return results, asked

    results, asked = asyncio.run(scenario())
    assert results == {"read": True, "outside": False, "write_denied": False,
                       "command_auto": True, "user_accept": True}
    assert asked[0]["command"] == "ls" and asked[0]["cwd"] == str(project.resolve())


def test_model_or_thinking_change_restarts_on_the_same_conversation(tmp_path, fake_sdk):
    async def scenario():
        provider = _provider(tmp_path)
        session = await provider.create_session(str(tmp_path), "gemini-x")
        options = await provider.update_session_options(session.id, effort="high")
        same = await provider.update_session_options(session.id, effort="high")
        return options, same

    options, same = asyncio.run(scenario())
    assert options == SessionOptions(model="gemini-x", effort="high", approval_mode="user")
    assert same == options
    first, second = _Agent.instances
    assert first.exited and second.entered
    assert second.config.kwargs["conversation_id"] == "conv-1"
    assert second.config.kwargs["models"][0].endpoint.options.thinking_level is _Level.HIGH
    assert len(_Agent.instances) == 2
    with pytest.raises(ValueError, match="thinking level"):
        asyncio.run(_provider(tmp_path).update_session_options("x", effort="ultra"))
