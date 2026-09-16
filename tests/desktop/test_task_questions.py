"""Agent questions stay reachable for newly created and reopened development tasks."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from cleo.desktop.service import DesktopService
from cleo.harnesses.control import SessionOptions
from cleo.harnesses.provider import ProviderSession
from cleo.harnesses.questions import QuestionBroker, normalize_questions
from cleo.harnesses.service import AgentService
from cleo.sessions.store import SessionStore


class QuestionProvider:
    """A harness whose sessions own a real QuestionBroker, like Codex and Claude do."""

    name = "codex"

    def __init__(self) -> None:
        self.brokers: dict[str, QuestionBroker] = {}
        self.options = SessionOptions(model="gpt-test", approval_mode="on-request")
        self.approvals_enabled: list[str] = []

    async def create_session(self, project_path: str, model: str | None = None):
        self.brokers["provider-new"] = QuestionBroker(self.name)
        return ProviderSession(id="provider-new", native_id="native-task")

    async def resume_session(self, native_session_id: str, project_path: str, model=None):
        self.brokers["provider-resumed"] = QuestionBroker(self.name)
        return ProviderSession(id="provider-resumed", native_id=native_session_id)

    async def prompt(self, session_id, prompt, on_event=None):  # pragma: no cover - unused here
        raise NotImplementedError

    def session_options(self, _session_id: str) -> SessionOptions:
        return self.options

    async def update_session_options(self, _session_id: str, **changes) -> SessionOptions:
        self.options = SessionOptions(**{**self.options.as_dict(), **changes})
        return self.options

    async def enable_user_approvals(self, session_id: str) -> None:
        self.approvals_enabled.append(session_id)

    def pending_questions(self, session_id: str) -> list[dict]:
        return self.brokers[session_id].list_pending()

    async def resolve_question(self, session_id: str, question_id: str, answers: dict) -> dict:
        return await self.brokers[session_id].resolve(question_id, answers)

    async def enable_questions(self, session_id: str) -> None:
        self.brokers[session_id].enabled = True

    async def cancel(self, session_id: str) -> None:
        pass

    async def close(self, session_id: str) -> None:
        pass


class _Runtime:
    """The navigation state DesktopService writes while creating a task."""

    def __init__(self) -> None:
        self.paths: dict[tuple[str, str], str] = {}
        self.current_thread_id: str | None = None

    def register_project(self, space: str, name: str, path: str) -> None:
        self.paths[(space, name)] = path

    def project_path(self, space: str, name: str) -> str | None:
        return self.paths.get((space, name))

    def update_current_space(self, value: str) -> None:
        self.space = value

    def update_current_project(self, value: str) -> None:
        self.project = value

    def update_current_thread_id(self, value: str) -> None:
        self.current_thread_id = value

    def append_recent_threads(self, thread_id: str, space: str) -> None:
        pass


_PROVIDER_SETTINGS = SimpleNamespace(
    enabled=True,
    type="codex_sdk",
    model="gpt-test",
    models=[],
    options=SimpleNamespace(sandbox="workspace-write", approval_mode="on-request"),
)


class _Productivity:
    default_provider = "codex"
    providers = {"codex": _PROVIDER_SETTINGS}

    @classmethod
    def provider(cls, name: str):
        return cls.providers[name]


def _service(tmp_path: Path) -> tuple[DesktopService, QuestionProvider, Path]:
    memory_root = tmp_path / "memory"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    from cleo.config.settings import AgentProfile

    profile = AgentProfile(
        provider="openai", model="chat-test", max_tokens=64_000, api_key="test-key",
    )

    async def _aclose() -> None:
        pass

    settings = SimpleNamespace(
        MEMORY_DIR=memory_root,
        SESSION_INDEX_PATH=memory_root / "sessions.sqlite3",
        active_directory_profile=SimpleNamespace(root_path=workspace),
        active_agent_profile=profile,
        active_profiles=SimpleNamespace(agent="primary"),
        profiles=SimpleNamespace(agents={"primary": profile}),
        active_shell_profile=SimpleNamespace(sandbox_root=workspace),
        productivity=_Productivity(),
    )
    service = DesktopService(
        settings_model=settings,
        store=SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH),
        runtime=_Runtime(),
        adapter=SimpleNamespace(aclose=_aclose),
    )
    adapter = AgentService(
        workspace, session_store=service.store, space="productivity", owner_type="user",
    )
    provider = QuestionProvider()
    adapter.register(provider)
    service._adapter_instance = adapter
    return service, provider, workspace


async def _ask(broker: QuestionBroker) -> asyncio.Task:
    """Raise one pending question the way a provider does inside a turn."""
    broker.bind(lambda _event: None)
    task = asyncio.create_task(
        broker.ask(normalize_questions([{"id": "scope", "question": "Which scope?"}]))
    )
    await asyncio.sleep(0)
    return task


@pytest.mark.parametrize("effort", [None, "high"])
def test_new_development_task_can_ask_and_receive_an_answer(tmp_path: Path, effort) -> None:
    async def scenario() -> None:
        service, provider, workspace = _service(tmp_path)
        thread = await service.create_thread(
            space="productivity",
            project_id_value="productivity:workspace",
            project_path=str(workspace),
            effort=effort,
        )
        broker = provider.brokers["provider-new"]
        assert broker.enabled, "a newly created task never enabled the question channel"

        task = await _ask(broker)
        pending = await service.get_pending_questions(thread_id=thread["id"])
        assert [request["id"] for request in pending] == [broker.list_pending()[0]["id"]]
        assert pending[0]["threadId"] == thread["id"]

        await service.resolve_question(
            thread_id=thread["id"], question_id=pending[0]["id"], answers={"scope": ["backend"]},
        )
        assert await asyncio.wait_for(task, 2) == {"scope": ["backend"]}
        assert await service.get_pending_questions(thread_id=thread["id"]) == []

    asyncio.run(scenario())


def test_reopened_development_task_can_ask_and_receive_an_answer(tmp_path: Path) -> None:
    async def scenario() -> None:
        service, provider, workspace = _service(tmp_path)
        thread = await service.create_thread(
            space="productivity",
            project_id_value="productivity:workspace",
            project_path=str(workspace),
        )
        # Reopening Cleo drops the live harness session; the saved manifest stays.
        service._productivity_sessions.clear()
        service._adapter_instance._sessions.clear()
        assert await service.get_pending_questions(thread_id=thread["id"]) == []

        await service._ensure_productivity_session(service.store.load_manifest(thread["id"]))
        broker = provider.brokers["provider-resumed"]
        assert broker.enabled, "a reopened task never re-enabled the question channel"

        task = await _ask(broker)
        pending = await service.get_pending_questions(thread_id=thread["id"])
        assert len(pending) == 1
        await service.resolve_question(
            thread_id=thread["id"], question_id=pending[0]["id"], answers={"scope": ["ui"]},
        )
        assert await asyncio.wait_for(task, 2) == {"scope": ["ui"]}

    asyncio.run(scenario())
