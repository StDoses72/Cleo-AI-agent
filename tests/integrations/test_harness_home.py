"""Every Claude/Codex entry point uses one fixed Cleo-owned harness directory."""

import asyncio
import os
from types import SimpleNamespace

import pytest

from cleo.config.settings import AgentProfile
from cleo.integrations import claude_cli, harness_home, subscriptions
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.subscriptions import AgentMcp

SESSION = "0f8c1a52-5c1e-4d7b-9a55-3f4b2c1d9e10"


@pytest.fixture
def homes(tmp_path, monkeypatch):
    cleo = tmp_path / "cleo"
    external = tmp_path / "user" / ".claude"
    monkeypatch.setattr("cleo.config.settings.APP_HOME", cleo)
    monkeypatch.setattr("pathlib.Path.home", classmethod(lambda cls: tmp_path / "user"))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    external.mkdir(parents=True)
    (external / ".credentials.json").write_text("external login sentinel", encoding="utf-8")
    return SimpleNamespace(
        claude=(cleo / "data" / "claude").resolve(),
        codex=(cleo / "data" / "codex").resolve(),
        external=external,
        project=tmp_path / "project",
    )


def transcript(home, native_id=SESSION):
    path = home / "projects" / "C--work-project" / f"{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"type":"user"}\n', encoding="utf-8")
    return path


def fake_sdk(monkeypatch):
    connections = []

    class Client:
        def __init__(self, options):
            self.options = options
            connections.append(self)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

    monkeypatch.setattr("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client)
    return connections


def test_fixed_directories_are_stable_and_leave_process_environment(homes, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", "external-codex")
    assert harness_home.harness_home("claude") == homes.claude
    assert harness_home.harness_home("claude") == homes.claude
    assert harness_home.harness_home("codex") == homes.codex
    env = harness_home.harness_environment("codex", {"KEEP": "1"})
    assert env == {"KEEP": "1", "CODEX_HOME": str(homes.codex),
                   "CODEX_SQLITE_HOME": str(homes.codex)}
    assert harness_home.claude_environment({"KEEP": "1"}) == {
        "KEEP": "1", "CLAUDE_CONFIG_DIR": str(homes.claude),
    }
    assert harness_home.claude_environment({"KEEP": "1"}, external=True) == {"KEEP": "1"}
    assert os.environ["CODEX_HOME"] == "external-codex"
    assert "CLAUDE_CONFIG_DIR" not in os.environ
    with pytest.raises(ValueError):
        harness_home.harness_home("gemini")


def test_legacy_detection_prefers_cleo_home_and_rejects_paths(homes):
    assert not harness_home.claude_session_is_external(None)
    assert not harness_home.claude_session_is_external(SESSION)
    transcript(homes.external)
    assert harness_home.claude_session_is_external(SESSION)
    for hostile in ("../" + SESSION, "*", "a/b", ""):
        assert not harness_home.claude_session_is_external(hostile)
    transcript(homes.claude)
    assert not harness_home.claude_session_is_external(SESSION)


def test_sdk_sessions_use_cleo_home_and_legacy_history_stays_resumable(homes, monkeypatch):
    connections = fake_sdk(monkeypatch)
    legacy = transcript(homes.external)
    original = legacy.read_text(encoding="utf-8")

    async def run():
        provider = ClaudeProvider()
        created = await provider.create_session(str(homes.project))
        assert connections[-1].options.env == {"CLAUDE_CONFIG_DIR": str(homes.claude)}
        assert connections[-1].options.cwd == str(homes.project)
        assert not provider._sessions[created.id].external_home

        resumed = await provider.resume_session(SESSION, str(homes.project))
        runtime = provider._sessions[resumed.id]
        assert runtime.external_home
        # Legacy sessions keep the inherited environment, i.e. the original directory.
        assert connections[-1].options.env == {}
        assert connections[-1].options.resume == SESSION
        await provider.update_session_options(resumed.id, approval_mode="bypassPermissions")
        assert connections[-1].options.env == {}
        assert runtime.external_home

        other = await provider.resume_session("unknown-session", str(homes.project))
        assert connections[-1].options.env == {"CLAUDE_CONFIG_DIR": str(homes.claude)}
        assert not provider._sessions[other.id].external_home

    asyncio.run(run())
    assert legacy.read_text(encoding="utf-8") == original
    assert (homes.external / ".credentials.json").read_text() == "external login sentinel"
    assert not (homes.claude / ".credentials.json").exists()
    assert not (homes.claude / "projects").exists()


def test_login_check_models_and_cli_turns_use_the_same_directory(homes, monkeypatch):
    spawned = []

    class Stop(Exception):
        pass

    async def spawn(*args, **kwargs):
        spawned.append((args, kwargs["env"]))
        raise Stop

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(subscriptions, "executable", lambda _: "claude")
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")

    async def run():
        with pytest.raises(Stop):
            await claude_cli.auth_status(profile)
        provider = claude_cli.ClaudeCliProvider(profile, AgentMcp(profile, homes.project, ""))
        new = await provider.create_session(str(homes.project))
        with pytest.raises(Stop):
            await provider.prompt(new.id, "hi")
        transcript(homes.external)
        old = await provider.resume_session(SESSION, str(homes.project))
        with pytest.raises(Stop):
            await provider.prompt(old.id, "hi")
        await provider.close(old.id)
        assert old.id not in provider._external

        sdk = ClaudeProvider()
        sdk._sessions["s"] = SimpleNamespace(
            client=SimpleNamespace(_transport=SimpleNamespace(_cli_path="bundled-claude")),
            cwd=str(homes.project), external_home=False,
        )
        with pytest.raises(Stop):
            await sdk.validate_handoff("s")

    asyncio.run(run())
    status, new_turn, old_turn, handoff = (env for _, env in spawned)
    for env in (status, new_turn, handoff):
        assert env["CLAUDE_CONFIG_DIR"] == str(homes.claude)
    assert "CLAUDE_CONFIG_DIR" not in old_turn
    assert "--resume" in spawned[2][0] and SESSION in spawned[2][0]

    captured = []

    async def discover(project_path, **kwargs):
        captured.append(kwargs["env"])
        return ()

    monkeypatch.setattr(
        "cleo.integrations.harnesses.claude_models.discover_claude_models", discover,
    )
    asyncio.run(ClaudeProvider().list_models(str(homes.project)))
    assert captured[-1]["CLAUDE_CONFIG_DIR"] == str(homes.claude)
    assert "CLAUDE_CONFIG_DIR" not in os.environ


def test_claude_login_signs_in_to_cleo_home(homes, monkeypatch):
    from cleo.desktop import subscription_login

    captured = {}

    async def spawn(*args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs["env"]
        raise OSError("stop")

    monkeypatch.setattr(subscription_login, "executable", lambda _: "claude")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")

    async def run():
        state = {"output": ""}
        await subscription_login.SubscriptionLogins()._run(profile, homes.project, state)
        return state

    state = asyncio.run(run())
    assert state["status"] == "failed"
    assert captured["args"][1:] == ("auth", "login")
    assert captured["env"]["CLAUDE_CONFIG_DIR"] == str(homes.claude)
