"""Agent questions stay reachable for newly created and reopened development tasks."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from cleo.desktop.service import DesktopService
from cleo.harnesses.capabilities import Capability
from cleo.harnesses.control import SessionOptions
from cleo.harnesses.provider import ProviderSession
from cleo.harnesses.questions import QuestionBroker, normalize_questions
from cleo.harnesses.service import AgentService
from cleo.sessions.store import SessionStore


class QuestionProvider:
    """A harness whose sessions own a real QuestionBroker, like Codex and Claude do."""

    name = "codex"
    provider_type = "codex_sdk"
    capabilities = frozenset({Capability.QUESTIONS, Capability.USER_APPROVALS, Capability.FORK})

    def __init__(self) -> None:
        self.brokers: dict[str, QuestionBroker] = {}
        self.options = SessionOptions(model="gpt-test", approval_mode="on-request")
        self.session_settings: dict[str, SessionOptions] = {}
        self.approvals_enabled: list[str] = []
        self.closed: list[str] = []

    async def create_session(self, project_path: str, model: str | None = None):
        session_id = "provider-new" if not self.brokers else f"provider-new-{len(self.brokers)}"
        self.brokers[session_id] = QuestionBroker(self.name)
        self.session_settings[session_id] = self.options
        return ProviderSession(id=session_id, native_id=f"native-{session_id}")

    async def resume_session(self, native_session_id: str, project_path: str, model=None):
        self.brokers["provider-resumed"] = QuestionBroker(self.name)
        self.session_settings["provider-resumed"] = self.options
        return ProviderSession(id="provider-resumed", native_id=native_session_id)

    async def fork_session(self, session_id: str):
        child = await self.create_session(".")
        self.session_settings[child.id] = self.session_settings[session_id]
        return child

    async def prompt(self, session_id, prompt, on_event=None):  # pragma: no cover - unused here
        raise NotImplementedError

    def session_options(self, session_id: str) -> SessionOptions:
        return self.session_settings[session_id]

    async def update_session_options(self, session_id: str, **changes) -> SessionOptions:
        self.session_settings[session_id] = SessionOptions(**{
            **self.session_settings[session_id].as_dict(),
            **{key: value for key, value in changes.items() if value is not None},
        })
        return self.session_settings[session_id]

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
        self.closed.append(session_id)
        await self.brokers[session_id].cancel_all()


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


@pytest.mark.parametrize("command", ["/cd", "/resume-native", "/fork"])
def test_command_sessions_enable_questions_and_preserve_saved_permissions(tmp_path, command):
    async def scenario():
        service, provider, workspace = _service(tmp_path)
        source = await service.create_thread(space="productivity", project_path=str(workspace),
                                             project_id_value="productivity:workspace")
        argument = str(workspace) if command == "/cd" else ""
        if command == "/resume-native":
            target = await service._adapter().create_session("codex", str(workspace))
            await service._adapter().update_session_options(target.id, approval_mode="deny_all")
            await service._adapter().close(target.id)
            argument = target.native_session_id
        elif command == "/fork":
            await service.update_runtime(thread_id=source["id"], update={"approval": "deny_all"})
        emitted = []

        async def emit(event):
            emitted.append(event)

        await service._run_productivity_command(
            service.store.load_manifest(source["id"]), command, argument, emit,
        )
        adopted_id = next(event["activeThreadId"] for event in emitted
                          if event["type"] == "refresh")
        native_id = "provider-resumed" if command == "/resume-native" else "provider-new-1"
        broker = provider.brokers[native_id]
        assert broker.enabled
        assert native_id in provider.approvals_enabled
        assert adopted_id in service._productivity_sessions
        if command != "/cd":
            assert provider.session_options(native_id).approval_mode == "deny_all"
        pending_task = await _ask(broker)
        pending = await service.get_pending_questions(thread_id=adopted_id)
        await service.resolve_question(thread_id=adopted_id, question_id=pending[0]["id"],
                                       answers={"scope": ["adopted"]})
        assert await asyncio.wait_for(pending_task, 2) == {"scope": ["adopted"]}
        await service._adapter().aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize("entry", ["create", "/cd", "/resume-native", "/fork"])
@pytest.mark.parametrize("failure", ["error", "cancel"])
def test_failed_session_setup_releases_route_without_publishing_cache(tmp_path, entry, failure):
    async def scenario():
        service, provider, workspace = _service(tmp_path)
        source = None
        if entry != "create":
            source = await service.create_thread(
                space="productivity", project_id_value="productivity:workspace",
                project_path=str(workspace),
            )
        entered = asyncio.Event()

        async def fail(_session_id):
            entered.set()
            if failure == "cancel":
                await asyncio.Event().wait()
            raise ValueError("setup failed")

        provider.enable_questions = fail

        async def emit(_event):
            pass

        operation = (service.create_thread(
            space="productivity", project_id_value="productivity:workspace",
            project_path=str(workspace),
        ) if entry == "create" else service._run_productivity_command(
            service.store.load_manifest(source["id"]), entry,
            str(workspace) if entry == "/cd" else "external-native", emit,
        ))
        task = asyncio.create_task(operation)
        if failure == "cancel":
            await asyncio.wait_for(entered.wait(), 2)
            new_id = next(row["id"] for row in service.store.list_sessions()
                          if source is None or row["id"] != source["id"])
            assert new_id not in service._productivity_sessions
            task.cancel()
        with pytest.raises(asyncio.CancelledError if failure == "cancel" else ValueError):
            await task
        retained = [row for row in service.store.list_sessions()
                    if source is None or row["id"] != source["id"]]
        assert len(retained) == 1
        assert retained[0]["id"] not in service._productivity_sessions
        assert retained[0]["status"] == "closed"
        with pytest.raises(KeyError, match="Unknown agent session"):
            service._adapter().session_provider_type(retained[0]["id"])
        assert provider.closed
        if source is not None:
            assert source["id"] in service._productivity_sessions
        await service._adapter().aclose()

    asyncio.run(scenario())
