import asyncio

import pytest
from langchain_core.messages import HumanMessage

from cleo.agents import runtime as module
from cleo.agents.profiles import dream_profile, profile_snapshot, session_profile
from cleo.config.settings import AgentProfile, SettingsModel
from cleo.harnesses.models import AgentEvent, emit_event
from cleo.harnesses.provider import ProviderSession, ProviderTurn
from cleo.integrations.harnesses.acp import SessionResumeUnsupported
from cleo.sessions.store import SessionStore


def configuration(tmp_path):
    return SettingsModel.model_validate(
        {
            "active_profiles": {"agent": "login"},
            "profiles": {
                "agents": {
                    "login": {"backend": "codex", "provider": "codex", "model": "model-a"},
                    "other": {"provider": "openai", "model": "model-b", "api_key": "secret"},
                },
                "directories": {"default": {"root_dir": str(tmp_path)}},
            },
        }
    )


def test_dream_follows_source_and_explicit_override(tmp_path):
    settings = configuration(tmp_path)
    original = settings.active_agent_profile
    manifest = {
        "space": "non_productivity",
        "runtime_options": {
            "agent_profile": "login",
            "chat_profile": profile_snapshot(original),
        },
    }
    settings.active_profiles.agent = "other"
    settings.profiles.agents["login"].model = "new-global-model"
    assert dream_profile(settings, manifest).model == "model-a"
    assert dream_profile(settings, manifest).backend == "codex"
    settings.active_profiles.dream_agent = "other"
    assert dream_profile(settings, manifest).model == "model-b"
    assert "secret" not in str(profile_snapshot(settings.profiles.agents["other"]))


def test_dream_follows_development_session_model_without_a_chat_profile(tmp_path):
    settings = configuration(tmp_path)
    settings.active_profiles.agent = "other"
    manifest = {"space": "productivity", "provider": "codex",
                "runtime_options": {"model": "original-task-model", "future": ["keep"]}}
    before = repr(manifest)
    profile = dream_profile(settings, manifest)
    assert profile.backend == "codex"
    assert profile.model == "original-task-model"
    assert not profile.api_key.get_secret_value()
    assert repr(manifest) == before
    settings.active_profiles.dream_agent = "other"
    assert dream_profile(settings, manifest).model == "model-b"


def test_dream_follows_claude_task_and_rejects_unsupported_or_disabled_harness(tmp_path):
    from cleo.config.settings import ClaudeHarnessSettings

    settings = configuration(tmp_path)
    settings.productivity.providers["custom-claude"] = ClaudeHarnessSettings(model="fallback-model")
    manifest = {"space": "productivity", "provider": "custom-claude"}
    profile = dream_profile(settings, manifest)
    assert (profile.backend, profile.model) == ("claude_code", "fallback-model")
    settings.productivity.providers["custom-claude"].enabled = False
    with pytest.raises(ValueError, match="独立模型"):
        dream_profile(settings, manifest)
    manifest["provider"] = "unknown-harness"
    with pytest.raises(ValueError, match="独立模型"):
        dream_profile(settings, manifest)


def test_changed_or_removed_connection_never_falls_back(tmp_path):
    settings = configuration(tmp_path)
    manifest = {
        "runtime_options": {
            "agent_profile": "login",
            "chat_profile": profile_snapshot(settings.active_agent_profile),
        }
    }
    settings.profiles.agents["login"] = settings.profiles.agents["other"]
    with pytest.raises(ValueError, match="connection changed"):
        session_profile(settings, manifest)
    del settings.profiles.agents["login"]
    with pytest.raises(ValueError, match="no longer configured"):
        session_profile(settings, manifest)


@pytest.mark.parametrize("executable", ["/new/codex", None])
def test_saved_session_uses_current_executable_and_original_model(tmp_path, executable):
    settings = configuration(tmp_path)
    profile = settings.active_agent_profile
    profile.executable = "/old/codex"
    manifest = {"runtime_options": {
        "agent_profile": "login", "chat_profile": profile_snapshot(profile),
    }}
    profile.executable = executable
    profile.model = "new-default"
    restored = session_profile(settings, manifest)
    assert restored.executable == executable
    assert restored.model == "model-a"


@pytest.mark.parametrize("backend", ["codex", "gemini", "copilot", "grok", "claude_code"])
def test_runtime_profiles_require_no_api_key(backend):
    assert AgentProfile(backend=backend, provider=backend, model="default").backend == backend
    with pytest.raises(ValueError, match="official CLI"):
        AgentProfile(backend=backend, provider=backend, model="default", api_key="secret")


class FakeRuntime:
    def __init__(self):
        self.prompts = []
        self.resumes = []
        self.closes = []
        self.started = None
        self.failure = False
        self.unsupported_resume = False
        self.events = []

    async def create_session(self, cwd, model):
        if self.failure:
            raise RuntimeError("login expired")
        return ProviderSession("native", "native")

    async def resume_session(self, native, cwd, model):
        if self.unsupported_resume:
            raise SessionResumeUnsupported("unsupported")
        self.resumes.append(native)
        return ProviderSession(native, native)

    async def prompt(self, identifier, prompt, on_event):
        self.prompts.append(prompt)
        for event in self.events:
            await emit_event(on_event, event)
        await emit_event(
            on_event,
            AgentEvent(
                provider="codex",
                type="assistant_message_chunk",
                text="hello",
            ),
        )
        if self.started:
            self.started.set()
            await asyncio.Future()
        return ProviderTurn("native", "turn", "completed", "hello")

    async def close(self, identifier):
        self.closes.append(identifier)


