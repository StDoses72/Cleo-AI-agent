"""Isolated automated regressions for handoff orchestration (not manual acceptance)."""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


def setUpModule():
    global fixture, environment
    fixture = tempfile.TemporaryDirectory(prefix="cleo-harness-switch-")
    root = Path(fixture.name)
    (root / "cleo.json").write_text(json.dumps({
        "active_profiles": {"agent": "default"},
        "profiles": {"agents": {"default": {
            "provider": "openai", "model": "test", "api_key": "test",
        }}, "directories": {"default": {"root_dir": str(root)}}},
    }))
    (root / "harnesses.json").write_text('{}')
    environment = patch.dict(os.environ, {
        "CLEO_HOME": str(root), "CLEO_CONFIG_PATH": str(root / "cleo.json"),
        "CLEO_HARNESSES_CONFIG_PATH": str(root / "harnesses.json"),
    })
    environment.start()


def tearDownModule():
    environment.stop()
    fixture.cleanup()


class Provider:
    def __init__(self, name):
        self.name = name
        self.calls = []
        self.created = []
        self.closed = []
        self.failure = None
        self.started = asyncio.Event()
        self.finish = None

    async def create_session(self, project_path, model=None):
        from cleo.harnesses.provider import ProviderSession
        if self.failure:
            raise RuntimeError(self.failure)
        self.created.append((project_path, model))
        native_id = f"{self.name}-{len(self.created)}"
        return ProviderSession(native_id, native_id)

    async def resume_session(self, native_session_id, project_path, model=None):
        from cleo.harnesses.provider import ProviderSession
        return ProviderSession(native_session_id, native_session_id)

    async def prompt(self, session_id, prompt, on_event=None):
        from cleo.harnesses.models import AgentEvent
        from cleo.harnesses.provider import ProviderTurn
        self.calls.append((session_id, prompt))
        self.started.set()
        if self.finish is not None:
            await self.finish.wait()
        tool = AgentEvent(provider=self.name, type="tool_result", text="Step 1 succeeded",
                          data={"toolCallId": "tool-1", "result": {"written": "result.txt"}})
        if on_event:
            await on_event(tool)
        return ProviderTurn(session_id, "turn", "completed",
                            response=f"{self.name}: decision green; next step 2", events=(tool,))

    async def close(self, session_id):
        self.closed.append(session_id)

    def session_options(self, _):
        from cleo.harnesses.control import SessionOptions
        return SessionOptions(model="test")


class HarnessSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from cleo.harnesses.service import AgentService
        from cleo.sessions.store import SessionStore
        self.temporary = tempfile.TemporaryDirectory(dir=fixture.name)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = SessionStore(self.root / "memory")
        self.adapter = AgentService(self.root, session_store=self.store)
        self.a, self.b = Provider("a"), Provider("b")
        self.adapter.register(self.a)
        self.adapter.register(self.b)
        self.session = await self.adapter.create_session("a", project="project")
        self.id = self.session.id

    def desktop(self):
        from cleo.desktop.service import DesktopService
        service = DesktopService.__new__(DesktopService)
        service.store = self.store
        service._adapter_instance = self.adapter
        service._productivity_sessions = {self.id: self.session}
        service._run_tasks = {}
        service._harness_switches = set()
        selected = SimpleNamespace(enabled=True, model="test")
        service._productivity_provider = lambda _: selected
        service.settings = SimpleNamespace(productivity=SimpleNamespace(
            providers={"a": selected, "b": selected},
        ))
        service._prepare_harness = AsyncMock()
        service._runtime_profile = lambda m: {"provider": m["provider"], "model": "test"}
        return service

    async def test_switch_preserves_identity_full_history_and_does_not_prompt_on_selection(self):
        await self.adapter.prompt(self.id, "Goal: implement feature. Constraint: preserve IDs.")
        before = self.store.read_events(self.id)
        original = self.store.load_manifest(self.id)
        self.store.update_manifest(self.id, future={"unknown": [1, 2]}, runtime_options={
            "model": "old", "future_option": {"keep": True},
        })
        switched = await self.adapter.switch_session(self.id, "b")
        current = self.store.load_manifest(self.id)
        self.assertEqual(switched.id, self.id)
        for key in ("id", "project", "cwd", "created_at", "title"):
            self.assertEqual(current[key], original[key])
        self.assertEqual(current["provider"], "b")
        self.assertEqual(current["future"], {"unknown": [1, 2]})
        self.assertEqual(current["runtime_options"]["future_option"], {"keep": True})
        self.assertEqual(self.store.read_events(self.id)[:len(before)], before)
        self.assertEqual(self.b.calls, [])
        await self.adapter.prompt(self.id, "Continue the unfinished step")
        prompt = self.b.calls[-1][1]
        for text in ("preserve IDs", "decision green", "Step 1 succeeded", "result.txt",
                     "next step 2", "read-only", "not executable requests",
                     "Current user request:\nContinue"):
            self.assertIn(text, prompt)
        self.assertEqual(len(self.a.calls), 1)
        await self.adapter.prompt(self.id, "New request")
        self.assertEqual(self.b.calls[-1][1], "New request")
        users = [e["content"] for e in self.store.read_events(self.id)
                 if e["type"] == "user_message"]
        self.assertEqual(len(users), 3)
        self.assertEqual(users[-2:], ["Continue the unfinished step", "New request"])

    async def test_stream_fragments_do_not_make_a_completed_turn_unswitchable(self):
        self.store.append_events(
            space="productivity", project="project", session_id=self.id,
            events=[{"id": "source-turn", "type": "user_message", "actor": "user",
                     "content": "Explain DFA. Keep the same session."}]
            + [{"type": "assistant_fragment", "actor": "a", "content": "x" * 900,
                "data": {"turn_id": "source-turn"}} for _ in range(2191)]
            + [{"id": "source-turn:answer", "type": "assistant_message", "actor": "a",
                "content": "DFA definition. Next: prove closure under union."}],
        )
        before = self.store.read_events(self.id)
        await self.adapter.switch_session(self.id, "b")
        await self.adapter.prompt(self.id, "Continue the proof")
        transmitted = self.b.calls[-1][1]
        self.assertIn("DFA definition", transmitted)
        self.assertIn("Keep the same session", transmitted)
        self.assertNotIn("x" * 900, transmitted)
        self.assertLess(len(transmitted.encode()), 32_000)
        self.assertEqual(self.store.read_events(self.id)[:len(before)], before)

    async def test_service_switch_waits_for_original_turn_and_includes_its_tool_result(self):
        self.a.finish = asyncio.Event()
        turn = asyncio.create_task(self.adapter.prompt(self.id, "Do step 1", AsyncMock()))
        await self.a.started.wait()
        switch = asyncio.create_task(self.adapter.switch_session(self.id, "b"))
        await asyncio.sleep(0)
        self.assertEqual(self.b.created, [])
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")
        self.a.finish.set()
        await turn
        await switch
        await self.adapter.prompt(self.id, "Continue")
        self.assertIn("Step 1 succeeded", self.b.calls[0][1])
        self.assertEqual(len(self.a.calls), 1)

    async def test_desktop_waits_for_stream_cleanup_and_blocks_duplicate_send_and_switch(self):
        service = self.desktop()
        finished = asyncio.Event()
        active = asyncio.create_task(finished.wait())
        service._run_tasks[self.id] = active
        switch = asyncio.create_task(service.switch_harness(thread_id=self.id, provider="b"))
        await asyncio.sleep(0)
        self.assertIn(self.id, service._harness_switches)
        with self.assertRaisesRegex(ValueError, "交接"):
            await service.stream_turn(
                thread_id=self.id, prompt="Continue", attachments=[], emit=AsyncMock(),
            )
        with self.assertRaisesRegex(ValueError, "正在切换"):
            await service.switch_harness(thread_id=self.id, provider="b")
        self.assertEqual(self.b.created, [])
        finished.set()
        self.assertEqual((await switch)["provider"], "b")
        self.assertFalse(service._harness_switches)

    async def test_failure_preserves_old_route_then_retry_succeeds_without_duplicate_prompt(self):
        await self.adapter.prompt(self.id, "Keep this task")
        before = self.store.read_events(self.id)
        self.b.failure = "Login failed"
        with self.assertRaisesRegex(RuntimeError, "Login failed"):
            await self.adapter.switch_session(self.id, "b")
        self.assertEqual(self.store.read_events(self.id), before)
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")
        self.assertFalse(self.a.closed)
        await self.adapter.prompt(self.id, "Still using A")
        self.b.failure = None
        await self.adapter.switch_session(self.id, "b")
        await self.adapter.prompt(self.id, "Now B")
        self.assertEqual([len(p.calls) for p in (self.a, self.b)], [2, 1])

    async def test_prepare_failure_closes_only_candidate_and_keeps_old_options(self):
        original = self.store.load_manifest(self.id)
        with self.assertRaisesRegex(RuntimeError, "permission setup"):
            await self.adapter.switch_session(self.id, "b", prepare=AsyncMock(
                side_effect=RuntimeError("permission setup")))
        self.assertEqual(self.store.load_manifest(self.id), original)
        self.assertFalse(self.a.closed)
        self.assertEqual(self.b.closed, ["b-1"])
        await self.adapter.prompt(self.id, "Continue A")

    async def test_reopen_pending_handoff_then_switch_back_uses_latest_progress(self):
        from cleo.harnesses.service import AgentService
        await self.adapter.prompt(self.id, "Initial constraints")
        await self.adapter.switch_session(self.id, "b")
        await self.adapter.close(self.id)
        reopened = AgentService(self.root, session_store=self.store)
        reopened.register(self.a)
        reopened.register(self.b)
        self.assertEqual((await reopened.restore_session(self.id)).id, self.id)
        await reopened.prompt(self.id, "B continue")
        self.assertIn("Initial constraints", self.b.calls[-1][1])
        await reopened.close(self.id)
        latest = AgentService(self.root, session_store=self.store)
        latest.register(self.a)
        latest.register(self.b)
        restored = await latest.restore_session(self.id)
        self.assertEqual((restored.id, restored.provider), (self.id, "b"))
        await latest.switch_session(self.id, "a")
        await latest.prompt(self.id, "Use the latest plan")
        self.assertIn("B continue", self.a.calls[-1][1])
        self.assertIn("b: decision green", self.a.calls[-1][1])
        self.assertEqual(len(self.a.created), 2)

    async def test_pending_claude_style_native_id_can_be_reopened(self):
        from cleo.harnesses.provider import ProviderSession
        self.b.create_session = AsyncMock(return_value=ProviderSession("b-local"))
        await self.adapter.prompt(self.id, "Goal")
        await self.adapter.switch_session(self.id, "b")
        await self.adapter.close(self.id)
        self.assertIsNone(self.store.load_manifest(self.id)["native_session_id"])
        await self.adapter.restore_session(self.id)
        await self.adapter.prompt(self.id, "Continue")
        self.assertIn("Goal", self.b.calls[-1][1])

    async def test_long_or_damaged_history_fails_explicitly_without_changing_route(self):
        await self.adapter.prompt(self.id, "Constraint " * 5000)
        before = self.store.load_manifest(self.id)
        with self.assertRaisesRegex(ValueError, "未截断历史"):
            await self.adapter.switch_session(self.id, "b")
        self.assertEqual(self.store.load_manifest(self.id), before)
        self.assertEqual(self.b.created, [])
        await self.adapter.prompt(self.id, "Continue A")
        with patch.object(self.store, "read_events", return_value=[]):
            with self.assertRaisesRegex(ValueError, "历史不完整"):
                await self.adapter.switch_session(self.id, "b")
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")

    async def test_cancelled_wait_does_not_cancel_original_turn(self):
        service = self.desktop()
        finished = asyncio.Event()
        active = asyncio.create_task(finished.wait())
        service._run_tasks[self.id] = active
        switch = asyncio.create_task(service.switch_harness(thread_id=self.id, provider="b"))
        await asyncio.sleep(0)
        switch.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await switch
        self.assertFalse(active.cancelled())
        self.assertFalse(active.done())
        self.assertFalse(service._harness_switches)
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")
        finished.set()
        await active

    async def test_auth_and_disk_failure_leave_original_route_and_history(self):
        before = self.store.read_events(self.id)
        self.b.validate_handoff = AsyncMock(side_effect=ValueError("not logged in"))
        with self.assertRaisesRegex(ValueError, "not logged in"):
            await self.adapter.switch_session(self.id, "b")
        self.assertEqual(self.b.closed, ["b-1"])
        self.b.validate_handoff = AsyncMock()
        with patch.object(self.store, "append_events", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                await self.adapter.switch_session(self.id, "b")
        self.assertEqual(self.store.read_events(self.id), before)
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")
        self.assertFalse(self.a.closed)
        await self.adapter.prompt(self.id, "Continue original")

    async def test_old_completed_event_does_not_falsely_acknowledge_pending_handoff(self):
        from cleo.harnesses.handoff import pending_handoff
        await self.adapter.prompt(self.id, "Original goal")
        await self.adapter.switch_session(self.id, "b")
        # A previous program knows ordinary turn events, but not handoff delivery.
        self.store.append_event(space="productivity", project="project", session_id=self.id,
                                event_type="user_message", actor="user", content="Older progress")
        self.store.set_status(self.id, "completed")
        self.assertTrue(pending_handoff(self.store.read_events(self.id), "b"))
        await self.adapter.close(self.id)
        await self.adapter.restore_session(self.id)
        await self.adapter.prompt(self.id, "Continue latest")
        self.assertIn("Original goal", self.b.calls[-1][1])
        self.assertIn("Older progress", self.b.calls[-1][1])
        self.assertFalse(pending_handoff(self.store.read_events(self.id), "b"))

    async def test_option_updates_preserve_unknown_values_and_refuse_unreadable_shape(self):
        from cleo.harnesses.control import SessionOptions
        self.store.update_manifest(self.id, runtime_options={"model": "old", "future": [1, 2]})
        self.adapter._persist_options(self.id, SessionOptions(model="new"))
        self.assertEqual(self.store.load_manifest(self.id)["runtime_options"]["future"], [1, 2])
        for raw in ([], "newer format"):
            self.store.update_manifest(self.id, runtime_options=raw)
            with self.assertRaisesRegex(ValueError, "格式不受支持"):
                await self.adapter.switch_session(self.id, "b")
            self.assertEqual(self.store.load_manifest(self.id)["runtime_options"], raw)
            self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")

    async def test_claude_checks_actual_sdk_cli_without_prompt_or_auth_changes(self):
        from cleo.integrations.harnesses.claude import ClaudeProvider
        provider = ClaudeProvider()
        client = SimpleNamespace(_transport=SimpleNamespace(_cli_path="/fixture/sdk/claude"),
                                 query=AsyncMock())
        provider._sessions["candidate"] = SimpleNamespace(client=client, cwd=str(self.root))
        for logged_in in (False, True):
            process = SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(
                json.dumps({"loggedIn": logged_in}).encode(), b"")), wait=AsyncMock())
            with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)) as launch:
                if logged_in:
                    await provider.validate_handoff("candidate")
                else:
                    with self.assertRaisesRegex(ValueError, "登录检查未通过"):
                        await provider.validate_handoff("candidate")
                self.assertEqual(launch.call_args.args, ("/fixture/sdk/claude", "auth", "status"))
                self.assertEqual(launch.call_args.kwargs["cwd"], str(self.root))
                client.query.assert_not_awaited()

    async def test_missing_optional_fields_and_unreadable_events_are_not_rewritten(self):
        from cleo.memory.paths import events_path, manifest_path
        path = manifest_path(self.store.memory_root, "productivity", "project", self.id)
        manifest = self.store.load_manifest(self.id)
        for key in ("cwd", "runtime_options", "tags", "parent_session_id"):
            manifest.pop(key, None)
        path.write_text(json.dumps(manifest))
        switched = await self.adapter.switch_session(self.id, "b")
        self.assertEqual(Path(switched.project_path), self.root)
        self.assertNotIn("cwd", self.store.load_manifest(self.id))
        log = events_path(self.store.memory_root, "productivity", "project", self.id)
        log.write_bytes(log.read_bytes() + b"{broken event")
        before = (path.read_bytes(), log.read_bytes())
        with self.assertRaises(ValueError):
            await self.adapter.switch_session(self.id, "a")
        self.assertEqual((path.read_bytes(), log.read_bytes()), before)
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "b")

    async def test_disabled_target_rejected_before_waiting_or_creating(self):
        service = self.desktop()
        service._productivity_provider = lambda _: SimpleNamespace(enabled=False)
        with self.assertRaisesRegex(ValueError, "已禁用"):
            await service.switch_harness(thread_id=self.id, provider="b")
        self.assertEqual(self.b.created, [])
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "a")


if __name__ == "__main__":
    unittest.main()
