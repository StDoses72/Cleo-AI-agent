import asyncio
import base64
from pathlib import Path
from types import SimpleNamespace

import pytest
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


def test_chat_attachment_reads_document_from_local_path(tmp_path) -> None:
    document = tmp_path / "brief.pdf"
    document.write_bytes(b"%PDF-test")

    attachment = asyncio.run(
        DesktopService._chat_attachment(
            {
                "name": "brief.pdf",
                "path": str(document),
                "mimeType": "application/pdf",
            }
        )
    )

    assert attachment == {
        "name": "brief.pdf",
        "base64": base64.b64encode(b"%PDF-test").decode("ascii"),
        "mime_type": "application/pdf",
    }


class FakeRuntime:
    def __init__(self) -> None:
        self.current_thread_id = None
        self.current_space = "non_productivity"
        self.current_project = None
        self.projects = {
            "non_productivity": ["general"],
            "productivity": ["workspace"],
        }
        self.recent_threads = {
            "non_productivity": [],
            "productivity": [],
        }
        self.project_paths = {
            "non_productivity": {},
            "productivity": {},
        }
        self.removed_projects = {
            "non_productivity": [],
            "productivity": [],
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

    def append_recent_threads(self, thread_id: str, space: str) -> None:
        self.recent_threads[space] = [
            candidate for candidate in self.recent_threads[space] if candidate != thread_id
        ] + [thread_id]

    def forget_thread(self, thread_id: str, space: str) -> None:
        self.recent_threads[space] = [
            candidate for candidate in self.recent_threads[space] if candidate != thread_id
        ]
        if self.current_thread_id == thread_id:
            self.current_thread_id = None

    def register_project(self, space: str, name: str, path: str) -> None:
        if name not in self.projects[space]:
            self.projects[space].append(name)
        self.project_paths[space][name] = path
        self.removed_projects[space] = [
            project for project in self.removed_projects[space] if project != name
        ]

    def remove_project(self, space: str, name: str) -> None:
        self.projects[space] = [project for project in self.projects[space] if project != name]
        self.project_paths[space].pop(name, None)
        if name not in self.removed_projects[space]:
            self.removed_projects[space].append(name)
        if self.current_space == space and self.current_project == name:
            self.current_project = None
            self.current_thread_id = None

    def project_path(self, space: str, name: str) -> str | None:
        return self.project_paths[space].get(name)

    def is_project_removed(self, space: str, name: str) -> bool:
        return name in self.removed_projects[space]


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
        self.closed = []
        self.updated_with = None
        self.resolved = []
        self.approvals_enabled = []

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

    async def update_session_options(self, session_id, **changes):
        self.updated_with = {"session_id": session_id, **changes}
        manifest = self.store.load_manifest(session_id)
        current = manifest.get("runtime_options") or {}
        self.store.update_manifest(session_id, runtime_options={**current, **changes})

    def session_options(self, _session_id):
        return SimpleNamespace(approval_mode="auto_review")

    async def close(self, session_id: str) -> None:
        self.closed.append(session_id)

    async def resolve_approval(self, session_id, approval_id, decision):
        self.resolved.append((session_id, approval_id, decision))
        return {"id": approval_id, "decision": decision}

    async def enable_user_approvals(self, session_id):
        self.approvals_enabled.append(session_id)

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


def test_agent_instructions_use_active_non_productivity_root(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        path = service.settings.active_directory_profile.root_path / "AGENTS.md"
        path.write_text("# Existing instructions\n", encoding="utf-8")

        loaded = await service.get_agent_instructions()
        assert loaded == {
            "path": str(path),
            "content": "# Existing instructions\n",
            "exists": True,
        }

        service._chat_agents["chat-thread"] = object()
        service._chat_agents_restored.add("chat-thread")
        saved = await service.save_agent_instructions(content="# Updated instructions\n")

        assert saved == {
            "path": str(path),
            "content": "# Updated instructions\n",
            "exists": True,
        }
        assert path.read_bytes() == b"# Updated instructions\n"
        assert path.read_text(encoding="utf-8") == "# Updated instructions\n"
        assert service._chat_agents == {}
        assert service._chat_agents_restored == set()

    asyncio.run(scenario())


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


def test_productivity_thread_restores_nested_repo_diff_from_latest_turn(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        session_id = "nested-repo-diff"
        service.store.create_session(
            session_id=session_id,
            space="productivity",
            project="workspace",
            provider="codex",
            owner_type="user",
            native_session_id="native-nested",
            cwd=str(tmp_path / "workspace"),
        )
        diff = """diff --git a/nested/file.txt b/nested/file.txt
--- a/nested/file.txt
+++ b/nested/file.txt
@@ -1 +1 @@
-before
+after
"""
        service.store.append_events(
            space="productivity",
            project="workspace",
            session_id=session_id,
            events=[
                {"type": "user_message", "actor": "user", "content": "edit nested repo"},
                {
                    "type": "file_change",
                    "actor": "codex",
                    "content": diff,
                    "data": {
                        "provider_event_type": "turn/diff/updated",
                        "payload": {"diff": diff},
                    },
                },
                {"type": "session_completed", "actor": "system"},
            ],
        )

        thread = await service._thread(service.store.load_manifest(session_id))

        assert [change["path"] for change in thread["changes"]] == ["nested/file.txt"]

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
            effort="low",
        )

        assert adapter.created_with == {
            "provider": "codex",
            "project_path": str(selected.resolve()),
            "model": "gpt-test",
            "project": "selected-project",
        }
        assert thread["projectId"] == "productivity:selected-project"
        assert thread["runtime"]["effort"] == "low"
        assert thread["runtime"]["approval"] == "user"
        assert adapter.approvals_enabled == [thread["id"]]
        assert adapter.updated_with == {
            "session_id": thread["id"],
            "effort": "low",
        }
        runtime = await service.update_runtime(
            thread_id=thread["id"],
            update={"effort": "high"},
        )
        assert runtime["effort"] == "high"
        assert adapter.updated_with == {
            "session_id": thread["id"],
            "effort": "high",
        }
        assert service.store.load_manifest(thread["id"])["cwd"] == str(selected.resolve())

    asyncio.run(scenario())


def test_desktop_forwards_approval_decisions_to_active_codex_session(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        adapter = FakeAdapter(service.store)
        service._adapter_instance = adapter
        selected = tmp_path / "approval-project"
        selected.mkdir()
        thread = await service.create_thread(
            space="productivity",
            project_id_value="",
            project_path=str(selected),
        )

        result = await service.resolve_approval(
            thread_id=thread["id"],
            approval_id="approval-1",
            decision="accept",
        )

        assert result == {"id": "approval-1", "decision": "accept"}
        assert adapter.resolved == [(thread["id"], "approval-1", "accept")]

    asyncio.run(scenario())


def test_registered_project_directories_drive_both_agent_spaces(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        productivity_path = tmp_path / "mapped-productivity"
        chat_path = tmp_path / "mapped-chat"
        productivity_path.mkdir()
        chat_path.mkdir()

        productivity_snapshot = await service.add_project(
            space="productivity", project_path=str(productivity_path)
        )
        chat_snapshot = await service.add_project(space="chat", project_path=str(chat_path))

        assert next(
            project
            for project in productivity_snapshot["projects"]
            if project["id"] == "productivity:mapped-productivity"
        )["path"] == str(productivity_path.resolve())
        assert next(
            project
            for project in chat_snapshot["projects"]
            if project["id"] == "chat:mapped-chat"
        )["path"] == str(chat_path.resolve())

        adapter = FakeAdapter(service.store)
        service._adapter_instance = adapter
        productivity_thread = await service.create_thread(
            space="productivity",
            project_id_value="productivity:mapped-productivity",
        )
        chat_thread = await service.create_thread(
            space="chat",
            project_id_value="chat:mapped-chat",
        )

        assert adapter.created_with["project_path"] == str(productivity_path.resolve())
        assert service.store.load_manifest(productivity_thread["id"])["cwd"] == str(
            productivity_path.resolve()
        )
        assert service.store.load_manifest(chat_thread["id"])["cwd"] == str(
            chat_path.resolve()
        )

        captured_agent_options = {}

        class FakeGraph:
            async def aget_state(self, _config):
                return SimpleNamespace(values={"messages": []})

        class FakeChatAgent:
            deepagent = FakeGraph()
            context_usage = SimpleNamespace(
                used_tokens=0,
                window_tokens=64_000,
                input_tokens=0,
                output_tokens=0,
            )

            async def stream_text(self, *_args, **_kwargs):
                yield "done"

        def create_chat_agent(**options):
            captured_agent_options.update(options)
            return FakeChatAgent()

        service._agent_factory = create_chat_agent

        async def emit(_event):
            return None

        await service.stream_turn(
            thread_id=chat_thread["id"],
            prompt="work in this project",
            attachments=[],
            emit=emit,
        )

        assert captured_agent_options["project_path"] == str(chat_path.resolve())

    asyncio.run(scenario())


def test_remove_project_hides_history_without_deleting_it_and_reopen_restores_it(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        adapter = FakeAdapter(service.store)
        service._adapter_instance = adapter
        selected = tmp_path / "removable-project"
        selected.mkdir()
        await service.add_project(space="productivity", project_path=str(selected))
        thread = await service.create_thread(
            space="productivity",
            project_id_value="productivity:removable-project",
        )

        removed = await service.remove_project(
            project_id_value="productivity:removable-project"
        )

        assert "productivity:removable-project" not in {
            project["id"] for project in removed["projects"]
        }
        assert thread["id"] not in {item["id"] for item in removed["threads"]}
        assert service.store.load_manifest(thread["id"])["cwd"] == str(selected.resolve())
        assert selected.is_dir()

        restored = await service.add_project(space="productivity", project_path=str(selected))

        assert "productivity:removable-project" in {
            project["id"] for project in restored["projects"]
        }
        assert thread["id"] in {item["id"] for item in restored["threads"]}

    asyncio.run(scenario())


def test_delete_thread_handles_chat_and_productivity_sessions(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        first = await service.create_thread(
            space="chat",
            project_id_value="chat:general",
        )
        service.store.append_event(
            space="non_productivity",
            project="general",
            session_id=first["id"],
            event_type="user_message",
            actor="user",
            content="Keep this thread as the replacement",
        )
        second = await service.create_thread(
            space="chat",
            project_id_value="chat:general",
        )
        service.store.append_event(
            space="non_productivity",
            project="general",
            session_id=second["id"],
            event_type="user_message",
            actor="user",
            content="Delete this active thread",
        )

        service._run_tasks[second["id"]] = asyncio.current_task()
        with pytest.raises(ValueError, match="正在运行"):
            await service.delete_thread(thread_id=second["id"])
        service._run_tasks.pop(second["id"])
        assert service.store.load_manifest(second["id"])["id"] == second["id"]

        chat_snapshot = await service.delete_thread(thread_id=second["id"])

        assert [thread["id"] for thread in chat_snapshot["threads"]] == [first["id"]]
        assert chat_snapshot["activeThreadId"] == first["id"]
        assert service.runtime.current_thread_id == first["id"]
        with pytest.raises(FileNotFoundError):
            service.store.load_manifest(second["id"])

        adapter = FakeAdapter(service.store)
        service._adapter_instance = adapter
        selected = tmp_path / "delete-productivity"
        selected.mkdir()
        productivity = await service.create_thread(
            space="productivity",
            project_id_value="",
            project_path=str(selected),
        )

        productivity_snapshot = await service.delete_thread(thread_id=productivity["id"])

        assert adapter.closed == [productivity["id"]]
        assert productivity["id"] not in {
            thread["id"] for thread in productivity_snapshot["threads"]
        }
        with pytest.raises(FileNotFoundError):
            service.store.load_manifest(productivity["id"])

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


def test_static_acp_models_probe_configured_harness_connection(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        checked: list[str] = []

        class Control:
            async def list_models(self, project_path: str):
                checked.append(project_path)
                return ()

        class Adapter(FakeAdapter):
            @property
            def providers(self):
                return ("static-acp",)

            def provider_control(self, provider: str):
                assert provider == "static-acp"
                return Control()

        service.settings.productivity = SimpleNamespace(
            default_provider="static-acp",
            providers={
                "static-acp": SimpleNamespace(
                    enabled=True,
                    type="acp",
                    model=None,
                    models=[],
                    options=SimpleNamespace(model_config_id=None),
                )
            },
            provider=lambda name: service.settings.productivity.providers[name],
        )
        service._adapter_instance = Adapter(service.store)
        selected = tmp_path / "acp-project"
        selected.mkdir()

        models = await service.get_productivity_models(
            provider="static-acp",
            project_path=str(selected),
        )

        assert models["source"] == "config"
        assert models["models"][0] == {
            "id": "default",
            "label": "Harness default",
            "description": "Model selection is managed by the ACP harness",
            "isDefault": True,
            "defaultEffort": None,
            "supportedEfforts": [],
        }
        assert checked == [str(selected)]

    asyncio.run(scenario())


def test_claude_models_expose_sdk_effort_levels(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)

        class Adapter(FakeAdapter):
            @property
            def providers(self):
                return ("claude",)

        service.settings.productivity = SimpleNamespace(
            default_provider="claude",
            providers={
                "claude": SimpleNamespace(
                    enabled=True,
                    type="claude_sdk",
                    model="claude-opus-test",
                    models=["claude-sonnet-test"],
                    options=SimpleNamespace(permission_mode="acceptEdits"),
                )
            },
            provider=lambda name: service.settings.productivity.providers[name],
        )
        service._adapter_instance = Adapter(service.store)

        models = await service.get_productivity_models(provider="claude")

        assert [model["id"] for model in models["models"]] == [
            "claude-opus-test",
            "claude-sonnet-test",
        ]
        assert models["models"][0]["defaultEffort"] == "high"
        assert models["models"][0]["supportedEfforts"] == [
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        ]

    asyncio.run(scenario())


def test_memory_review_details_return_current_redacted_compact_events(tmp_path: Path) -> None:
    async def scenario() -> None:
        service = _service(tmp_path)
        service.store.create_session(
            session_id="session-details",
            space="productivity",
            project="workspace",
            provider="codex",
            owner_type="user",
        )
        service.store.append_events(
            space="productivity",
            project="workspace",
            session_id="session-details",
            events=[
                {
                    "id": "event-question",
                    "type": "user_message",
                    "actor": "user",
                    "content": "Remember this decision",
                },
                {
                    "id": "event-answer",
                    "type": "assistant_message",
                    "actor": "agent",
                    "content": "Decision captured",
                },
            ],
        )
        service.store.refresh_compact("session-details")

        details = await service.get_memory_review_details(
            space="productivity",
            project="workspace",
            session_id="session-details",
        )

        assert details["source_version"] == 1
        assert details["event_count"] == 3
        assert [(event["type"], event["content"]) for event in details["events"]] == [
            ("human", "Remember this decision"),
            ("ai", "Decision captured"),
        ]
        assert [event["type"] for event in details["omitted_events"]] == [
            "session_created"
        ]

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
