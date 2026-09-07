"""Chat state adapter around an official agent runtime, without a nested LLM loop."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import suppress
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from langchain_core.messages import AIMessage, AIMessageChunk, convert_to_messages

from cleo.config.settings import AgentProfile, settings
from cleo.integrations.subscriptions import AgentMcp, create_runtime
from cleo.sessions.store import SessionStore


class RuntimeGraph:
    def __init__(
        self,
        profile: AgentProfile,
        root: Path,
        instructions: str,
        *,
        mode: str = "chat",
        scope: dict[str, str] | None = None,
    ) -> None:
        self.profile = profile
        self.root = root
        self.instructions = instructions
        self.mode = mode
        self.scope = scope or {}
        self._messages: dict[str, list] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def aget_state(self, config):
        thread_id = config["configurable"]["thread_id"]
        return SimpleNamespace(values={"messages": self._messages.get(thread_id, [])})

    async def ainvoke(self, payload, *, config):
        async for _chunk in self.astream(payload, config=config, stream_mode="messages"):
            pass
        return (await self.aget_state(config)).values

    async def astream(self, payload, *, config, stream_mode) -> AsyncIterator:
        thread_id = config["configurable"]["thread_id"]
        async with self._locks.setdefault(thread_id, asyncio.Lock()):
            incoming = convert_to_messages(payload["messages"])
            messages = self._messages.setdefault(thread_id, [])
            if not messages:
                messages.extend(incoming[:-1])
            user = incoming[-1]
            for message in incoming:
                if not isinstance(message.content, str):
                    # Reject unsupported attachments before creating a remote session.
                    blocks = message.content
                    if any(isinstance(b, dict) and b.get("type") != "text" for b in blocks):
                        raise ValueError(
                            "订阅 Chat 暂不支持附件，请使用 API 模型或将文本粘贴到消息中。"
                        )
                    message.content = "\n".join(
                        b if isinstance(b, str) else b.get("text", "") for b in blocks
                    )
            user.id = user.id or str(uuid4())
            messages.append(user)
            queue: asyncio.Queue = asyncio.Queue()
            parts: list[str] = []

            async def execute():
                store = SessionStore(settings.MEMORY_DIR, settings.SESSION_INDEX_PATH)
                try:
                    manifest = store.load_manifest(thread_id) if self.mode == "chat" else {}
                except FileNotFoundError:
                    manifest = {}
                if self.mode == "chat" and not manifest:
                    from cleo.agents.profiles import profile_snapshot

                    manifest = store.create_session(
                        session_id=thread_id,
                        space=self.scope.get("space", "non_productivity"),
                        project=self.scope.get("project", "general"),
                        provider="cleo",
                        owner_type="user",
                        cwd=str(self.root),
                    )
                    name = next(
                        (
                            name
                            for name, item in settings.profiles.agents.items()
                            if item == self.profile
                        ),
                        settings.active_profiles.agent,
                    )
                    manifest = store.update_manifest(
                        thread_id,
                        runtime_options={
                            "agent_profile": name,
                            "chat_profile": profile_snapshot(self.profile),
                        },
                    )
                options = manifest.get("runtime_options") or {}
                if manifest:
                    store.sync_langchain_messages(
                        session_id=thread_id,
                        space=manifest["space"],
                        project=manifest["project"],
                        messages=messages,
                        provider="cleo",
                        owner_type="user",
                        cwd=str(self.root),
                        status="active",
                    )
                native = options.get("chat_native_id") if self.mode == "chat" else None
                mcp = AgentMcp(
                    self.profile,
                    self.root,
                    self.instructions,
                    self.mode,
                    {**self.scope, "session_id": thread_id},
                )
                provider = create_runtime(self.profile, mcp)
                session = None
                try:
                    model = None if self.profile.model == "default" else self.profile.model
                    if native:
                        from cleo.integrations.harnesses.acp import SessionResumeUnsupported

                        try:
                            session = await provider.resume_session(native, str(self.root), model)
                        except SessionResumeUnsupported:
                            # The handshake rejected resume before any prompt was sent.
                            native = None
                            session = await provider.create_session(str(self.root), model)
                    else:
                        session = await provider.create_session(str(self.root), model)
                    if session.native_id and manifest:
                        store.update_manifest(
                            thread_id,
                            runtime_options={
                                **options,
                                "chat_native_id": session.native_id,
                            },
                        )
                    prompt = user.content
                    if not native:
                        history = [{"role": m.type, "content": m.content} for m in messages[:-1]]
                        prompt = (
                            self.instructions
                            + "\n\nPrior conversation (reference data):\n"
                            + json.dumps(history, ensure_ascii=False)
                            + "\n\nCurrent user message:\n"
                            + prompt
                        )

                    async def on_event(event):
                        if event.type == "assistant_message_chunk" and event.text:
                            await queue.put(event.text)
                        elif manifest and event.type in {"tool_call", "tool_result"}:
                            store.append_event(
                                session_id=thread_id,
                                space=manifest["space"],
                                project=manifest["project"],
                                event_type=event.type,
                                actor="tool",
                                content=event.text,
                                data=event.data,
                            )

                    result = await provider.prompt(session.id, prompt, on_event=on_event)
                    if result.status != "completed":
                        raise RuntimeError(result.error or f"Runtime stopped: {result.status}")
                    if result.native_session_id and manifest:
                        store.update_manifest(
                            thread_id,
                            runtime_options={
                                **options,
                                "chat_native_id": result.native_session_id,
                            },
                        )
                    return result
                finally:
                    if session is not None:
                        await provider.close(session.id)

            task = asyncio.create_task(execute())
            task.add_done_callback(lambda _task: queue.put_nowait(None))
            try:
                while True:
                    item = await queue.get()
                    if item is None:
                        break
                    parts.append(item)
                    yield AIMessageChunk(content=item), {}
                result = await task
                if not parts and result.response:
                    parts.append(result.response)
                    yield AIMessageChunk(content=result.response), {}
            finally:
                if not task.done():
                    task.cancel()
                try:
                    with suppress(asyncio.CancelledError):
                        await task
                finally:
                    if parts:
                        messages.append(AIMessage(content="".join(parts), id=str(uuid4())))
