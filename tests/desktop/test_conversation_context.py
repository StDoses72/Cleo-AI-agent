"""Synthetic regression fixtures only: no personal history or external model calls."""

import json
import unittest
from unittest.mock import patch

import test_harness_switch as fixtures

setUpModule = fixtures.setUpModule
tearDownModule = fixtures.tearDownModule


class ConversationContextTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.HarnessSwitchTests.asyncSetUp

    async def test_manifest_durable_flush_uses_a_writable_descriptor(self):
        import os
        from pathlib import Path

        original_open, original_fsync = Path.open, os.fsync
        manifest_streams = []

        def opened(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            if path.name == "manifest.json":
                manifest_streams.append(stream)
            return stream

        def windows_flush(fd):
            for stream in manifest_streams:
                if not stream.closed and stream.fileno() == fd and not stream.writable():
                    raise OSError(9, "Bad file descriptor")
            return original_fsync(fd)

        await self.adapter.prompt(self.id, "Synthetic goal")
        with patch.object(Path, "open", opened), patch("os.fsync", windows_flush):
            await self.adapter.switch_session(self.id, "b")
        self.assertEqual(self.store.load_manifest(self.id)["provider"], "b")

    async def test_desktop_stream_publishes_durable_handoff_status_after_turn(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock

        from cleo.harnesses.context import handoff_status

        await self.adapter.prompt(self.id, "Synthetic goal")
        await self.adapter.switch_session(self.id, "b")
        service = fixtures.HarnessSwitchTests.desktop(self)
        service._ensure_productivity_session = AsyncMock()
        service._evolution_prompt = lambda manifest, prompt: prompt
        service._debug = lambda *args: None
        service._productivity_provider = lambda name: SimpleNamespace(type="codex_sdk")
        service._runtime_profile = lambda manifest: {
            "contextWindow": 64000,
            "handoffStatus": handoff_status(self.store.read_events(self.id)),
        }
        events = []

        async def emit(event):
            events.append(event)

        with (
            patch("cleo.desktop.service.create_git_checkpoint", side_effect=ValueError("not git")),
            patch("cleo.desktop.service.read_git_diff", return_value=""),
        ):
            await service._stream_productivity(
                self.store.load_manifest(self.id), "Continue", [], emit
            )
        updates = [e for e in events if e["type"] == "runtime"]
        self.assertTrue(updates, "Completed handoff must refresh the visible runtime profile")
        self.assertEqual(updates[-1]["runtime"]["handoffStatus"], "completed")

    def add(self, kind, content, **extra):
        return self.store.append_event(
            space="productivity",
            project="project",
            session_id=self.id,
            event_type=kind,
            actor="user" if kind == "user_message" else "a",
            content=content,
            **extra,
        )

    def context(self):
        from cleo.harnesses.context import ConversationContext

        return ConversationContext(self.store)

    async def test_long_evidence_pages_roundtrip_and_cannot_read_other_session(self):
        from cleo.harnesses.context import ContextReader

        self.add("user_message", "必须保留项目；不要再次执行已经完成的写入。")
        result = self.add(
            "tool_result",
            "中" * 10_000 + "unique-evidence-at-end",
            data={
                "api_key": "private-fixture",
                "nested": {"password": "hidden"},
                "result": "complete",
            },
        )
        prepared = self.context().prepare(self.id, self.store.read_events(self.id))
        self.assertTrue(prepared.requires_reader)
        reader = ContextReader(self.store, prepared.binding)
        cursor, parts = 0, []
        while True:
            page = reader.read_context(result["id"], cursor)
            self.assertLessEqual(len(page["content"].encode()), 8000)
            parts.append(page["content"])
            if page["next_cursor"] is None:
                break
            cursor = page["next_cursor"]
        record = json.loads("".join(parts))
        self.assertIn("中" * 10_000, record["text"])
        self.assertIn("unique-evidence-at-end", record["text"])
        self.assertNotIn("private-fixture", record["text"])
        self.assertNotIn("hidden", record["text"])
        self.assertEqual(
            reader.search_context("unique-evidence-at-end")["results"][0]["ref"], result["id"]
        )
        for ref in ("../../private", "another-session-event"):
            with self.assertRaisesRegex(ValueError, "belong"):
                reader.read_context(ref)
        for cursor in (-1, True, 999999999):
            with self.assertRaises(ValueError):
                reader.read_context(result["id"], cursor)

    async def test_incomplete_fragments_remain_but_completed_fragments_do_not(self):
        from cleo.harnesses.context import project

        events = [
            {"id": "u", "seq": 1, "type": "user_message", "content": "Goal"},
            {"id": "f1", "seq": 2, "type": "assistant_fragment", "content": "half"},
            {"id": "f2", "seq": 3, "type": "assistant_fragment", "content": " done"},
        ]
        projected = project(events)
        self.assertEqual(projected[-1]["text"], "half done")
        self.assertEqual(projected[-1]["type"], "incomplete_answer")
        events.append({"id": "u:answer", "seq": 4, "type": "assistant_message", "content": "final"})
        projected = project(events)
        self.assertEqual([r["type"] for r in projected], ["user_message", "assistant_message"])

    async def test_twenty_megabytes_of_tools_can_switch_with_bound_reader(self):
        async def create_context(cwd, model, binding):
            from cleo.harnesses.context import ContextReader

            self.reader = ContextReader(self.store, binding)
            return await self.b.create_session(cwd, model)

        self.b.create_context_session = create_context
        self.add("user_message", "Never repeat step 1. Next: verify result.")
        self.add("tool_result", "large result " * 1_600_000)
        before = self.store.read_events(self.id)
        await self.adapter.switch_session(self.id, "b")
        self.assertFalse(self.b.calls)
        await self.adapter.prompt(self.id, "Verify it")
        self.assertLess(len(self.b.calls[-1][1].encode()), 32_000)
        self.assertIn("Never repeat step 1", self.b.calls[-1][1])
        self.assertTrue(self.reader.search_context("large result")["results"])
        self.assertEqual(self.store.read_events(self.id)[: len(before)], before)

    async def test_snapshot_is_stable_across_append_but_detects_source_rewrite(self):
        from cleo.harnesses.context import ContextReader

        self.add("user_message", "Initial goal")
        before = self.store.read_events(self.id)
        prepared = self.context().prepare(self.id, before)
        self.add("user_message", "Later correction")
        reader = ContextReader(self.store, prepared.binding)
        self.assertFalse(reader.search_context("Later correction")["results"])
        changed = [dict(e) for e in before]
        changed[-1]["content"] = "tampered"
        with patch.object(self.store, "read_event_prefix", return_value=changed):
            with self.assertRaisesRegex(ValueError, "source changed"):
                reader.read_context()

    async def test_snapshot_is_deterministic_and_damaged_file_not_replaced_silently(self):
        self.add("user_message", "Goal")
        context = self.context()
        first = context.prepare(self.id, self.store.read_events(self.id))
        second = context.prepare(self.id, self.store.read_events(self.id))
        self.assertEqual(first, second)
        path = context._directory(self.id) / f"{first.binding.snapshot_id}.json"
        path.write_text("{}")
        with self.assertRaisesRegex(ValueError, "integrity"):
            context.load(first.binding)
        with self.assertRaisesRegex(ValueError, "integrity"):
            context.prepare(self.id, self.store.read_events(self.id))

    async def test_snapshots_share_large_evidence_and_frozen_prefix_ignores_partial_tail(self):
        from cleo.harnesses.context import ContextReader
        from cleo.memory.paths import events_path

        self.add("tool_result", "large evidence" * 100_000)
        context = self.context()
        first = context.prepare(self.id, self.store.read_events(self.id))
        self.add("user_message", "Next task")
        second = context.prepare(self.id, self.store.read_events(self.id))
        directory = context._directory(self.id)
        self.assertEqual(len(list((directory / "objects").glob("*.json"))), 2)
        self.assertLess((directory / f"{first.binding.snapshot_id}.json").stat().st_size, 4000)
        self.assertLess((directory / f"{second.binding.snapshot_id}.json").stat().st_size, 4000)
        log = events_path(self.store.memory_root, "productivity", "project", self.id)
        with log.open("a") as out:
            out.write("{partial concurrent tail")
        self.assertTrue(
            ContextReader(self.store, first.binding).search_context("large evidence")["results"]
        )

    async def test_new_request_too_large_is_not_recorded_or_sent(self):
        await self.adapter.prompt(self.id, "Goal")
        await self.adapter.switch_session(self.id, "b")
        before = self.store.read_events(self.id)
        with self.assertRaisesRegex(ValueError, "尚未提交模型"):
            await self.adapter.prompt(self.id, "新输入" * 20_000)
        self.assertFalse(self.b.calls)
        self.assertEqual(self.store.read_events(self.id), before)

    async def test_other_runtime_lease_fails_fast_and_is_released(self):
        with self.context().lease(self.id):
            with self.assertRaisesRegex(ValueError, "另一运行时"):
                with self.context().lease(self.id):
                    pass
        with self.context().lease(self.id):
            pass

    async def test_manifest_failure_after_log_commit_is_recoverable(self):
        import cleo.sessions.store as module

        before = self.store.load_manifest(self.id)
        original = module._atomic_write_json
        failed = False

        def write(path, value):
            nonlocal failed
            if path.name == "manifest.json" and value.get("provider") == "b" and not failed:
                failed = True
                raise OSError("fixture disk failure after event append")
            return original(path, value)

        with patch.object(module, "_atomic_write_json", side_effect=write):
            with self.assertRaisesRegex(OSError, "disk failure"):
                await self.adapter.switch_session(self.id, "b")
        current = self.store.load_manifest(self.id)
        self.assertEqual(current["provider"], "b")
        self.assertEqual(current["last_event_seq"], len(self.store.read_events(self.id)))
        self.assertNotIn(self.id, self.adapter._sessions)
        await self.adapter.restore_session(self.id)
        self.assertFalse(self.b.calls)
        self.assertEqual(current["id"], before["id"])

    async def test_mcp_tools_are_process_bound_and_paginated(self):
        from fastmcp import Client
        from fastmcp.exceptions import ToolError

        from cleo.mcp.memory_server import create_context_server

        self.add("user_message", "Remember marker-9281")
        prepared = self.context().prepare(self.id, self.store.read_events(self.id))
        server = create_context_server(
            str(self.store.memory_root),
            str(self.store.index_path),
            self.id,
            prepared.binding.snapshot_id,
        )
        async with Client(server) as client:
            names = {tool.name for tool in await client.list_tools()}
            self.assertEqual(names, {"read_context", "search_context"})
            result = await client.call_tool("search_context", {"query": "marker-9281"})
            self.assertIn("marker-9281", str(result))
            with self.assertRaises(ToolError):
                await client.call_tool("read_context", {"session_id": "other"})

    async def test_failed_submission_reopens_without_replaying_request(self):
        from unittest.mock import AsyncMock

        from cleo.harnesses.context import handoff_status

        await self.adapter.prompt(self.id, "Step 1 already wrote the file")
        await self.adapter.switch_session(self.id, "b")
        original = self.b.prompt
        self.b.prompt = AsyncMock(side_effect=RuntimeError("network result unknown"))
        with self.assertRaisesRegex(RuntimeError, "network result unknown"):
            await self.adapter.prompt(self.id, "Verify only; do not repeat the write")
        self.assertEqual(handoff_status(self.store.read_events(self.id)), "submitted")
        await self.adapter.close(self.id)
        await self.adapter.restore_session(self.id)
        self.b.prompt.assert_awaited_once()
        self.b.prompt = original
        await self.adapter.prompt(self.id, "Inspect current state first")
        self.assertIn("MAY already have run", self.b.calls[-1][1])
        self.assertEqual(len(self.b.calls), 1)
        self.assertEqual(handoff_status(self.store.read_events(self.id)), "completed")

    async def test_stdio_reader_works_with_spaces_and_does_not_modify_project(self):
        import sys

        from fastmcp import Client
        from fastmcp.client.transports import StdioTransport

        from cleo.integrations.harnesses.memory import MemoryMcp

        self.add("user_message", "fixture-context-marker")
        prepared = self.context().prepare(self.id, self.store.read_events(self.id))
        memory = MemoryMcp(self.store.memory_root, self.store.index_path).for_context(
            prepared.binding
        )
        cwd = self.root / "unrelated 项目 with spaces"
        cwd.mkdir()
        async with Client(
            StdioTransport(
                command=sys.executable, args=memory.context_args, cwd=str(cwd), keep_alive=False
            )
        ) as client:
            self.assertEqual(
                {t.name for t in await client.list_tools()}, {"read_context", "search_context"}
            )
            result = await client.call_tool("search_context", {"query": "fixture-context-marker"})
            self.assertTrue(result.data["results"])
        self.assertEqual(list(cwd.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