def setup_runtime(tmp_path, monkeypatch, mode="chat"):
    settings = configuration(tmp_path)
    monkeypatch.setattr(module, "settings", settings)
    provider = FakeRuntime()
    monkeypatch.setattr(module, "create_runtime", lambda *_: provider)
    graph = module.RuntimeGraph(
        settings.active_agent_profile, tmp_path, "Cleo instructions", mode=mode
    )
    store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    return graph, provider, store


async def collect(graph, text):
    return [
        chunk.content
        async for chunk, _ in graph.astream(
            {"messages": [HumanMessage(text)]},
            config={"configurable": {"thread_id": "chat"}},
            stream_mode="messages",
        )
    ]


def test_resume_uses_native_history_without_replaying_it(tmp_path, monkeypatch):
    graph, provider, store = setup_runtime(tmp_path, monkeypatch)

    async def exercise():
        assert await collect(graph, "one") == ["hello"]
        fresh = module.RuntimeGraph(graph.profile, tmp_path, "Cleo instructions")
        assert await collect(fresh, "two") == ["hello"]

    asyncio.run(exercise())
    assert "Cleo instructions" in provider.prompts[0]
    assert provider.prompts[1] == "two"
    assert provider.resumes == ["native"]
    assert provider.closes == ["native", "native"]
    assert store.load_manifest("chat")["runtime_options"]["chat_native_id"] == "native"


def test_only_unsupported_resume_rebuilds_context(tmp_path, monkeypatch):
    graph, provider, _ = setup_runtime(tmp_path, monkeypatch)

    async def exercise():
        await collect(graph, "one")
        provider.unsupported_resume = True
        await collect(graph, "two")

    asyncio.run(exercise())
    assert '"content": "one"' in provider.prompts[1]
    assert len(provider.prompts) == 2


def test_startup_failure_terminates_stream_and_retains_input(tmp_path, monkeypatch):
    graph, provider, _ = setup_runtime(tmp_path, monkeypatch)
    provider.failure = True

    async def exercise():
        with pytest.raises(RuntimeError, match="login expired"):
            await asyncio.wait_for(collect(graph, "keep this"), 1)
        state = await graph.aget_state({"configurable": {"thread_id": "chat"}})
        assert state.values["messages"][0].content == "keep this"

    asyncio.run(exercise())


def test_cancel_closes_runtime_and_keeps_partial_response(tmp_path, monkeypatch):
    graph, provider, _ = setup_runtime(tmp_path, monkeypatch)

    async def exercise():
        provider.started = asyncio.Event()
        task = asyncio.create_task(collect(graph, "one"))
        await provider.started.wait()
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        state = await graph.aget_state({"configurable": {"thread_id": "chat"}})
        assert state.values["messages"][-1].content == "hello"

    asyncio.run(exercise())
    assert provider.closes == ["native"]


def test_dream_starts_separate_runtime_and_does_not_replace_chat_id(tmp_path, monkeypatch):
    graph, provider, store = setup_runtime(tmp_path, monkeypatch, "dream")
    store.create_session(
        session_id="chat",
        space="non_productivity",
        project="general",
        provider="cleo",
        owner_type="user",
    )
    store.update_manifest("chat", runtime_options={"chat_native_id": "original-chat"})
    asyncio.run(collect(graph, "consolidate"))
    assert not provider.resumes
    assert store.load_manifest("chat")["runtime_options"]["chat_native_id"] == "original-chat"


def test_subscription_usage_reaches_agent_and_saved_history(tmp_path, monkeypatch):
    from cleo.agents import Agent
    from cleo.desktop.service import DesktopService
    from cleo.runtime.usage import ContextWindowUsage

    graph, provider, store = setup_runtime(tmp_path, monkeypatch)
    provider.events = [AgentEvent(provider="codex", type="status", data={
        "provider_event_type": "thread/tokenUsage/updated",
        "payload": {"tokenUsage": {
            "total": {"totalTokens": 1400},
            "last": {"inputTokens": 120, "outputTokens": 30},
            "modelContextWindow": 256000,
        }},
    })]
    agent = Agent.__new__(Agent)
    agent.deepagent = graph
    agent.context_usage = ContextWindowUsage(window_tokens=100000)

    async def exercise():
        return [text async for text in agent.stream_text("hello", thread_id="chat")]

    assert asyncio.run(exercise()) == ["hello"]
    expected = {"used": 1400, "limit": 256000, "input": 120, "output": 30}
    assert DesktopService._usage_dict(agent.context_usage) == expected
    assert DesktopService._usage_from_events(store.read_events("chat"), 100000) == expected
