import asyncio
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage

from cleo.cli.chat_tui import COMMANDS as CHAT_TUI_COMMANDS
from cleo.cli.productivity_tui import COMMANDS as PRODUCTIVITY_TUI_COMMANDS
from cleo.config.settings import MemoryGateSettings
from cleo.desktop.service import CHAT_COMMANDS, PRODUCTIVITY_COMMANDS, DesktopService
from cleo.harnesses.control import HarnessModel
from cleo.memory.paths import memory_state_path
from cleo.memory.state import (
    get_session_source,
    mark_consolidation_skipped,
    touch_session_source,
)
from cleo.sessions.store import SessionStore


class FakeRuntime:
    def __init__(self) -> None:
        self.current_thread_id = None
        self.current_space = "non_productivity"
        self.current_project = None
        self.projects = {
            "non_productivity": ["general"],
            "productivity": ["workspace"],
        }

    def projects_for(self, space: str) -> list[str]:
        return list(self.projects[space])

    def update_current_space(self, value: str) -> None:
        self.current_space = value

    def update_current_project(self, value: str) -> None:
        self.current_project = value
        if value not in self.projects[self.current_space]:
            self.projects[self.current_space].append(value)

    def update_current_thread_id(self, value: str) -> None:
        self.current_thread_id = value

    def append_recent_threads(self, _thread_id: str, _space: str) -> None:
        pass


class FakeProductivity:
    default_provider = "codex"
    providers = {
        "codex": SimpleNamespace(
            enabled=True,
            type="codex_sdk",
            model="gpt-test",
            models=[],
            options=SimpleNamespace(sandbox="workspace-write", approval_mode="on-request"),
        )
    }

    @classmethod
    def provider(cls, name: str):
        return cls.providers[name]


class FakeAdapter:
    def __init__(self, store: SessionStore) -> None:
        self.store = store
        self.created_with = None

    @property
    def providers(self):
        return ("codex",)

    async def list_models(self, provider):
        assert provider == "codex"
        return (
            HarnessModel(
                id="gpt-test",
                display_name="GPT Test",
                description="Test model",
                is_default=True,
                default_effort="high",
                supported_efforts=("low", "high"),
            ),
        )

    async def create_session(self, provider, *, project_path, model, project):
        self.created_with = {
            "provider": provider,
            "project_path": project_path,
            "model": model,
            "project": project,
        }
        session_id = "productivity-test"
        self.store.create_session(
            session_id=session_id,
            space="productivity",
            project=project,
            provider=provider,
            owner_type="user",
            native_session_id="native-test",
            cwd=project_path,
        )
        return SimpleNamespace(id=session_id, project=project, project_path=project_path)

    async def aclose(self) -> None:
        pass


def _service(tmp_path: Path) -> DesktopService:
    memory_root = tmp_path / "memory"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    primary_profile = SimpleNamespace(
        provider="openai",
        model="chat-test",
        max_tokens=64_000,
    )
    secondary_profile = SimpleNamespace(
        provider="openai",
        model="chat-secondary",
        max_tokens=32_000,
    )
    settings = SimpleNamespace(
        MEMORY_DIR=memory_root,
        SESSION_INDEX_PATH=memory_root / "sessions.sqlite3",
        memory_gate=MemoryGateSettings(),
        active_directory_profile=SimpleNamespace(root_path=workspace),
        active_agent_profile=primary_profile,
        active_profiles=SimpleNamespace(agent="primary"),
        profiles=SimpleNamespace(
            agents={"primary": primary_profile, "secondary": secondary_profile}
        ),
        active_shell_profile=SimpleNamespace(sandbox_root=workspace),
        productivity=FakeProductivity(),
    )
    store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
    return DesktopService(
        settings_model=settings,
        store=store,
        runtime=FakeRuntime(),
        adapter=SimpleNamespace(aclose=_async_none),
    )


async def _async_none() -> None:
    pass


def _normalized_commands(commands: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(command.rstrip() for command in commands))


