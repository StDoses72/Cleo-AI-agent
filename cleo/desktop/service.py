"""Thin desktop service reusing Cleo's existing runtime and persistence layers."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from cleo.cli.lifecycle import _launch_dream_agent_worker
from cleo.cli.productivity import _resolve_productivity_cwd
from cleo.desktop.configuration import read_model_settings, save_model_profile
from cleo.desktop.projection import (
    changes_from_diff,
    path_name,
    project_id,
    project_name_from_id,
    relative_time,
    stream_event_item,
    timeline_from_events,
)
from cleo.harnesses.control import HarnessModel
from cleo.integrations.git import inspect_git_status, read_git_diff
from cleo.memory.compaction import load_events
from cleo.memory.overview import build_memory_overview
from cleo.memory.paths import memory_state_path
from cleo.memory.state import (
    get_session_source,
    mark_consolidation_failed,
    mark_consolidation_skipped,
)
from cleo.runtime.usage import ContextWindowUsage

Emit = Callable[[dict[str, Any]], Awaitable[None]]

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
            memory_gate=self.settings.memory_gate,
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
                gate_result={"provider": "manual", "decision": "skip", "reason": reason},
                path=state_path,
            )
        else:
            if self._dream_agent_factory is None:
                from cleo.agents.dream import DreamAgent

                dream_agent = DreamAgent()
            else:
                dream_agent = self._dream_agent_factory()
            try:
                await dream_agent.invoke(space=space, project=project, session_id=session_id)
            except Exception as exc:
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

    async def create_thread(
        self,
        *,
        space: str,
        project_id_value: str,
        provider: str | None = None,
        model: str | None = None,
        profile_id: str | None = None,
        project_path: str | None = None,
    ) -> dict[str, Any]:
        selected_path: str | None = None
        if project_path is not None:
            path = Path(project_path).expanduser().resolve()
            if not path.is_dir():
                raise ValueError(f"工作目录不存在或不是文件夹：{path}")
            selected_path = str(path)
            project = path_name(selected_path, "workspace")
            project_id_value = project_id("productivity", project)
            self._project_paths[project_id_value] = selected_path
        else:
            project = project_name_from_id(project_id_value)
        if space == "chat":
            if selected_path is not None:
                raise ValueError("Cleo 对话不接受代码工作目录。")
            thread_id = f"cleo_{secrets.token_hex(6)}"
            manifest = self.store.create_session(
                session_id=thread_id,
                space="non_productivity",
                project=project or "general",
                provider="cleo",
                owner_type="user",
                cwd=str(self.settings.active_directory_profile.root_path),
            )
            selected_profile = profile_id or self._active_agent_profile_id()
            self._agent_profile(selected_profile)
            manifest = self.store.update_manifest(
                thread_id,
                runtime_options={"agent_profile": selected_profile},
            )
        else:
            adapter = self._adapter()
            provider_name = provider or self.settings.productivity.default_provider
            project_path = self._project_paths.get(
                project_id_value,
                selected_path or str(self.settings.active_directory_profile.root_path),
            )
            selected_model = model or self.settings.productivity.provider(provider_name).model
            session = await adapter.create_session(
                provider_name,
                project_path=project_path,
                model=selected_model,
                project=project or path_name(project_path, "general"),
            )
            self._productivity_sessions[session.id] = session
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
            self._agent_profile(profile_id)
            current = (
                manifest.get("runtime_options")
                if isinstance(manifest.get("runtime_options"), dict)
                else {}
            )
            self.store.update_manifest(
                thread_id,
                runtime_options={**current, "agent_profile": profile_id},
            )
            self._chat_agents.pop(thread_id, None)
            self._chat_agents_restored.discard(thread_id)
            return self._runtime_profile(self.store.load_manifest(thread_id))
        await self._ensure_productivity_session(manifest)
        options: dict[str, Any] = {}
        if "model" in update:
            options["model"] = str(update["model"])
        if "effort" in update:
            options["effort"] = self._effort_backend(str(update["effort"]))
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
            dynamic = provider.type == "codex_sdk" or (
                provider.type == "acp" and bool(provider.options.model_config_id)
            )
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

        dynamic = provider_settings.type == "codex_sdk" or (
            provider_settings.type == "acp" and bool(provider_settings.options.model_config_id)
        )
        if dynamic:
            if provider_settings.type == "acp":
                control = self._adapter().provider_control(provider)
                models = await control.list_models(
                    project_path
                    or str(self.settings.active_directory_profile.root_path)
                )
                source = "acp"
            else:
                models = await self._adapter().list_models(provider)
                source = "sdk"
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
                self._configured_harness_model(identifier, provider_settings.model)
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
        return save_model_profile(self.settings.PROFILE_DIR, profile)

    async def reset_workspace(self) -> dict[str, Any]:
        from cleo.cli.workspace import reset_workspace_to_main

        await asyncio.to_thread(
            reset_workspace_to_main, self.settings.active_directory_profile.root_path
        )
        return {"reset": True}

    async def shutdown(self) -> None:
        jobs = []
        for thread_id, agent in self._chat_agents.items():
            try:
                manifest = self.store.load_manifest(thread_id)
                await self._sync_chat(agent, manifest, "completed")
            except (FileNotFoundError, OSError, ValueError):
                continue
            jobs.append((thread_id, manifest["project"], manifest["space"]))
        if jobs:
            _launch_dream_agent_worker(jobs, store=self.store)
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
            )
            self._chat_agents[manifest["id"]] = agent
        loaded = None
        if manifest["id"] not in self._chat_agents_restored:
            loaded = self.store.load_langchain_messages(manifest["id"])
            self._chat_agents_restored.add(manifest["id"])
        text = ""
        async for chunk in agent.stream_text(
            prompt,
            manifest["id"],
            loaded_info=loaded or None,
            images=[self._chat_attachment(item) for item in attachments],
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
        if attachments:
            paths = [str(item.get("path") or "") for item in attachments if item.get("path")]
            if paths:
                prompt = f"{prompt}\n\nAttached local files:\n" + "\n".join(
                    f"- {path}" for path in paths
                )
        state: dict[str, Any] = {}
        usage = ContextWindowUsage(
            window_tokens=self._runtime_profile(manifest)["contextWindow"],
        )

        async def on_event(event: Any) -> None:
            from cleo.cli.productivity_renderer import capture_context_usage

            capture_context_usage(event, usage)
            for projected in stream_event_item(event, state):
                await emit(projected)
            if usage.used_tokens is not None:
                await emit({"type": "usage", "usage": self._usage_dict(usage)})

        result = await self._adapter().prompt(manifest["id"], prompt, on_event=on_event)
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
        diff = await asyncio.to_thread(read_git_diff, manifest.get("cwd") or ".")
        await emit({"type": "changes", "changes": changes_from_diff(diff)})
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
                update = {field: self._effort_backend(argument) if field == "effort" else argument}
                await adapter.update_session_options(manifest["id"], **update)
                await self._notice(emit, "运行参数已更新", f"{field} = {argument}", "success")
        elif command == "/cd":
            target = _resolve_productivity_cwd(argument, session.project_path)
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
        candidates[project_id("productivity", root_name)] = ("productivity", root_name, root_path)
        for space in ("non_productivity", "productivity"):
            for name in self.runtime.projects_for(space):
                fallback_path = f"memory://{name}" if space == "non_productivity" else root_path
                candidates[project_id(space, name)] = (self._ui_space(space), name, fallback_path)
        for manifest in manifests:
            space = self._ui_space(manifest["space"])
            name = str(manifest["project"])
            path = str(
                manifest.get("cwd") or (f"memory://{name}" if space == "chat" else root_path)
            )
            candidates[project_id(manifest["space"], name)] = (space, name, path)

        projects = []
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
            changes = changes_from_diff(diff)
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
            profile = self._agent_profile(profile_id)
            return {
                "profileId": profile_id,
                "provider": profile.provider,
                "model": profile.model,
                "models": [item.model for item in self._agent_profiles().values()],
                "effort": "高",
                "access": str(self.settings.active_shell_profile.sandbox_root),
                "approval": "Cleo 工具策略",
                "contextWindow": profile.max_tokens,
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
            "effort": self._effort_ui(options.get("effort")),
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
        options = (
            manifest.get("runtime_options")
            if isinstance(manifest.get("runtime_options"), dict)
            else {}
        )
        return self._agent_profile(
            str(options.get("agent_profile") or self._active_agent_profile_id())
        )

    @staticmethod
    def _configured_harness_model(identifier: str, default_model: str | None) -> HarnessModel:
        return HarnessModel(
            id=identifier,
            display_name=identifier,
            description="Configured in harnesses.json",
            is_default=identifier == default_model,
            default_effort=None,
            supported_efforts=(),
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
        return session

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
        self.runtime.update_current_project(str(manifest["project"]))
        self.runtime.update_current_thread_id(str(manifest["id"]))
        self.runtime.append_recent_threads(str(manifest["id"]), str(manifest["space"]))

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
    def _chat_attachment(item: dict[str, Any]) -> dict[str, str]:
        return {
            "name": str(item.get("name") or "image"),
            "base64": str(item.get("base64") or ""),
            "mime_type": str(item.get("mimeType") or "application/octet-stream"),
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
    def _effort_ui(value: Any) -> str:
        return {"low": "低", "medium": "中", "high": "高", "xhigh": "高"}.get(str(value), "中")

    @staticmethod
    def _effort_backend(value: str) -> str:
        return {"低": "low", "中": "medium", "高": "high"}.get(value, value)

    @staticmethod
    def _debug(message: str) -> None:
        if os.environ.get("CLEO_DESKTOP_DEBUG") == "1":
            sys.stderr.write(f"[cleo-service] {message}\n")
            sys.stderr.flush()
