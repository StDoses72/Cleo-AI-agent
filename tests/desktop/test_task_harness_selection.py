"""Offline task/model checks using isolated configuration and mocked vendor clients."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


def setUpModule():
    """Purpose: Isolate import-time settings. Input: none. Output: temporary test home."""
    global fixture, environment
    fixture = tempfile.TemporaryDirectory(prefix="cleo-task-models-")
    root = Path(fixture.name)
    (root / "cleo.json").write_text(json.dumps({
        "active_profiles": {"agent": "default"},
        "profiles": {
            "agents": {"default": {"provider": "openai", "model": "test", "api_key": "test"}},
            "directories": {"default": {"root_dir": str(root)}},
        },
    }), encoding="utf-8")
    (root / "harnesses.json").write_text('{}', encoding="utf-8")
    environment = patch.dict(os.environ, {
        "CLEO_HOME": str(root), "CLEO_CONFIG_PATH": str(root / "cleo.json"),
        "CLEO_HARNESSES_CONFIG_PATH": str(root / "harnesses.json"),
    })
    environment.start()


def tearDownModule():
    """Purpose: Remove fixtures. Input: none. Output: original environment restored."""
    environment.stop()
    fixture.cleanup()


class TaskHarnessTests(unittest.IsolatedAsyncioTestCase):
    def service(self):
        """Purpose: Build a desktop facade without live data. Input: none. Output: facade."""
        from cleo.config.settings import ProductivitySettings
        from cleo.desktop.service import DesktopService
        from cleo.sessions.store import SessionStore

        service = DesktopService.__new__(DesktopService)
        service.settings = SimpleNamespace(
            productivity=ProductivitySettings(),
            active_directory_profile=SimpleNamespace(root_path=Path(fixture.name)),
        )
        service.store = SessionStore(Path(fixture.name) / "memory")
        service._adapter_instance = None
        service._agent_profiles = lambda: {}
        service._active_agent_profile_id = lambda: "default"
        return service

    async def test_task_catalog_contains_builtins_without_rewriting_configuration(self):
        service = self.service()
        before = service.settings.productivity.model_dump()
        config = Path(fixture.name) / "harnesses.json"
        original = config.read_bytes()
        catalog = await service.get_runtime_catalog()
        self.assertEqual({p["id"] for p in catalog["productivityProviders"]}, {
            "codex", "claude", "gemini", "copilot", "grok", "opencode",
        })
        self.assertEqual(before, service.settings.productivity.model_dump())
        self.assertEqual(original, config.read_bytes())
        self.assertEqual(catalog["defaultProductivityProvider"], "codex")

    async def test_explicit_disabled_and_custom_harnesses_take_precedence(self):
        from cleo.config.settings import ClaudeHarnessSettings
        from cleo.desktop.task_harnesses import task_providers

        service = self.service()
        custom = ClaudeHarnessSettings(model="custom-model", models=["custom-extra"])
        service.settings.productivity.providers.update({
            "claude": ClaudeHarnessSettings(enabled=False), "my-claude": custom,
        })
        self.assertIs(task_providers(service.settings.productivity)["my-claude"], custom)
        catalog = await service.get_runtime_catalog()
        names = {p["id"] for p in catalog["productivityProviders"]}
        self.assertNotIn("claude", names)
        self.assertIn("my-claude", names)

    async def test_registration_refuses_unreadable_unknown_or_disabled_data(self):
        from cleo.config.settings import ClaudeHarnessSettings
        from cleo.desktop.task_harnesses import register_task_provider

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "harnesses.json"
            for content in (
                "{broken",
                '{"future_schema": 2}',
                '{"providers":{"codex":{"type":"codex_sdk"},"claude":{"type":"claude_sdk","enabled":false}}}',
            ):
                with self.subTest(content=content):
                    path.write_text(content, encoding="utf-8")
                    before = path.read_bytes()
                    with self.assertRaises(ValueError):
                        register_task_provider(path, "claude", ClaudeHarnessSettings())
                    self.assertEqual(path.read_bytes(), before)

    async def test_registration_preserves_missing_optional_fields_and_is_idempotent(self):
        from cleo.config.settings import ClaudeHarnessSettings
        from cleo.desktop.task_harnesses import register_task_provider

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "harnesses.json"
            path.write_text('{}', encoding="utf-8")
            register_task_provider(path, "claude", ClaudeHarnessSettings())
            before = path.read_bytes()
            register_task_provider(path, "claude", ClaudeHarnessSettings())
            self.assertEqual(before, path.read_bytes())
            self.assertIn("codex", json.loads(before)["providers"])

    async def test_claude_catalog_uses_the_selected_project(self):
        from cleo.harnesses.control import HarnessModel

        service = self.service()
        control = SimpleNamespace(list_models=AsyncMock(return_value=(
            HarnessModel("opus", "Opus", "Live choice", True, None, ()),
        )))
        service._adapter_instance = SimpleNamespace(
            providers=("claude",), provider_control=lambda _: control,
        )
        result = await service.get_productivity_models(provider="claude", project_path=fixture.name)
        control.list_models.assert_awaited_once_with(fixture.name)
        self.assertEqual(result["source"], "sdk")
        self.assertEqual(result["models"][0]["id"], "opus")

    async def test_development_registers_harness_before_creating_its_session(self):
        service = self.service()
        service._project_paths = {"productivity:project": fixture.name}
        service._productivity_sessions = {}
        service._restrict_evolution = AsyncMock()
        service._enable_desktop_approvals = AsyncMock()
        service._activate = lambda _: None
        service._thread = AsyncMock(return_value={"id": "new-task"})
        service.store = SimpleNamespace(load_manifest=lambda _: {"id": "new-task"})
        create_session = AsyncMock(return_value=SimpleNamespace(id="new-task"))
        service._adapter_instance = SimpleNamespace(create_session=create_session)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "harnesses.json"
            path.write_text('{}', encoding="utf-8")
            with patch("cleo.config.settings.HARNESSES_CONFIG_PATH", path):
                await service.create_thread(
                    space="productivity",
                    project_id_value="productivity:project",
                    provider="claude",
                    model="opus",
                )
            self.assertEqual(
                json.loads(path.read_text())["providers"]["claude"]["type"], "claude_sdk"
            )
        create_session.assert_awaited_once_with(
            "claude", project_path=fixture.name, model="opus", project="project",
        )

    async def test_connection_errors_are_not_replaced_by_a_default_catalog(self):
        service = self.service()
        control = SimpleNamespace(list_models=AsyncMock(side_effect=RuntimeError("login failed")))
        service._adapter_instance = SimpleNamespace(
            providers=("claude",), provider_control=lambda _: control,
        )
        with self.assertRaisesRegex(RuntimeError, "login failed"):
            await service.get_productivity_models(provider="claude")

    async def test_evolution_forwards_each_selected_harness_model_and_effort(self):
        for name in ("codex", "claude", "gemini", "copilot", "grok", "opencode"):
            with self.subTest(provider=name), patch.dict(os.environ, {
                "CLEO_EVOLUTION_WORKSPACE": fixture.name,
            }):
                service = self.service()
                service.create_thread = AsyncMock(return_value={"id": "fixture"})
                service.store = SimpleNamespace(rename_session=lambda *_: None)
                service._adapter_instance = SimpleNamespace(providers=(name,))
                service.load_thread = AsyncMock(return_value={"id": "fixture"})
                service.load_workspace = AsyncMock(return_value={})
                await service.open_evolution_thread(
                    provider=name, model="vendor-model", effort="high"
                )
                service.create_thread.assert_awaited_once_with(
                    space="productivity", project_id_value="productivity:cleo-evolution",
                    project_path=fixture.name, provider=name, model="vendor-model", effort="high",
                )


class ClaudeCatalogTests(unittest.IsolatedAsyncioTestCase):
    async def test_selected_model_reaches_the_claude_sdk(self):
        from cleo.integrations.harnesses.claude import ClaudeProvider

        client = SimpleNamespace(connect=AsyncMock(), disconnect=AsyncMock())
        with patch(
            "cleo.integrations.harnesses.claude.ClaudeSDKClient", return_value=client
        ) as sdk:
            provider = ClaudeProvider()
            session = await provider.create_session(fixture.name, model="opus")
            self.assertEqual(sdk.call_args.kwargs["options"].model, "opus")
            self.assertEqual(provider.session_options(session.id).model, "opus")
            await provider.close(session.id)

    async def test_discovery_preserves_vendor_ids_and_closes_without_prompting(self):
        from cleo.integrations.harnesses.claude_models import discover_claude_models

        client = SimpleNamespace(
            connect=AsyncMock(),
            disconnect=AsyncMock(),
            query=AsyncMock(),
            get_server_info=AsyncMock(
                return_value={
                    "models": [
                        {
                            "value": "fable",
                            "displayName": "Vendor Fable",
                            "supportedEffortLevels": ["high"],
                        },
                        {
                            "value": "opus",
                            "displayName": "Opus",
                            "description": "Vendor description",
                        },
                        {"value": ""},
                        {"unknown": True},
                    ]
                }
            ),
        )
        with patch(
            "cleo.integrations.harnesses.claude_models.ClaudeSDKClient", return_value=client
        ):
            models = await discover_claude_models(fixture.name)
        self.assertEqual([model.id for model in models], ["fable", "opus"])
        self.assertEqual(models[0].display_name, "Vendor Fable")
        self.assertEqual(models[0].supported_efforts, ("high",))
        self.assertEqual(models[1].supported_efforts, ())
        client.query.assert_not_awaited()
        client.disconnect.assert_awaited_once()

    async def test_discovery_closes_on_failure_and_propagates_the_error(self):
        from cleo.integrations.harnesses.claude_models import discover_claude_models

        client = SimpleNamespace(
            connect=AsyncMock(side_effect=RuntimeError("CLI failure")), disconnect=AsyncMock()
        )
        with patch(
            "cleo.integrations.harnesses.claude_models.ClaudeSDKClient", return_value=client
        ):
            with self.assertRaisesRegex(RuntimeError, "CLI failure"):
                await discover_claude_models(fixture.name)
        client.disconnect.assert_awaited_once()

    async def test_configured_models_are_preserved_without_overriding_live_capabilities(self):
        from cleo.harnesses.control import HarnessModel
        from cleo.integrations.harnesses.claude import ClaudeProvider

        provider = ClaudeProvider(default_model="opus", models=("custom",))
        discovered = HarnessModel("opus", "Live Opus", "Vendor", True, None, ())
        with patch("cleo.integrations.harnesses.claude_models.discover_claude_models",
                   AsyncMock(return_value=(discovered,))):
            models = await provider.list_models(fixture.name)
        self.assertEqual([model.id for model in models], ["opus", "custom"])
        self.assertEqual(models[0], discovered)

    async def test_older_claude_without_a_catalog_has_a_default_choice(self):
        from cleo.integrations.harnesses.claude import ClaudeProvider

        with patch("cleo.integrations.harnesses.claude_models.discover_claude_models",
                   AsyncMock(return_value=())):
            models = await ClaudeProvider().list_models(fixture.name)
        self.assertEqual([model.id for model in models], ["default"])
        self.assertEqual(models[0].supported_efforts, ())


if __name__ == "__main__":
    unittest.main()