def test_desktop_exposes_every_cli_slash_command() -> None:
    assert CHAT_COMMANDS == _normalized_commands(CHAT_TUI_COMMANDS)
    assert PRODUCTIVITY_COMMANDS == _normalized_commands(PRODUCTIVITY_TUI_COMMANDS)


def test_workspace_snapshot_and_chat_commands_use_real_session_store(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        initial = await service.load_workspace()
        assert initial["backend"]["mode"] == "local"
        assert initial["backend"]["commands"] == {
            "chat": list(CHAT_COMMANDS),
            "productivity": list(PRODUCTIVITY_COMMANDS),
        }
        assert initial["threads"] == []

        thread = await service.create_thread(
            space="chat",
            project_id_value="chat:general",
        )
        assert thread["projectId"] == "chat:general"
        assert service.store.load_manifest(thread["id"])["provider"] == "cleo"

        events = []

        async def emit(event):
            events.append(event)

        await service.stream_turn(
            thread_id=thread["id"],
            prompt="/rename Desktop session",
            attachments=[],
            emit=emit,
        )
        assert service.store.load_manifest(thread["id"])["title"] == "Desktop session"
        assert any(event["type"] == "refresh" for event in events)

        events.clear()
        await service.stream_turn(
            thread_id=thread["id"],
            prompt="/project move desktop",
            attachments=[],
            emit=emit,
        )
        assert service.store.load_manifest(thread["id"])["project"] == "desktop"
        assert any(event["type"] == "done" for event in events)

        service.store.append_event(
            space="non_productivity",
            project="desktop",
            session_id=thread["id"],
            event_type="user_message",
            actor="user",
            content="Keep this renamed session in desktop history",
        )

        snapshot = await service.load_workspace()
        assert snapshot["threads"][0]["title"] == "Desktop session"
        assert snapshot["threads"][0]["projectId"] == "chat:desktop"

    asyncio.run(scenario())


def test_workspace_hides_empty_chat_sessions_and_loads_saved_history(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        empty = await service.create_thread(
            space="chat",
            project_id_value="chat:general",
        )
        history = await service.create_thread(
            space="chat",
            project_id_value="chat:general",
        )
        service.store.sync_langchain_messages(
            session_id=history["id"],
            space="non_productivity",
            project="general",
            messages=[
                HumanMessage(content="Remember the saved question", id="human-saved"),
                AIMessage(content="The saved answer is available", id="ai-saved"),
            ],
            status="completed",
        )

        snapshot = await service.load_workspace()

        assert [thread["id"] for thread in snapshot["threads"]] == [history["id"]]
        assert empty["id"] not in {thread["id"] for thread in snapshot["threads"]}

        loaded = await service.load_thread(thread_id=history["id"])

        assert [item["content"] for item in loaded["items"] if item["type"] == "message"] == [
            "Remember the saved question",
            "The saved answer is available",
        ]
        assert service.runtime.current_thread_id == history["id"]

    asyncio.run(scenario())


def test_restore_chat_backups_copies_recoverable_history_without_deleting_backup(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        backup_memory = (
            tmp_path
            / "backups"
            / "memory-reset-20260724-120000-test"
            / "memory"
        )
        backup_store = SessionStore(backup_memory)
        backup_store.sync_langchain_messages(
            session_id="local-saved-backup",
            space="non_productivity",
            project="general",
            messages=[
                HumanMessage(content="Restore this question", id="human-backup"),
                AIMessage(content="Restore this answer", id="ai-backup"),
            ],
            status="completed",
        )
        backup_events = (
            backup_memory
            / "non_productivity"
            / "projects"
            / "general"
            / "sessions"
            / "local-saved-backup"
            / "events.jsonl"
        )

        before = await service.load_workspace()
        assert before["threads"] == []
        assert before["backend"]["recoverableChatBackups"] == 1

        restored = await service.restore_chat_backups()

        assert backup_events.is_file()
        assert restored["backend"]["recoverableChatBackups"] == 0
        assert len(restored["threads"]) == 1
        assert [
            item["content"]
            for item in restored["threads"][0]["items"]
            if item["type"] == "message"
        ] == ["Restore this question", "Restore this answer"]
        assert [
            message.content
            for message in service.store.load_langchain_messages(restored["threads"][0]["id"])
        ] == ["Restore this question", "Restore this answer"]

    asyncio.run(scenario())


def test_create_productivity_thread_uses_selected_workspace(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        adapter = FakeAdapter(service.store)
        service._adapter_instance = adapter
        selected = tmp_path / "selected-project"
        selected.mkdir()

        thread = await service.create_thread(
            space="productivity",
            project_id_value="",
            project_path=str(selected),
        )

        assert adapter.created_with == {
            "provider": "codex",
            "project_path": str(selected.resolve()),
            "model": "gpt-test",
            "project": "selected-project",
        }
        assert thread["projectId"] == "productivity:selected-project"
        assert service.store.load_manifest(thread["id"])["cwd"] == str(selected.resolve())

    asyncio.run(scenario())


def test_runtime_catalog_and_profile_selection_use_configured_models(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        service._adapter_instance = FakeAdapter(service.store)

        catalog = await service.get_runtime_catalog()
        assert [profile["id"] for profile in catalog["nonProductivityProfiles"]] == [
            "primary",
            "secondary",
        ]
        assert catalog["productivityProviders"] == [
            {
                "id": "codex",
                "type": "codex_sdk",
                "defaultModel": "gpt-test",
                "modelSource": "dynamic",
            }
        ]

        models = await service.get_productivity_models(provider="codex")
        assert models["source"] == "sdk"
        assert models["models"][0]["id"] == "gpt-test"

        thread = await service.create_thread(
            space="chat",
            project_id_value="chat:general",
            profile_id="secondary",
        )
        assert thread["runtime"]["profileId"] == "secondary"
        assert thread["runtime"]["model"] == "chat-secondary"

        service._chat_agents[thread["id"]] = object()
        service._chat_agents_restored.add(thread["id"])
        runtime = await service.update_runtime(
            thread_id=thread["id"],
            update={"profileId": "primary"},
        )
        assert runtime["profileId"] == "primary"
        assert thread["id"] not in service._chat_agents
        assert thread["id"] not in service._chat_agents_restored

    asyncio.run(scenario())


def test_review_memory_source_can_skip_pending_revision(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        state_path = memory_state_path(service.settings.MEMORY_DIR, "productivity")
        touch_session_source(
            space="productivity",
            project="workspace",
            session_id="session-review",
            source_hash="hash-review",
            last_event_seq=4,
            path=state_path,
        )

        snapshot = await service.review_memory_source(
            space="productivity",
            project="workspace",
            session_id="session-review",
            action="skip",
        )

        source = get_session_source(
            "productivity",
            "workspace",
            "session-review",
            path=state_path,
        )
        assert source is not None
        assert source["status"] == "skipped"
        assert source["processing_decision"] == "skipped"
        assert snapshot["memoryOverview"]["review_sources"] == []

    asyncio.run(scenario())


def test_review_memory_source_can_run_dream_agent(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        state_path = memory_state_path(service.settings.MEMORY_DIR, "productivity")
        touch_session_source(
            space="productivity",
            project="workspace",
            session_id="session-confirm",
            source_hash="hash-confirm",
            last_event_seq=7,
            path=state_path,
        )
        calls = []

        class FakeDreamAgent:
            async def invoke(self, **kwargs):
                calls.append(kwargs)
                reason = "Test DreamAgent completed the review."
                mark_consolidation_skipped(
                    "productivity",
                    "workspace",
                    "session-confirm",
                    "hash-confirm",
                    reason=reason,
                    gate_result={"provider": "test", "decision": "skip"},
                    path=state_path,
                )

        service._dream_agent_factory = FakeDreamAgent
        snapshot = await service.review_memory_source(
            space="productivity",
            project="workspace",
            session_id="session-confirm",
            action="consolidate",
        )

        assert calls == [
            {
                "space": "productivity",
                "project": "workspace",
                "session_id": "session-confirm",
            }
        ]
        assert snapshot["memoryOverview"]["review_sources"] == []

    asyncio.run(scenario())
