"""Thin desktop service reusing Cleo's existing runtime and persistence layers."""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import secrets
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from cleo.desktop.configuration import (
    create_model_connection,
    read_model_settings,
    remove_model_connection,
    rename_model_connection,
    save_dream_settings,
    save_model_profile,
    select_chat_model,
)
from cleo.desktop.projection import (
    change_history_from_events,
    changes_from_diff,
    final_changes_from_diff,
    finalize_stream_tools,
    latest_turn_changes,
    path_name,
    project_id,
    project_name_from_id,
    relative_time,
    stream_event_item,
    timeline_from_events,
)
from cleo.harnesses.control import HarnessModel
from cleo.integrations.background import launch_dream_agent_worker
from cleo.integrations.git import (
    create_git_checkpoint,
    discard_git_checkpoint,
    finalize_git_checkpoint,
    inspect_git_status,
    read_git_checkpoint_diff,
    read_git_diff,
    undo_git_checkpoint,
)
from cleo.integrations.harnesses.claude import CLAUDE_EFFORTS
from cleo.integrations.workspace import resolve_productivity_cwd
from cleo.memory.compaction import load_events, load_validated_compact
from cleo.memory.overview import build_memory_overview
from cleo.memory.paths import memory_state_path
from cleo.memory.state import (
    get_session_source,
    mark_consolidation_failed,
    mark_consolidation_skipped,
    mark_consolidation_started,
)
from cleo.runtime.usage import ContextWindowUsage

Emit = Callable[[dict[str, Any]], Awaitable[None]]

MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024
MAX_CHAT_ATTACHMENT_COUNT = 20

CHAT_COMMANDS = (
    "/help",
    "/new",
    "/project",
    "/project move",
    "/sessions",
    "/resume",
    "/rename",
    "/attach",
    "/productivity",
    "/quit",
)

PRODUCTIVITY_COMMANDS = (
    "/help",
    "/new",
    "/cwd",
    "/project",
    "/git",
    "/diff",
    "/model",
    "/effort",
    "/access",
    "/approval",
    "/cd",
    "/resume",
    "/resume-native",
    "/native",
    "/sessions",
    "/account",
    "/fork",
    "/rename",
    "/compact",
    "/archive",
    "/back",
    "/quit",
)


def _create_default_dream_agent():
    """Import and construct DreamAgent outside the desktop event-loop thread."""
    from cleo.agents.dream import DreamAgent

    return DreamAgent()


