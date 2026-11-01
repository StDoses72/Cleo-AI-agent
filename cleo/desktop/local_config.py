"""Settings-only stdio backend for the opt-in, loopback development preview."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace

from cleo.bootstrap.container import build_config_service
from cleo.desktop.configuration import read_model_settings
from cleo.desktop.routing_settings import RoutingControls
from cleo.desktop.rpc import RpcMethod, RpcRegistry
from cleo.desktop.server import ProtocolServer
from cleo.desktop.task_harnesses import task_providers

METHODS = (
    "get_model_settings", "get_routing_settings", "save_routing_settings",
    "refresh_routing_benchmarks",
    "save_benchmark_connection",
    "submit_routing_feedback",
    "get_task_usage_preview",
)


class LocalConfigService:
    """Reuse desktop configuration controls without sessions or background workers."""

    def __init__(self, config):
        """Purpose: Bind configuration. Input: ConfigService. Output: idle metadata service."""
        self.config = config
        self.adapter = None
        self.adapter_version = None

    async def get_model_settings(self):
        """Purpose: Show configured connections. Output: summaries without credentials/URLs."""
        result = read_model_settings(self.config.snapshot.settings.PROFILE_DIR)
        for profile in result["profiles"]:
            profile["baseUrl"] = None
            profile["executable"] = ""
        return result

    async def get_task_usage_preview(self, session_id: str | None = None):
        """Purpose: Read an existing root's active ledger, never execute or expose history.

        Input: Optional existing tracked user-session ID. Output: safe session labels and
        current task counters. No prompts, events, historical tasks or providers are returned.
        """
        from cleo.runtime.task_scopes import task_abstract
        from cleo.runtime.task_usage import task_usage
        from cleo.sessions.store import SessionStore

        settings = self.config.snapshot.settings

        def read():
            store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
            sessions = []
            for row in store.list_sessions():
                try:
                    manifest = store.load_manifest(row["id"])
                except (OSError, ValueError):
                    continue
                # Productivity roots are agent-owned even when opened by the user.
                # Parent binding, rather than owner_type alone, separates delegated work.
                if (manifest.get("parent_session_id")
                        or manifest.get("owner_type") not in {"user", "agent"}
                        or not manifest.get("usage_task_id")):
                    continue
                sessions.append({"id": row["id"], "label": task_abstract(
                    f"{manifest['project']} · {row['id']}")})
                if len(sessions) == 50:
                    break
            selected = session_id or (sessions[0]["id"] if sessions else None)
            if selected is not None and selected not in {row["id"] for row in sessions}:
                raise ValueError("Preview requires an existing tracked root session")
            usage = task_usage(store, selected) if selected else None
            if usage and usage.get("scope") != "task":
                usage = None
            if usage:
                usage = {key: value for key, value in usage.items()
                         if key not in {"history", "breakdown"}}
            return {"sessionId": selected, "sessions": sessions, "usage": usage}

        return await asyncio.to_thread(read)

    async def _controls(self):
        """Purpose: Reuse live routing services. Output: controls with the current snapshot."""
        from cleo.integrations.harnesses.factory import build_agent_adapter

        snapshot = self.config.snapshot
        settings = snapshot.settings
        if self.adapter_version != snapshot.version:
            await self.shutdown()
            self.adapter = build_agent_adapter(
                settings.active_directory_profile.root_path,
                settings.productivity.model_copy(update={
                    "providers": task_providers(settings.productivity),
                }),
                session_store=SimpleNamespace(
                    memory_root=settings.MEMORY_DIR, index_path=settings.SESSION_INDEX_PATH,
                ),
                computer_config_path=Path(settings.PROFILE_DIR).with_name("computer-use.json"),
            )
            self.adapter_version = snapshot.version
        return RoutingControls(
            settings, SimpleNamespace(memory_root=settings.MEMORY_DIR), self.adapter,
        )

    async def get_routing_settings(self, refresh=False):
        """Purpose: Read metadata only. Input: refresh flag. Output: routing settings."""
        return await (await self._controls()).view(refresh)

    async def save_routing_settings(self, update):
        """Purpose: Persist explicit policy edits. Input: revision/edits. Output: saved view."""
        return await (await self._controls()).save(update)

    async def refresh_routing_benchmarks(self):
        """Purpose: Explicitly refresh public benchmark metadata. Output: cache status."""
        return await (await self._controls()).refresh_benchmarks()

    async def submit_routing_feedback(self, update):
        """Purpose: Record user outcomes through shared controls. Output: refreshed view."""
        return await (await self._controls()).submit_feedback(update)

    async def save_benchmark_connection(self, update):
        """Purpose: Save AA settings through shared controls. Output: credential-free view."""
        return await (await self._controls()).save_benchmark_connection(update)

    async def shutdown(self):
        """Purpose: Close metadata clients only. Output: no session or computer mutations."""
        if self.adapter is not None:
            await self.adapter.aclose()
            self.adapter = None
            self.adapter_version = None


async def main():
    """Purpose: Serve the restricted protocol. Input: stdio. Output: settings responses."""
    if not os.environ.get("CLEO_CODEX_BIN"):
        from cleo.desktop.dependencies import validate_codex_runtime

        os.environ["CLEO_CODEX_BIN"] = validate_codex_runtime()
    config = build_config_service()
    await ProtocolServer(
        LocalConfigService(config), config=config,
        registry=RpcRegistry(RpcMethod(name, "renderer") for name in METHODS),
    ).run()


if __name__ == "__main__":
    asyncio.run(main())