class DesktopService:
    """Application-facing facade over SessionStore, Agent, and AgentAdapter."""

    def __init__(
        self,
        *,
        settings_model: Any | None = None,
        store: Any | None = None,
        runtime: Any | None = None,
        agent_factory: Callable[..., Any] | None = None,
        dream_agent_factory: Callable[[], Any] | None = None,
        adapter: Any | None = None,
    ) -> None:
        if settings_model is None:
            from cleo.config.settings import settings as settings_model
        if store is None:
            from cleo.sessions.store import SessionStore

            store = SessionStore(settings_model.MEMORY_DIR, settings_model.SESSION_INDEX_PATH)
        if runtime is None:
            from cleo.runtime.state import Runtime

            runtime = Runtime()
        self.settings = settings_model
        self.store = store
        self.runtime = runtime
        self._agent_factory = agent_factory
        self._dream_agent_factory = dream_agent_factory
        self._adapter_instance = adapter
        self._chat_agents: dict[str, Any] = {}
        self._chat_agents_restored: set[str] = set()
        from cleo.desktop.subscription_login import SubscriptionLogins

        self._subscription_logins = SubscriptionLogins()
        self._productivity_sessions: dict[str, Any] = {}
        self._run_tasks: dict[str, asyncio.Task[Any]] = {}
        self._project_paths: dict[str, str] = {}

    async def load_workspace(self) -> dict[str, Any]:
        self._debug("load rows")
        rows = self.store.list_sessions()
        records: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for row in rows:
            if len(records) >= 100:
                break
            try:
                manifest = self.store.load_manifest(str(row["id"]))
                if self._is_removed_project(manifest):
                    continue
                events = self.store.read_events(manifest["id"])
            except (FileNotFoundError, OSError, ValueError):
                continue
            if manifest["space"] == "non_productivity" and not self._has_chat_history(events):
                continue
            records.append((manifest, events))
        manifests = [manifest for manifest, _events in records]
        self._debug("load projects")
        projects = await self._projects(manifests)
        self._debug("load threads")
        threads = [
            await self._thread(manifest, events=events) for manifest, events in records
        ]
        self._debug("load overview")
        overview = build_memory_overview(
            memory_root=self.settings.MEMORY_DIR,
        )
        memories = [self._memory_entry(entry) for entry in overview["entries"]]
        self._debug("load result")
        active_manifest = next(
            (
                manifest
                for manifest in manifests
                if manifest["id"] == self.runtime.current_thread_id
            ),
            manifests[0] if manifests else None,
        )
        return {
            "projects": projects,
            "threads": threads,
            "memories": memories,
            "memoryOverview": overview,
            "runtime": self._runtime_profile(active_manifest),
            "activeThreadId": active_manifest["id"] if active_manifest else None,
            "activeSpace": self._ui_space(active_manifest["space"])
            if active_manifest
            else "productivity",
            "backend": {
                "connected": True,
                "mode": "local",
                "commands": {
                    "chat": list(CHAT_COMMANDS),
                    "productivity": list(PRODUCTIVITY_COMMANDS),
                },
                "recoverableChatBackups": len(self._chat_backup_candidates()),
            },
        }

    async def load_thread(self, *, thread_id: str) -> dict[str, Any]:
        """Reload one persisted thread and make it the active resume target."""
        manifest = self.store.load_manifest(thread_id)
        self._activate(manifest)
        return await self._thread(manifest)

    async def delete_thread(self, *, thread_id: str) -> dict[str, Any]:
        """Delete one local thread after releasing any resident provider session."""
        manifest = self.store.load_manifest(thread_id)
        if thread_id in self._run_tasks:
            raise ValueError("正在运行的 thread 不能删除，请先停止运行。")

        was_active = self.runtime.current_thread_id == thread_id
        if manifest["space"] == "productivity" and thread_id in self._productivity_sessions:
            await self._adapter().close(thread_id)
            self._productivity_sessions.pop(thread_id, None)
        self._chat_agents.pop(thread_id, None)
        self._chat_agents_restored.discard(thread_id)
        checkpoint = manifest.get("undo_checkpoint")
        if isinstance(checkpoint, dict):
            try:
                await asyncio.to_thread(discard_git_checkpoint, checkpoint)
            except (OSError, RuntimeError, ValueError):
                # A stale private ref must not prevent deletion of the owning thread.
                pass
        self.store.delete_session(thread_id)
        self.runtime.forget_thread(thread_id, str(manifest["space"]))

        if was_active:
            candidates: list[dict[str, Any]] = []
            for row in self.store.list_sessions():
                try:
                    candidate = self.store.load_manifest(str(row["id"]))
                    if candidate["space"] == "non_productivity" and not self._has_chat_history(
                        self.store.read_events(str(candidate["id"]))
                    ):
                        continue
                except (FileNotFoundError, OSError, ValueError):
                    continue
                candidates.append(candidate)
            replacement = next(
                (
                    candidate
                    for candidate in candidates
                    if candidate["space"] == manifest["space"]
                    and candidate["project"] == manifest["project"]
                ),
                None,
            ) or next(
                (
                    candidate
                    for candidate in candidates
                    if candidate["space"] == manifest["space"]
                ),
                None,
            )
            if replacement is not None:
                self._activate(replacement)
        return await self.load_workspace()

    async def add_project(self, *, space: str, project_path: str) -> dict[str, Any]:
        """Register a local project directory and return the refreshed workspace."""
        memory_space = "non_productivity" if space == "chat" else "productivity"
        if space not in {"chat", "productivity"}:
            raise ValueError(f"不支持的项目空间：{space}")
        path = Path(project_path).expanduser().resolve()
        if not path.is_dir():
            raise ValueError(f"工作目录不存在或不是文件夹：{path}")
        name = path_name(str(path), "workspace")
        existing = self.runtime.project_path(memory_space, name)
        if existing is not None and os.path.normcase(existing) != os.path.normcase(str(path)):
            raise ValueError(f"已有同名项目“{name}”映射到：{existing}")
        self.runtime.register_project(memory_space, name, str(path))
        self._project_paths[project_id(memory_space, name)] = str(path)
        return await self.load_workspace()

    async def remove_project(self, *, project_id_value: str) -> dict[str, Any]:
        """Remove a project from navigation without deleting local data."""
        if project_id_value.startswith("chat:"):
            memory_space = "non_productivity"
            ui_space = "chat"
        elif project_id_value.startswith("productivity:"):
            memory_space = "productivity"
            ui_space = "productivity"
        else:
            raise ValueError("无效的项目 ID。")
        name = project_name_from_id(project_id_value)
        if memory_space == "non_productivity" and name == "general":
            raise ValueError("默认的 general 项目不能移除。")
        manifests = []
        for row in self.store.list_sessions(space=memory_space):
            try:
                manifest = self.store.load_manifest(str(row["id"]))
            except (FileNotFoundError, OSError, ValueError):
                continue
            if not self._is_removed_project(manifest):
                manifests.append(manifest)
        visible_projects = [
            project
            for project in await self._projects(manifests)
            if project["space"] == ui_space
        ]
        if project_id_value not in {project["id"] for project in visible_projects}:
            raise ValueError(f"找不到项目：{name}")
        if len(visible_projects) <= 1:
            raise ValueError("至少需要保留一个项目。请先打开另一个工作目录。")
        for thread_id in self._run_tasks:
            try:
                manifest = self.store.load_manifest(thread_id)
            except (FileNotFoundError, OSError, ValueError):
                continue
            if manifest["space"] == memory_space and manifest["project"] == name:
                raise ValueError("该项目中有正在运行的任务，请先停止运行。")
        for manifest in manifests:
            if manifest["project"] != name:
                continue
            thread_id = str(manifest["id"])
            if memory_space == "productivity" and thread_id in self._productivity_sessions:
                await self._adapter().close(thread_id)
                self._productivity_sessions.pop(thread_id, None)
            self._chat_agents.pop(thread_id, None)
            self._chat_agents_restored.discard(thread_id)
        self.runtime.remove_project(memory_space, name)
        self._project_paths.pop(project_id_value, None)
        return await self.load_workspace()

    async def restore_chat_backups(self) -> dict[str, Any]:
        """Copy recoverable chat histories out of memory-reset backups."""
        existing_ids = {str(row["id"]) for row in self.store.list_sessions()}
        first_restored_id: str | None = None
        for candidate in self._chat_backup_candidates():
            source_id = candidate["source_id"]
            target_id = source_id
            if target_id in existing_ids:
                target_id = f"restored-{source_id}"
            if target_id in existing_ids:
                continue
            copied_events = [
                {
                    key: event[key]
                    for key in (
                        "type",
                        "actor",
                        "content",
                        "data",
                        "message",
                        "source_message_id",
                        "id",
                        "created_at",
                    )
                    if key in event
                }
                for event in candidate["events"]
                if event.get("type") != "session_created"
                and str(event.get("type") or "").strip()
                and str(event.get("actor") or "").strip()
            ]
            if not self._has_chat_history(copied_events):
                continue
            self.store.create_session(
                session_id=target_id,
                space="non_productivity",
                project=candidate["project"],
                provider="cleo",
                owner_type="user",
                cwd=str(self.settings.MEMORY_DIR.parent),
            )
            self.store.append_events(
                space="non_productivity",
                project=candidate["project"],
                session_id=target_id,
                events=copied_events,
                manifest_updates={
                    "status": "completed",
                    "tags": [f"restored-backup:{source_id}"],
                },
            )
            self.store.refresh_compact(target_id)
            existing_ids.add(target_id)
            if first_restored_id is None:
                first_restored_id = target_id

        if first_restored_id is not None:
            self._activate(self.store.load_manifest(first_restored_id))
        return await self.load_workspace()

    async def review_memory_source(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
        action: str,
    ) -> dict[str, Any]:
        """Resolve one source in the desktop memory review queue."""
        if action not in {"consolidate", "skip"}:
            raise ValueError(f"不支持的记忆处理动作：{action}")
        state_path = memory_state_path(self.settings.MEMORY_DIR, space)
        source = get_session_source(space, project, session_id, path=state_path)
        if source is None:
            raise ValueError("待确认的记忆来源不存在")
        if source.get("status") not in {"pending", "failed"}:
            raise ValueError("这个记忆来源已被处理，请刷新后重试")

        if action == "skip":
            reason = "用户在桌面待确认队列中忽略了本次来源。"
            mark_consolidation_skipped(
                space,
                project,
                session_id,
                str(source["source_hash"]),
                reason=reason,
                review_result={"provider": "manual", "decision": "skip", "reason": reason},
                path=state_path,
            )
        else:
            mark_consolidation_started(
                space,
                project,
                session_id,
                str(source["source_hash"]),
                phase="initializing",
                path=state_path,
            )
            try:
                factory = self._dream_agent_factory or _create_default_dream_agent
                dream_agent = await asyncio.to_thread(factory)
                await dream_agent.invoke(
                    space=space, project=project, session_id=session_id, force=True,
                )
            except Exception as exc:
                current = get_session_source(space, project, session_id, path=state_path)
                if current is None or current.get("status") != "failed":
                    mark_consolidation_failed(
                        space,
                        project,
                        session_id,
                        str(source["source_hash"]),
                        str(exc),
                        path=state_path,
                    )
                raise

        return await self.load_workspace()

    async def get_memory_review_details(
        self,
        *,
        space: str,
        project: str,
        session_id: str,
    ) -> dict[str, Any]:
        """Return the current redacted compact projection for one review source."""
        source = get_session_source(
            space,
            project,
            session_id,
            path=memory_state_path(self.settings.MEMORY_DIR, space),
        )
        if source is None or source.get("status") not in {"pending", "failed"}:
            raise ValueError("待确认的记忆来源不存在或已被处理")
        payload = load_validated_compact(
            memory_root=self.settings.MEMORY_DIR,
            space=space,
            project=project,
            session_id=session_id,
        )
        compact_source = payload.get("source") or {}
        if compact_source.get("source_content_hash") != source.get("source_hash"):
            raise ValueError("这个记忆来源已更新，请刷新后重试")

        events = []
        represented_event_ids: set[str] = set()
        for event in payload.get("events") or []:
            if not isinstance(event, dict):
                continue
            represented_event_ids.update(
                str(event_id) for event_id in event.get("source_event_ids") or []
            )
            events.append(
                {
                    "id": str(event.get("id") or ""),
                    "type": str(event.get("type") or "unknown"),
                    "content": event.get("content"),
                    "created_at": event.get("created_at"),
                    "metadata": {
                        key: value
                        for key, value in event.items()
                        if key
                        not in {
                            "id",
                            "type",
                            "content",
                            "created_at",
                            "source_event_ids",
                        }
                    },
                }
            )
        omitted_events = [
            {
                "id": str(event.get("id") or ""),
                "seq": int(event.get("seq", 0)),
                "type": str(event.get("type") or "unknown"),
                "actor": str(event.get("actor") or "unknown"),
                "created_at": event.get("created_at"),
            }
            for event in self.store.read_events(session_id)
            if str(event.get("id") or "") not in represented_event_ids
        ]
        return {
            "id": f"{space}:{project}:{session_id}",
            "source_version": int(source.get("source_version", 0)),
            "event_count": int(compact_source.get("event_count", len(events))),
            "events": events,
            "omitted_events": omitted_events,
        }

    async def create_thread(
        self,
        *,
        space: str,
        project_id_value: str,
        provider: str | None = None,
        model: str | None = None,
        effort: str | None = None,
        profile_id: str | None = None,
        project_path: str | None = None,
    ) -> dict[str, Any]:
        memory_space = "non_productivity" if space == "chat" else "productivity"
        if space not in {"chat", "productivity"}:
            raise ValueError(f"不支持的项目空间：{space}")
        project = project_name_from_id(project_id_value)
        selected_path: str | None = None
        if project_path is not None:
            path = Path(project_path).expanduser().resolve()
            if not path.is_dir():
                raise ValueError(f"工作目录不存在或不是文件夹：{path}")
            selected_path = str(path)
            project = project or path_name(selected_path, "workspace")
            project_id_value = project_id(memory_space, project)
            self.runtime.register_project(memory_space, project, selected_path)
            self._project_paths[project_id_value] = selected_path
        if space == "chat":
            root_path = str(self.settings.active_directory_profile.root_path)
            project_path = self._project_paths.get(project_id_value)
            if project_path is None:
                project_path = self.runtime.project_path("non_productivity", project)
            if project_path is None and project == "general":
                project_path = root_path
            if project_path is None:
                raise ValueError(f"项目“{project}”没有有效的工作目录，请重新打开该目录。")
            if not Path(project_path).is_dir():
                raise ValueError(f"工作目录不存在或不是文件夹：{project_path}")
            selected_profile = profile_id or self._active_agent_profile_id()
            selected = self._agent_profile(selected_profile)
            thread_id = f"cleo_{secrets.token_hex(6)}"
            manifest = self.store.create_session(
                session_id=thread_id,
                space="non_productivity",
                project=project or "general",
                provider="cleo",
                owner_type="user",
                cwd=project_path,
            )
            from cleo.agents.profiles import profile_snapshot
            manifest = self.store.update_manifest(
                thread_id,
                runtime_options={
                    "agent_profile": selected_profile, "chat_profile": profile_snapshot(selected),
                },
            )
        else:
            adapter = self._adapter()
            provider_name = provider or self.settings.productivity.default_provider
            root_path = str(self.settings.active_directory_profile.root_path)
            root_name = path_name(root_path, "workspace")
            project_path = self._project_paths.get(project_id_value)
            if project_path is None:
                project_path = self.runtime.project_path("productivity", project)
            if project_path is None and project == root_name:
                project_path = root_path
            if project_path is None:
                raise ValueError(f"项目“{project}”没有有效的工作目录，请重新打开该目录。")
            if not Path(project_path).is_dir():
                raise ValueError(f"工作目录不存在或不是文件夹：{project_path}")
            selected_model = model or self.settings.productivity.provider(provider_name).model
            session = await adapter.create_session(
                provider_name,
                project_path=project_path,
                model=selected_model,
                project=project or path_name(project_path, "general"),
            )
            self._productivity_sessions[session.id] = session
            await self._enable_desktop_approvals(session.id, provider_name)
            if effort is not None:
                await adapter.update_session_options(session.id, effort=effort)
            manifest = self.store.load_manifest(session.id)
        self._activate(manifest)
        return await self._thread(manifest)

    async def stream_turn(
        self,
        *,
        thread_id: str,
        prompt: str,
        attachments: list[dict[str, Any]] | None,
        emit: Emit,
    ) -> None:
        prompt = str(prompt).strip()
        if not prompt:
            raise ValueError("prompt cannot be empty")
        manifest = self.store.load_manifest(thread_id)
        self._activate(manifest)
        if prompt.startswith("/"):
            await self._run_command(manifest, prompt, emit)
            return

        task = asyncio.current_task()
        if task is not None:
            self._run_tasks[thread_id] = task
        try:
            if manifest["space"] == "non_productivity":
                await self._stream_chat(manifest, prompt, attachments or [], emit)
            else:
                await self._stream_productivity(manifest, prompt, attachments or [], emit)
        except asyncio.CancelledError:
            status = "interrupted" if manifest["space"] == "non_productivity" else "cancelled"
            self.store.set_status(thread_id, status)
            await emit({"type": "error", "message": "当前运行已取消。"})
        finally:
            self._run_tasks.pop(thread_id, None)

    async def cancel_run(self, *, thread_id: str) -> dict[str, Any]:
        manifest = self.store.load_manifest(thread_id)
        if manifest["space"] == "productivity" and thread_id in self._productivity_sessions:
            try:
                await self._adapter().cancel(thread_id)
            except (KeyError, RuntimeError):
                pass
        task = self._run_tasks.get(thread_id)
        if task is not None:
            task.cancel()
        return {"cancelled": task is not None}

    async def resolve_approval(
        self,
        *,
        thread_id: str,
        approval_id: str,
        decision: str,
    ) -> dict[str, Any]:
        manifest = self.store.load_manifest(thread_id)
        if manifest["space"] != "productivity":
            raise ValueError("Only productivity tasks can request tool approval.")
        await self._ensure_productivity_session(manifest)
        return await self._adapter().resolve_approval(thread_id, approval_id, decision)

    async def update_runtime(
        self,
        *,
        thread_id: str,
        update: dict[str, Any],
    ) -> dict[str, Any]:
        manifest = self.store.load_manifest(thread_id)
        if manifest["space"] != "productivity":
            if "profileId" not in update:
                return self._runtime_profile(manifest)
            profile_id = str(update["profileId"])
            selected = self._agent_profile(profile_id)
            if thread_id in self._run_tasks:
                raise ValueError("请先停止当前运行。")
            previous = self._chat_profile(manifest)
            if (
                getattr(previous, "backend", "api") != getattr(selected, "backend", "api")
                and self._has_chat_history(self.store.read_events(thread_id))
            ):
                raise ValueError("切换连接类型需要新建对话，现有对话将保留原连接。")
            from cleo.agents.profiles import profile_snapshot
            current = (
                manifest.get("runtime_options")
                if isinstance(manifest.get("runtime_options"), dict)
                else {}
            )
            self.store.update_manifest(
                thread_id,
                runtime_options={
                    **current, "agent_profile": profile_id,
                    "chat_profile": profile_snapshot(selected), "chat_native_id": None,
                },
            )
            self._chat_agents.pop(thread_id, None)
            self._chat_agents_restored.discard(thread_id)
            return self._runtime_profile(self.store.load_manifest(thread_id))
        await self._ensure_productivity_session(manifest)
        options: dict[str, Any] = {}
        if "model" in update:
            options["model"] = str(update["model"])
        if "effort" in update:
            options["effort"] = str(update["effort"])
        if "access" in update:
            options["sandbox"] = str(update["access"])
        if "approval" in update:
            options["approval_mode"] = str(update["approval"])
        if options:
            await self._adapter().update_session_options(thread_id, **options)
        return self._runtime_profile(self.store.load_manifest(thread_id))

    async def get_config_templates(self) -> dict[str, str]:
        root = Path(__file__).resolve().parents[2]
        return {
            "cleo": (root / "cleo/config/templates/cleo.example.json").read_text(encoding="utf-8"),
            "harnesses": (root / "cleo/config/templates/harnesses.example.json").read_text(
                encoding="utf-8"
            ),
        }

    async def get_model_settings(self) -> dict[str, Any]:
        return read_model_settings(self.settings.PROFILE_DIR)

    async def get_agent_instructions(self) -> dict[str, Any]:
        path = Path(self.settings.active_directory_profile.root_path) / "AGENTS.md"
        return {
            "path": str(path),
            "content": path.read_text(encoding="utf-8-sig") if path.is_file() else "",
            "exists": path.is_file(),
        }

    async def get_runtime_catalog(self) -> dict[str, Any]:
        registered = set(self._adapter().providers)
        profiles = [
            {
                "id": name,
                "provider": profile.provider,
                "model": profile.model,
                "maxTokens": profile.max_tokens,
                "active": name == self._active_agent_profile_id(),
            }
            for name, profile in sorted(self._agent_profiles().items())
        ]
        providers = []
        for name, provider in self.settings.productivity.providers.items():
            if not provider.enabled or name not in registered:
                continue
            dynamic = provider.type in {"codex_sdk", "acp"}
            providers.append(
                {
                    "id": name,
                    "type": provider.type,
                    "defaultModel": provider.model,
                    "modelSource": "dynamic" if dynamic else "config",
                }
            )
        return {
            "nonProductivityProfiles": profiles,
            "productivityProviders": providers,
            "defaultNonProductivityProfile": self._active_agent_profile_id(),
            "defaultProductivityProvider": self.settings.productivity.default_provider,
        }

    async def get_productivity_models(
        self,
        *,
        provider: str,
        project_path: str | None = None,
    ) -> dict[str, Any]:
        provider_settings = self.settings.productivity.provider(provider)
        if not provider_settings.enabled or provider not in self._adapter().providers:
            raise ValueError(f"Productivity provider is not available: {provider}")

        dynamic = provider_settings.type in {"codex_sdk", "acp"}
        project_root = project_path or str(self.settings.active_directory_profile.root_path)
        if dynamic:
            if provider_settings.type == "acp":
                control = self._adapter().provider_control(provider)
                models = await control.list_models(project_root)
                source = "acp"
            else:
                models = await self._adapter().list_models(provider)
                source = "sdk"
            if provider_settings.type == "acp" and not models:
                identifiers = list(
                    dict.fromkeys(
                        [
                            *([provider_settings.model] if provider_settings.model else []),
                            *provider_settings.models,
                        ]
                    )
                )
                models = tuple(
                    self._configured_harness_model(identifier, provider_settings.model)
                    for identifier in identifiers
                )
                source = "config"
                if not models:
                    models = (
                        HarnessModel(
                            id="default",
                            display_name="Harness default",
                            description="Model selection is managed by the ACP harness",
                            is_default=True,
                            default_effort=None,
                            supported_efforts=(),
                        ),
                    )
        else:
            identifiers = list(
                dict.fromkeys(
                    [
                        *([provider_settings.model] if provider_settings.model else []),
                        *provider_settings.models,
                    ]
                )
            )
            models = tuple(
                self._configured_harness_model(
                    identifier,
                    provider_settings.model,
                    default_effort="high" if provider_settings.type == "claude_sdk" else None,
                    supported_efforts=(
                        CLAUDE_EFFORTS if provider_settings.type == "claude_sdk" else ()
                    ),
                )
                for identifier in identifiers
            )
            source = "config"
        if not models:
            raise ValueError(f"Provider {provider!r} did not expose any selectable models.")
        return {
            "provider": provider,
            "source": source,
            "models": [self._harness_model(model) for model in models],
        }

    async def save_model_profile(self, *, profile: dict[str, Any]) -> dict[str, Any]:
        if self._run_tasks:
            raise ValueError("请等待当前任务完成后再修改模型连接。")
        if profile.get("backend", "api") != "api":
            await self.check_subscription(profile=profile)
            if self._run_tasks:
                raise ValueError("请等待当前任务完成后再修改模型连接。")
        return save_model_profile(self.settings.PROFILE_DIR, profile)

    async def save_dream_settings(
        self, *, selection: str, model: str | None = None,
    ) -> dict[str, Any]:
        if self._run_tasks:
            raise ValueError("请等待当前任务完成后再修改 DreamAgent 设置。")
        return save_dream_settings(self.settings.PROFILE_DIR, selection, model)

    def _require_idle_configuration(self) -> None:
        if self._run_tasks:
            raise ValueError("请等待当前任务完成后再修改模型连接。")

    async def check_model_connection(self, *, connection: dict[str, Any]) -> dict[str, Any]:
        from cleo.config.settings import AgentProfile
        from cleo.integrations.model_catalog import list_api_models
        from cleo.integrations.subscriptions import inspect_connection

        if connection.get("profileId"):
            profile = self._agent_profile(str(connection["profileId"]))
        else:
            profile = AgentProfile(
                backend=connection.get("backend", "api"), provider=connection["provider"],
                model="default", api_key=connection.get("apiKey") or "",
                base_url=connection.get("baseUrl") or None,
                executable=connection.get("executable") or None,
            )
        try:
            async with asyncio.timeout(60):
                return await (
                    list_api_models(profile) if profile.backend == "api"
                    else inspect_connection(profile)
                )
        except TimeoutError as exc:
            raise ValueError("连接验证超时，请检查登录状态及网络。") from exc

    async def create_model_connection(self, *, connection: dict[str, Any]) -> dict[str, Any]:
        self._require_idle_configuration()
        if connection.get("backend", "api") != "api":
            await self.check_model_connection(connection=connection)
            self._require_idle_configuration()
        return create_model_connection(self.settings.PROFILE_DIR, connection)

    async def select_chat_model(self, *, profile_id: str, model: str) -> dict[str, Any]:
        self._require_idle_configuration()
        return select_chat_model(self.settings.PROFILE_DIR, profile_id, model)

    async def rename_model_connection(self, *, profile_id: str, label: str) -> dict[str, Any]:
        self._require_idle_configuration()
        return rename_model_connection(self.settings.PROFILE_DIR, profile_id, label)

    async def remove_model_connection(self, *, profile_id: str) -> dict[str, Any]:
        self._require_idle_configuration()
        if self.runtime.current_thread_id:
            try:
                manifest = self.store.load_manifest(self.runtime.current_thread_id)
            except FileNotFoundError:
                manifest = {}
            if manifest.get("space") == "non_productivity" and (
                manifest.get("runtime_options") or {}
            ).get("agent_profile") == profile_id:
                raise ValueError("当前对话正在使用这个连接。切换所用模型后，才可移除。")
        return remove_model_connection(self.settings.PROFILE_DIR, profile_id)

    async def get_subscription_catalog(self) -> list[dict[str, Any]]:
        from cleo.integrations.subscriptions import RUNTIMES

        return [{"backend": key, **value} for key, value in RUNTIMES.items()]

    async def start_subscription_login(self, *, profile: dict[str, Any]) -> dict[str, Any]:
        from cleo.config.settings import AgentProfile
        from cleo.integrations.subscriptions import RUNTIMES

        if profile.get("backend") not in RUNTIMES:
            raise ValueError("Unsupported subscription runtime")
        candidate = AgentProfile(
            backend=profile["backend"], provider=profile["backend"], model="default",
            executable=profile.get("executable") or None,
        )
        return self._subscription_logins.start(
            candidate, self.settings.active_directory_profile.root_path,
        )

    async def read_subscription_login(self, *, login_id: str) -> dict[str, Any]:
        return self._subscription_logins.read(login_id)

    async def cancel_subscription_login(self, *, login_id: str) -> dict[str, Any]:
        return await self._subscription_logins.cancel(login_id)

    async def check_subscription(self, *, profile: dict[str, Any]) -> dict[str, Any]:
        from cleo.config.settings import AgentProfile
        from cleo.integrations.subscriptions import inspect_connection

        candidate = AgentProfile(
            backend=profile["backend"], provider=profile["backend"],
            model=profile.get("model") or "default", executable=profile.get("executable") or None,
        )
        try:
            async with asyncio.timeout(60):
                return await inspect_connection(candidate)
        except TimeoutError as exc:
            raise ValueError("连接验证超时，请检查官方 CLI 的登录状态及网络连接。") from exc

    async def save_agent_instructions(self, *, content: str) -> dict[str, Any]:
        if not isinstance(content, str):
            raise TypeError("Agent instructions must be text.")
        path = Path(self.settings.active_directory_profile.root_path) / "AGENTS.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = path.with_name(f".{path.name}.tmp")
        temporary_path.write_text(content, encoding="utf-8", newline="")
        temporary_path.replace(path)
        self._chat_agents.clear()
        self._chat_agents_restored.clear()
        return {
            "path": str(path),
            "content": content,
            "exists": True,
        }

    async def reset_workspace(self) -> dict[str, Any]:
        from cleo.integrations.workspace import reset_workspace_to_main

        await asyncio.to_thread(
            reset_workspace_to_main, self.settings.active_directory_profile.root_path
        )
        return {"reset": True}

    async def undo_changes(self, *, thread_id: str) -> dict[str, Any]:
        """Undo only the changes made by the latest productivity turn."""
        manifest = self.store.load_manifest(thread_id)
        if manifest["space"] != "productivity":
            raise ValueError("只有开发任务可以回退 Git 改动。")
        if thread_id in self._run_tasks:
            raise ValueError("任务正在运行，请先停止后再回退。")
        cwd = manifest.get("cwd")
        if not cwd:
            raise ValueError("当前任务没有工作目录，无法回退。")
        if inspect_git_status(cwd) is None:
            raise ValueError("当前工作目录不是 Git 仓库，无法回退。")
        checkpoint = manifest.get("undo_checkpoint")
        if not isinstance(checkpoint, dict):
            raise ValueError("最近一次回答没有可回退的 Git 改动记录。")

        result = await asyncio.to_thread(undo_git_checkpoint, checkpoint)
        self.store.update_manifest(thread_id, undo_checkpoint=None)
        return {
            "restoredFiles": result.restored_count,
            "workspace": await self.load_workspace(),
        }

    async def shutdown(self) -> None:
        await self._subscription_logins.close()
        jobs = []
        for thread_id, agent in self._chat_agents.items():
            try:
                manifest = self.store.load_manifest(thread_id)
                await self._sync_chat(agent, manifest, "completed")
            except (FileNotFoundError, OSError, ValueError):
                continue
            jobs.append((thread_id, manifest["project"], manifest["space"]))
        if jobs:
            launch_dream_agent_worker(jobs, store=self.store)
        if self._adapter_instance is not None:
            try:
                await self._adapter_instance.aclose()
            except Exception:
                pass

    async def _stream_chat(
        self,
        manifest: dict[str, Any],
        prompt: str,
        attachments: list[dict[str, Any]],
        emit: Emit,
    ) -> None:
        agent = self._chat_agents.get(manifest["id"])
        if agent is None:
            agent = self._new_agent(
                project=manifest["project"],
                space=manifest["space"],
                profile=self._chat_profile(manifest),
                project_path=self._manifest_project_path(manifest),
            )
            self._chat_agents[manifest["id"]] = agent
        loaded = None
        if manifest["id"] not in self._chat_agents_restored:
            loaded = self.store.load_langchain_messages(manifest["id"])
            self._chat_agents_restored.add(manifest["id"])
        if len(attachments) > MAX_CHAT_ATTACHMENT_COUNT:
            raise ValueError(f"A message can include at most {MAX_CHAT_ATTACHMENT_COUNT} files.")
        chat_attachments = await asyncio.gather(
            *(self._chat_attachment(item) for item in attachments)
        )
        text = ""
        try:
            async for chunk in agent.stream_text(
                prompt,
                manifest["id"],
                loaded_info=loaded or None,
                images=chat_attachments,
            ):
                text += chunk
                await emit(
                    {
                        "type": "upsert-item",
                        "item": {
                            "id": "live-assistant",
                            "type": "message",
                            "role": "assistant",
                            "content": text,
                            "time": "",
                        },
                    }
                )
        except BaseException:
            await self._sync_chat(agent, manifest, "interrupted")
            raise
        else:
            await self._sync_chat(agent, manifest, "completed")
        usage = agent.context_usage
        await emit({"type": "usage", "usage": self._usage_dict(usage)})
        await emit({"type": "done", "summary": (text or prompt)[:80]})

    async def _stream_productivity(
        self,
        manifest: dict[str, Any],
        prompt: str,
        attachments: list[dict[str, Any]],
        emit: Emit,
    ) -> None:
        await self._ensure_productivity_session(manifest)
        turn_title = " ".join(prompt.split())[:80]
        checkpoint = None
        previous_checkpoint = manifest.get("undo_checkpoint")
        if isinstance(previous_checkpoint, dict):
            try:
                await asyncio.to_thread(discard_git_checkpoint, previous_checkpoint)
            except (OSError, RuntimeError, ValueError):
                # A stale private ref does not affect the working tree or the new turn.
                pass
        self.store.update_manifest(manifest["id"], undo_checkpoint=None)
        try:
            checkpoint = await asyncio.to_thread(
                create_git_checkpoint,
                manifest.get("cwd") or ".",
                manifest["id"],
            )
        except (OSError, RuntimeError, ValueError) as exc:
            self._debug(f"Git checkpoint unavailable for {manifest['id']}: {exc}")
        if attachments:
            paths = [str(item.get("path") or "") for item in attachments if item.get("path")]
            if paths:
                prompt = f"{prompt}\n\nAttached local files:\n" + "\n".join(
                    f"- {path}" for path in paths
                )
        state: dict[str, Any] = {"run_id": secrets.token_hex(6)}
        usage = ContextWindowUsage(
            window_tokens=self._runtime_profile(manifest)["contextWindow"],
        )
        provider_settings = self.settings.productivity.provider(str(manifest["provider"]))

        async def refresh_changes(*, force: bool = False) -> None:
            diff = await asyncio.to_thread(read_git_diff, manifest.get("cwd") or ".")
            changes = final_changes_from_diff(diff, state)
            if not force and changes == state.get("changes:emitted"):
                return
            state["changes:emitted"] = changes
            await emit({"type": "changes", "changes": changes})

        async def on_event(event: Any) -> None:
            from cleo.harnesses.events import capture_context_usage

            capture_context_usage(event, usage)
            for projected in stream_event_item(event, state):
                if projected.get("type") == "changes":
                    state["changes:emitted"] = projected.get("changes")
                await emit(projected)
            if provider_settings.type == "acp" and event.type == "tool_result":
                payload = event.data.get("payload")
                status = payload.get("status") if isinstance(payload, dict) else None
                if status in {"completed", "failed"}:
                    await refresh_changes()
            if usage.used_tokens is not None:
                await emit({"type": "usage", "usage": self._usage_dict(usage)})

        try:
            result = await self._adapter().prompt(manifest["id"], prompt, on_event=on_event)
        finally:
            for projected in finalize_stream_tools(state):
                await emit(projected)
            change_set = None
            exact_history_available = False
            if checkpoint is not None:
                try:
                    completed_checkpoint = await asyncio.to_thread(
                        finalize_git_checkpoint,
                        checkpoint,
                    )
                    self.store.update_manifest(
                        manifest["id"],
                        undo_checkpoint=completed_checkpoint.to_dict(),
                    )
                except (OSError, RuntimeError, ValueError) as exc:
                    await asyncio.to_thread(discard_git_checkpoint, checkpoint)
                    self.store.update_manifest(manifest["id"], undo_checkpoint=None)
                    self._debug(f"Git checkpoint finalization failed for {manifest['id']}: {exc}")
                else:
                    try:
                        turn_diff = await asyncio.to_thread(
                            read_git_checkpoint_diff,
                            completed_checkpoint,
                        )
                        if turn_diff:
                            persisted = self.store.append_event(
                                space=str(manifest["space"]),
                                project=str(manifest["project"]),
                                session_id=str(manifest["id"]),
                                event_type="turn_diff",
                                actor=str(manifest["provider"]),
                                content=turn_diff,
                                data={"title": turn_title},
                            )
                            history = change_history_from_events([persisted])
                            change_set = history[0] if history else None
                        exact_history_available = True
                    except (OSError, RuntimeError, ValueError) as exc:
                        self._debug(f"Git change history unavailable for {manifest['id']}: {exc}")
            if not exact_history_available:
                streamed_changes = state.get("changes:latest")
                if isinstance(streamed_changes, list) and streamed_changes:
                    change_set = {
                        "id": f"live-turn-{state['run_id']}",
                        "title": turn_title or "Agent 修改",
                        "createdAt": "刚刚",
                        "changes": [
                            dict(change) for change in streamed_changes if isinstance(change, dict)
                        ],
                    }
            if change_set is not None:
                await emit({"type": "change-history", "changeSet": change_set})
        if result.response and not state.get("assistant"):
            await emit(
                {
                    "type": "upsert-item",
                    "item": {
                        "id": "live-assistant",
                        "type": "message",
                        "role": "assistant",
                        "content": result.response,
                        "time": "",
                    },
                }
            )
        await refresh_changes(force=True)
        if result.status == "completed":
            await emit({"type": "done", "summary": (result.response or prompt)[:80]})
        else:
            await emit({"type": "error", "message": result.error or f"运行状态：{result.status}"})

    async def _sync_chat(self, agent: Any, manifest: dict[str, Any], status: str) -> None:
        state = await agent.deepagent.aget_state({"configurable": {"thread_id": manifest["id"]}})
        self.store.sync_langchain_messages(
            session_id=manifest["id"],
            space=manifest["space"],
            project=manifest["project"],
            messages=state.values.get("messages", []),
            provider="cleo",
            owner_type="user",
            cwd=manifest.get("cwd"),
            status=status,
        )
        self.runtime.append_recent_threads(manifest["id"], manifest["space"])

    async def _run_command(self, manifest: dict[str, Any], prompt: str, emit: Emit) -> None:
        command, _, argument = prompt.partition(" ")
        argument = argument.strip().strip("\"'")
        if manifest["space"] == "non_productivity":
            await self._run_chat_command(manifest, command, argument, emit)
        else:
            await self._run_productivity_command(manifest, command, argument, emit)

    async def _run_chat_command(
        self,
        manifest: dict[str, Any],
        command: str,
        argument: str,
        emit: Emit,
    ) -> None:
        if command == "/help":
            await self._notice(
                emit,
                "Cleo 对话命令",
                "/new · /project [name] · /project move <name> · /sessions · "
                "/resume <id> · /rename <title> · /attach · /productivity · /quit",
            )
        elif command == "/new":
            thread = await self.create_thread(
                space="chat", project_id_value=project_id("non_productivity", manifest["project"])
            )
            await emit({"type": "refresh", "activeThreadId": thread["id"], "space": "chat"})
        elif command == "/project":
            if argument.startswith("move "):
                target = argument.removeprefix("move ").strip()
                moved = self.store.move_session(manifest["id"], target)
                await self._notice(
                    emit, "项目已迁移", f"当前对话已移动到 {moved['project']}。", "success"
                )
                await emit({"type": "refresh", "activeThreadId": manifest["id"], "space": "chat"})
            elif argument:
                thread = await self.create_thread(
                    space="chat", project_id_value=project_id("non_productivity", argument)
                )
                await emit({"type": "refresh", "activeThreadId": thread["id"], "space": "chat"})
            else:
                await self._notice(
                    emit, "记忆项目", " · ".join(self.runtime.projects_for("non_productivity"))
                )
        elif command == "/sessions":
            await self._session_list("non_productivity", emit)
        elif command == "/resume" and argument:
            target = self.store.load_manifest(argument)
            if target["space"] != "non_productivity":
                raise ValueError("目标不是 Cleo 对话 session。")
            await emit({"type": "refresh", "activeThreadId": argument, "space": "chat"})
        elif command == "/rename" and argument:
            self.store.rename_session(manifest["id"], argument)
            await self._notice(emit, "已重命名", argument, "success")
            await emit({"type": "refresh", "activeThreadId": manifest["id"], "space": "chat"})
        elif command == "/attach":
            await emit({"type": "request-attachment"})
        elif command == "/productivity":
            await emit({"type": "navigate-space", "space": "productivity"})
        elif command in {"/quit", "/exit"}:
            await self._notice(
                emit, "桌面应用保持运行", "可以直接关闭窗口，Cleo 会在退出时整理记忆。"
            )
        else:
            raise ValueError(f"未知对话命令：{command}。输入 /help 查看命令。")

    async def _run_productivity_command(
        self,
        manifest: dict[str, Any],
        command: str,
        argument: str,
        emit: Emit,
    ) -> None:
        session = await self._ensure_productivity_session(manifest)
        adapter = self._adapter()
        if command == "/help":
            await self._notice(
                emit,
                "开发任务命令",
                "/new · /cwd · /project · /git · /diff · /model · /effort · "
                "/access · /approval · /cd · /resume · /resume-native · /native · "
                "/sessions · /account · /fork · /rename · /compact · /archive · /back · /quit",
            )
        elif command == "/new":
            thread = await self.create_thread(
                space="productivity",
                project_id_value=project_id("productivity", manifest["project"]),
                provider=manifest["provider"],
            )
            await emit({"type": "refresh", "activeThreadId": thread["id"], "space": "productivity"})
        elif command == "/cwd":
            await self._notice(emit, "工作目录", str(manifest.get("cwd") or session.project_path))
        elif command == "/project":
            await self._notice(emit, "项目", str(manifest["project"]))
        elif command == "/git":
            status = await asyncio.to_thread(inspect_git_status, session.project_path)
            detail = (
                "当前目录不是 Git 仓库。"
                if status is None
                else f"{status.branch} · {status.dirty_count} 个变更\n" + "\n".join(status.changes)
            )
            await self._notice(emit, "Git 状态", detail)
        elif command == "/diff":
            diff = await asyncio.to_thread(read_git_diff, session.project_path)
            await emit({"type": "changes", "changes": changes_from_diff(diff)})
            await self._notice(emit, "工作区差异", "已刷新右侧变更面板。", "success")
        elif command == "/model":
            if argument:
                await adapter.update_session_options(manifest["id"], model=argument)
                await self._notice(emit, "模型已更新", argument, "success")
            else:
                models = await adapter.list_models(manifest["provider"])
                await self._notice(
                    emit,
                    "可用模型",
                    "\n".join(f"{model.id} — {model.display_name}" for model in models),
                )
        elif command in {"/effort", "/access", "/approval"}:
            field = {"/effort": "effort", "/access": "sandbox", "/approval": "approval_mode"}[
                command
            ]
            if not argument:
                options = adapter.session_options(manifest["id"])
                await self._notice(
                    emit,
                    command.removeprefix("/").title(),
                    str(getattr(options, field) or "default"),
                )
            else:
                update = {field: argument}
                await adapter.update_session_options(manifest["id"], **update)
                await self._notice(emit, "运行参数已更新", f"{field} = {argument}", "success")
        elif command == "/cd":
            target = resolve_productivity_cwd(argument, session.project_path)
            next_session = await adapter.create_session(
                manifest["provider"],
                project_path=target,
                project=path_name(target, manifest["project"]),
            )
            self._productivity_sessions[next_session.id] = next_session
            await emit(
                {"type": "refresh", "activeThreadId": next_session.id, "space": "productivity"}
            )
        elif command == "/resume" and argument:
            target = self.store.load_manifest(argument)
            await self._ensure_productivity_session(target)
            await emit({"type": "refresh", "activeThreadId": argument, "space": "productivity"})
        elif command == "/resume-native" and argument:
            resumed = await adapter.resume_session(
                manifest["provider"],
                argument,
                project_path=session.project_path,
                project=manifest["project"],
            )
            self._productivity_sessions[resumed.id] = resumed
            await emit({"type": "refresh", "activeThreadId": resumed.id, "space": "productivity"})
        elif command == "/native" and argument:
            detail = await adapter.read_native_session(manifest["provider"], argument)
            await self._notice(
                emit,
                detail.session.name or detail.session.id,
                json.dumps(list(detail.turns), ensure_ascii=False, indent=2)[:12_000],
            )
        elif command == "/sessions":
            await self._session_list("productivity", emit)
        elif command == "/account":
            account = await adapter.account_status(manifest["provider"])
            await self._notice(
                emit,
                f"{manifest['provider']} 账号",
                f"authenticated: {account.authenticated}\n"
                f"type: {account.account_type or '—'}\n"
                f"email: {account.email or '—'}\n"
                f"plan: {account.plan or '—'}",
            )
        elif command == "/fork":
            forked = await adapter.fork_session(manifest["id"])
            self._productivity_sessions[forked.id] = forked
            await emit({"type": "refresh", "activeThreadId": forked.id, "space": "productivity"})
        elif command == "/rename" and argument:
            await adapter.rename_session(manifest["id"], argument)
            await self._notice(emit, "已重命名", argument, "success")
            await emit(
                {"type": "refresh", "activeThreadId": manifest["id"], "space": "productivity"}
            )
        elif command == "/compact":
            await adapter.compact_session(manifest["id"])
            await self._notice(emit, "上下文整理已启动", "Provider 原生上下文正在压缩。", "success")
        elif command == "/archive":
            await adapter.archive_session(manifest["id"])
            thread = await self.create_thread(
                space="productivity",
                project_id_value=project_id("productivity", manifest["project"]),
                provider=manifest["provider"],
            )
            await emit({"type": "refresh", "activeThreadId": thread["id"], "space": "productivity"})
        elif command == "/back":
            await emit({"type": "navigate-space", "space": "chat"})
        elif command in {"/quit", "/exit"}:
            await self._notice(emit, "桌面应用保持运行", "可以切换空间或直接关闭窗口。")
        else:
            raise ValueError(f"未知开发命令：{command}。输入 /help 查看命令。")

    async def _projects(self, manifests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        candidates: dict[str, tuple[str, str, str]] = {}
        root_path = str(self.settings.active_directory_profile.root_path)
        root_name = path_name(root_path, "workspace")
        for manifest in manifests:
            if self._is_removed_project(manifest):
                continue
            space = self._ui_space(manifest["space"])
            name = str(manifest["project"])
            raw_path = manifest.get("cwd")
            if not raw_path:
                continue
            path = str(raw_path)
            candidates[project_id(manifest["space"], name)] = (space, name, path)

        if not self.runtime.is_project_removed("non_productivity", "general"):
            candidates[project_id("non_productivity", "general")] = (
                "chat",
                "general",
                root_path,
            )
        if not self.runtime.is_project_removed("productivity", root_name):
            candidates[project_id("productivity", root_name)] = (
                "productivity",
                root_name,
                root_path,
            )
        for memory_space in ("non_productivity", "productivity"):
            for name in self.runtime.projects_for(memory_space):
                if self.runtime.is_project_removed(memory_space, name):
                    continue
                path = self.runtime.project_path(memory_space, name)
                if path is not None:
                    candidates[project_id(memory_space, name)] = (
                        self._ui_space(memory_space),
                        name,
                        path,
                    )

        projects = []
        project_counts = {
            space: sum(
                1
                for candidate_space, _name, _path in candidates.values()
                if candidate_space == space
            )
            for space in ("chat", "productivity")
        }
        self._project_paths = {}
        for identifier, (space, name, path) in candidates.items():
            git = inspect_git_status(path) if space == "productivity" else None
            self._project_paths[identifier] = path
            projects.append(
                {
                    "id": identifier,
                    "space": space,
                    "name": name,
                    "path": path,
                    "branch": git.branch if git else None,
                    "dirtyFiles": git.dirty_count if git else 0,
                    "accent": self._accent(identifier),
                    "removable": project_counts[space] > 1
                    and not (space == "chat" and name == "general"),
                }
            )
        return sorted(projects, key=lambda item: (item["space"], item["name"].casefold()))

    @staticmethod
    def _has_chat_history(events: list[dict[str, Any]]) -> bool:
        return any(item.get("type") == "message" for item in timeline_from_events(events))

    def _chat_backup_candidates(self) -> list[dict[str, Any]]:
        backup_root = self.settings.MEMORY_DIR.parent / "backups"
        if not backup_root.is_dir():
            return []

        current_history_ids: set[str] = set()
        restored_source_ids: set[str] = set()
        for row in self.store.list_sessions(space="non_productivity"):
            session_id = str(row["id"])
            try:
                manifest = self.store.load_manifest(session_id)
                events = self.store.read_events(session_id)
            except (FileNotFoundError, OSError, ValueError):
                continue
            if self._has_chat_history(events):
                current_history_ids.add(session_id)
            for tag in manifest.get("tags") or []:
                if isinstance(tag, str) and tag.startswith("restored-backup:"):
                    restored_source_ids.add(tag.removeprefix("restored-backup:"))

        pattern = (
            "memory-reset-*/memory/non_productivity/projects/"
            "*/sessions/*/events.jsonl"
        )
        paths = list(backup_root.glob(pattern))
        paths.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
        candidates: list[dict[str, Any]] = []
        seen_source_ids: set[str] = set()
        for path in paths:
            source_id = path.parent.name
            if (
                source_id in seen_source_ids
                or source_id in current_history_ids
                or source_id in restored_source_ids
            ):
                continue
            try:
                events = load_events(path)
            except (OSError, ValueError):
                continue
            if not self._has_chat_history(events):
                continue
            seen_source_ids.add(source_id)
            candidates.append(
                {
                    "source_id": source_id,
                    "project": path.parent.parent.parent.name,
                    "events": events,
                }
            )
        return candidates

    async def _thread(
        self,
        manifest: dict[str, Any],
        *,
        events: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if events is None:
            events = self.store.read_events(manifest["id"])
        items = timeline_from_events(events)
        summary = next(
            (
                item["content"][:100]
                for item in reversed(items)
                if item["type"] == "message" and item["content"]
            ),
            "等待第一条消息",
        )
        changes = []
        if manifest["space"] == "productivity" and manifest.get("cwd"):
            diff = read_git_diff(manifest["cwd"])
            changes = (
                latest_turn_changes(events)
                if diff is None
                else changes_from_diff(diff)
            )
        usage = self._usage_from_events(events, self._runtime_profile(manifest)["contextWindow"])
        return {
            "id": manifest["id"],
            "space": self._ui_space(manifest["space"]),
            "projectId": project_id(manifest["space"], manifest["project"]),
            "title": manifest.get("title") or "新对话"
            if manifest["space"] == "non_productivity"
            else manifest.get("title") or "新任务",
            "summary": summary,
            "updatedAt": relative_time(manifest.get("updated_at")),
            "status": self._thread_status(manifest.get("status")),
            "items": items,
            "changes": changes,
            "changeHistory": change_history_from_events(events),
            "usage": usage,
            "runtime": self._runtime_profile(manifest),
            "terminal": self._terminal_from_events(events),
        }

    def _runtime_profile(self, manifest: dict[str, Any] | None) -> dict[str, Any]:
        if manifest is None or manifest.get("space") == "non_productivity":
            options = (
                manifest.get("runtime_options")
                if manifest is not None and isinstance(manifest.get("runtime_options"), dict)
                else {}
            )
            profile_id = str(options.get("agent_profile") or self._active_agent_profile_id())
            profile = self._agent_profiles().get(profile_id)
            snapshot = options.get("chat_profile") or {
                "provider": getattr(profile, "provider", "cleo"),
                "model": getattr(profile, "model", "连接已移除"),
                "backend": getattr(profile, "backend", "api"),
                "max_tokens": getattr(profile, "max_tokens", 0),
            }
            return {
                "profileId": profile_id,
                "provider": snapshot["provider"],
                "model": snapshot["model"],
                "models": [item.model for item in self._agent_profiles().values()],
                "effort": "high",
                "access": str(self.settings.active_shell_profile.sandbox_root),
                "approval": (
                    "官方运行时及 Cleo 工具策略"
                    if snapshot.get("backend", "api") != "api" else "Cleo 工具策略"
                ),
                "contextWindow": snapshot["max_tokens"],
                "editable": False,
            }
        provider = str(manifest.get("provider") or self.settings.productivity.default_provider)
        provider_settings = self.settings.productivity.provider(provider)
        options = (
            manifest.get("runtime_options")
            if isinstance(manifest.get("runtime_options"), dict)
            else {}
        )
        model = str(options.get("model") or provider_settings.model or "default")
        return {
            "provider": provider,
            "model": model,
            "models": list(
                dict.fromkeys(
                    [model, provider_settings.model] if provider_settings.model else [model]
                )
            ),
            "effort": str(options["effort"]) if options.get("effort") else None,
            "access": str(
                options.get("sandbox") or getattr(provider_settings.options, "sandbox", "default")
            ),
            "approval": str(
                options.get("approval_mode")
                or getattr(provider_settings.options, "approval_mode", "default")
            ),
            "contextWindow": 128_000,
            "editable": True,
        }

    def _agent_profiles(self) -> dict[str, Any]:
        registry = getattr(getattr(self.settings, "profiles", None), "agents", None)
        if isinstance(registry, dict) and registry:
            return registry
        return {self._active_agent_profile_id(): self.settings.active_agent_profile}

    def _active_agent_profile_id(self) -> str:
        active = getattr(getattr(self.settings, "active_profiles", None), "agent", None)
        return str(active or "active")

    def _agent_profile(self, profile_id: str) -> Any:
        profile = self._agent_profiles().get(profile_id)
        if profile is None:
            raise ValueError(f"Unknown non-productivity model profile: {profile_id}")
        return profile

    def _chat_profile(self, manifest: dict[str, Any]) -> Any:
        if (manifest.get("runtime_options") or {}).get("chat_profile"):
            from cleo.agents.profiles import session_profile

            return session_profile(self.settings, manifest)
        options = (
            manifest.get("runtime_options")
            if isinstance(manifest.get("runtime_options"), dict)
            else {}
        )
        return self._agent_profile(
            str(options.get("agent_profile") or self._active_agent_profile_id())
        )

    @staticmethod
    def _configured_harness_model(
        identifier: str,
        default_model: str | None,
        *,
        default_effort: str | None = None,
        supported_efforts: tuple[str, ...] = (),
    ) -> HarnessModel:
        return HarnessModel(
            id=identifier,
            display_name=identifier,
            description="Configured in harnesses.json",
            is_default=identifier == default_model,
            default_effort=default_effort,
            supported_efforts=supported_efforts,
        )

    @staticmethod
    def _harness_model(model: HarnessModel) -> dict[str, Any]:
        return {
            "id": model.id,
            "label": model.display_name,
            "description": model.description,
            "isDefault": model.is_default,
            "defaultEffort": model.default_effort,
            "supportedEfforts": list(model.supported_efforts),
        }

    async def _ensure_productivity_session(self, manifest: dict[str, Any]) -> Any:
        existing = self._productivity_sessions.get(manifest["id"])
        if existing is not None:
            return existing
        native_id = manifest.get("native_session_id")
        if not native_id:
            raise ValueError(f"Session {manifest['id']} 没有 provider 原生 session id。")
        session = await self._adapter().resume_session(
            str(manifest["provider"]),
            str(native_id),
            project_path=str(manifest.get("cwd") or "."),
            model=self._runtime_profile(manifest)["model"],
            project=str(manifest["project"]),
        )
        self._productivity_sessions[manifest["id"]] = session
        await self._enable_desktop_approvals(manifest["id"], str(manifest["provider"]))
        return session

    async def _enable_desktop_approvals(self, session_id: str, provider: str) -> None:
        settings = self.settings.productivity.provider(provider)
        options = self._adapter().session_options(session_id)
        if settings.type != "codex_sdk" or options.approval_mode == "deny_all":
            return
        if options.approval_mode == "auto_review":
            await self._adapter().update_session_options(
                session_id,
                approval_mode="user",
            )
        await self._adapter().enable_user_approvals(session_id)

    def _adapter(self) -> Any:
        if self._adapter_instance is None:
            from cleo.integrations.harnesses.factory import build_agent_adapter

            self._adapter_instance = build_agent_adapter(
                self.settings.active_directory_profile.root_path,
                self.settings.productivity,
                session_store=self.store,
            )
        return self._adapter_instance

    def _new_agent(self, **kwargs: Any) -> Any:
        if self._agent_factory is None:
            from cleo.agents import Agent

            self._agent_factory = Agent
        return self._agent_factory(**kwargs)

    def _activate(self, manifest: dict[str, Any]) -> None:
        self.runtime.update_current_space(str(manifest["space"]))
        if manifest.get("cwd"):
            self.runtime.register_project(
                str(manifest["space"]), str(manifest["project"]), str(manifest["cwd"])
            )
        else:
            self.runtime.update_current_project(str(manifest["project"]))
        self.runtime.update_current_thread_id(str(manifest["id"]))
        self.runtime.append_recent_threads(str(manifest["id"]), str(manifest["space"]))

    def _is_removed_project(self, manifest: dict[str, Any]) -> bool:
        space = str(manifest.get("space") or "")
        return space in {"non_productivity", "productivity"} and self.runtime.is_project_removed(
            space, str(manifest.get("project") or "")
        )

    def _manifest_project_path(self, manifest: dict[str, Any]) -> str:
        path = manifest.get("cwd") or self.runtime.project_path(
            str(manifest["space"]), str(manifest["project"])
        )
        if (
            path is None
            and manifest["space"] == "non_productivity"
            and manifest["project"] == "general"
        ):
            path = str(self.settings.active_directory_profile.root_path)
        if path is None or not Path(path).is_dir():
            raise ValueError(
                f"项目“{manifest['project']}”没有有效的工作目录，请重新打开该目录。"
            )
        return str(Path(path).resolve())

    async def _session_list(self, space: str, emit: Emit) -> None:
        rows = self.store.list_sessions(space=space)
        detail = (
            "\n".join(
                f"{row['id']} · {row.get('title') or 'untitled'} · {row['project']}"
                for row in rows[:50]
            )
            or "暂无 session。"
        )
        await self._notice(emit, "Sessions", detail)

    @staticmethod
    async def _notice(
        emit: Emit,
        title: str,
        detail: str,
        tone: str = "info",
    ) -> None:
        await emit(
            {
                "type": "upsert-item",
                "item": {
                    "id": f"notice-{secrets.token_hex(4)}",
                    "type": "notice",
                    "tone": tone,
                    "title": title,
                    "detail": detail,
                },
            }
        )
        await emit({"type": "done", "summary": title})

    @staticmethod
    def _memory_entry(entry: dict[str, Any]) -> dict[str, Any]:
        scope = (
            "persona"
            if entry["scope"] == "persona"
            else "preference"
            if entry["category"] == "preference"
            else "project"
        )
        source = (
            "PERSONA.md" if entry["scope"] == "persona" else f"{entry['space']}/{entry['project']}"
        )
        return {
            "id": entry["id"],
            "scope": scope,
            "title": entry["title"],
            "content": entry["content"],
            "source": source,
            "updatedAt": relative_time(entry["updated_at"]),
        }

    @staticmethod
    def _usage_from_events(events: list[dict[str, Any]], limit: int) -> dict[str, int]:
        usage = {"used": 0, "limit": limit, "input": 0, "output": 0}
        for event in events:
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
            token_usage = payload.get("tokenUsage") if isinstance(payload, dict) else None
            if not isinstance(token_usage, dict):
                continue
            total = token_usage.get("total") if isinstance(token_usage.get("total"), dict) else {}
            last = token_usage.get("last") if isinstance(token_usage.get("last"), dict) else {}
            usage["used"] = int(total.get("totalTokens") or usage["used"])
            usage["limit"] = int(token_usage.get("modelContextWindow") or usage["limit"])
            usage["input"] = int(last.get("inputTokens") or usage["input"])
            usage["output"] = int(last.get("outputTokens") or usage["output"])
        return usage

    @staticmethod
    def _usage_dict(usage: ContextWindowUsage) -> dict[str, int]:
        return {
            "used": usage.used_tokens or 0,
            "limit": usage.window_tokens or 128_000,
            "input": usage.input_tokens or 0,
            "output": usage.output_tokens or 0,
        }

    @staticmethod
    def _terminal_from_events(events: list[dict[str, Any]]) -> list[str]:
        output = []
        for event in events[-100:]:
            if event.get("type") != "terminal_output":
                continue
            content = event.get("content")
            if isinstance(content, str) and content:
                output.append(content)
        return output

    @staticmethod
    async def _chat_attachment(item: dict[str, Any]) -> dict[str, str]:
        path = Path(str(item.get("path") or "")).expanduser()
        if not path.is_absolute():
            raise ValueError("Desktop attachments require an absolute local file path.")

        def read_attachment() -> tuple[Path, bytes]:
            resolved = path.resolve(strict=True)
            if not resolved.is_file():
                raise ValueError(f"Attachment is not a file: {resolved.name}")
            size = resolved.stat().st_size
            if size > MAX_CHAT_ATTACHMENT_BYTES:
                raise ValueError(f"Attachment exceeds 50 MB: {resolved.name}")
            return resolved, resolved.read_bytes()

        resolved, data = await asyncio.to_thread(read_attachment)
        mime_type = str(
            item.get("mimeType")
            or mimetypes.guess_type(resolved.name)[0]
            or "application/octet-stream"
        )
        return {
            "name": str(item.get("name") or resolved.name),
            "base64": base64.b64encode(data).decode("ascii"),
            "mime_type": mime_type,
        }

    @staticmethod
    def _ui_space(space: str) -> str:
        return "chat" if space == "non_productivity" else "productivity"

    @staticmethod
    def _thread_status(status: Any) -> str:
        value = str(status or "idle")
        if value == "running":
            return "running"
        if value in {"failed", "cancelled", "interrupted"}:
            return "attention"
        if value in {"completed", "closed", "archived"}:
            return "completed"
        return "idle"

    @staticmethod
    def _accent(value: str) -> str:
        palette = ("#6be4ed", "#a78bfa", "#f2b36c", "#72d69c", "#ef7ea8")
        return palette[sum(value.encode("utf-8")) % len(palette)]

    @staticmethod
    def _debug(message: str) -> None:
        if os.environ.get("CLEO_DESKTOP_DEBUG") == "1":
            sys.stderr.write(f"[cleo-service] {message}\n")
            sys.stderr.flush()
