"""Cleo's built-in LangGraph chat agent as the agent-system member of chat sessions."""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Awaitable, Callable
from typing import Any

from cleo.desktop.agent_system import Emit, TurnInput


class ChatRuntime:
    """Run chat turns with one cached LangGraph agent per thread.

    An agent is rebuilt on its next turn after a configuration reload, and restores its
    history from the event log the first time it runs in this process. Everything a turn
    needs from the desktop service comes in through the constructor.
    """

    def __init__(
        self,
        *,
        store: Any,
        new_agent: Callable[[dict[str, Any]], Any],
        attachment: Callable[[dict[str, Any]], Awaitable[dict[str, str]]],
        sync: Callable[[Any, dict[str, Any], str], Awaitable[None]],
        usage: Callable[[Any], dict[str, int | None]],
        config_version: Callable[[], int | None],
        max_attachments: int,
    ) -> None:
        self._store = store
        self._new_agent = new_agent
        self._attachment = attachment
        self._sync = sync
        self._usage = usage
        self._config_version = config_version
        self._max_attachments = max_attachments
        self.agents: dict[str, Any] = {}
        # Threads whose agent already holds the history loaded from the event log.
        self.restored: set[str] = set()
        self.versions: dict[str, int] = {}

    def forget(self, thread_id: str) -> None:
        """Purpose: Drop a thread's agent; its next turn rebuilds it from the log."""
        self.agents.pop(thread_id, None)
        self.restored.discard(thread_id)

    def forget_all(self) -> None:
        self.agents.clear()
        self.restored.clear()

    async def stream(self, turn: TurnInput, emit: Emit) -> None:
        """Purpose: Run one chat turn and stream the answer.

        Input: The turn and the event sink. Output: None. Emits ``turn-started``, growing
        ``upsert-item`` answers, ``usage`` and ``done``; persists the user message first and
        the LangGraph history at the end, also when the model fails or the run is cancelled.
        """
        manifest, prompt, attachments = turn.manifest, turn.prompt, turn.attachments
        steer_ids, display_prompt = turn.steer_ids, turn.display_prompt
        version = self._config_version()
        if version is not None and self.versions.get(manifest["id"], version) != version:
            self.forget(manifest["id"])
        agent = self.agents.get(manifest["id"])
        if agent is None:
            agent = self._new_agent(manifest)
            self.agents[manifest["id"]] = agent
            if version is not None:
                self.versions[manifest["id"]] = version
        loaded = None
        if manifest["id"] not in self.restored:
            loaded = self._store.load_langchain_messages(manifest["id"])
            self.restored.add(manifest["id"])
        if len(attachments) > self._max_attachments:
            raise ValueError(f"A message can include at most {self._max_attachments} files.")
        chat_attachments = await asyncio.gather(
            *(self._attachment(item) for item in attachments)
        )
        from langchain_core.messages import HumanMessage, message_to_dict

        from cleo.agents.cleo import _build_user_content

        turn_id = f"turn-{secrets.token_hex(12)}"
        user_message = HumanMessage(
            id=turn_id, content=_build_user_content(prompt, chat_attachments),
        )
        await asyncio.to_thread(
            self._store.append_events, session_id=manifest["id"], space=manifest["space"],
            project=manifest["project"], events=[{
                "id": turn_id, "type": "user_message", "actor": "user",
                "content": user_message.content,
                "source_message_id": turn_id, "message": message_to_dict(user_message),
                "data": {**({"steer_ids": steer_ids} if steer_ids else {}),
                         **({"display_prompt": display_prompt} if display_prompt else {})},
            }],
        )
        await emit({"type": "turn-started", "item": {
            "id": turn_id, "turnId": turn_id, "type": "message", "role": "user",
            "content": display_prompt or prompt, "time": "",
        }})
        text = ""
        from cleo.runtime.timing import phase

        phase("模型响应（含工具与等待）")
        try:
            async for chunk in agent.stream_text(
                prompt,
                manifest["id"],
                loaded_info=loaded or None,
                images=chat_attachments,
                message_id=turn_id,
            ):
                text += chunk
                await emit(
                    {
                        "type": "upsert-item",
                        "item": {
                            "id": f"{turn_id}:answer",
                            "turnId": turn_id,
                            "type": "message",
                            "role": "assistant",
                            "content": text,
                            "time": "",
                        },
                    }
                )
        except BaseException as error:
            phase("保存中断回复", previous_status=(
                "cancelled" if isinstance(error, asyncio.CancelledError) else "failed"
            ))
            await self._sync(agent, manifest, "interrupted")
            if isinstance(error, Exception):
                from cleo.integrations.runtime_diagnostics import diagnostic_text

                detail = diagnostic_text(str(error), prompt=prompt) or type(error).__name__
                await asyncio.to_thread(
                    self._store.append_event, session_id=manifest["id"],
                    space=manifest["space"], project=manifest["project"], event_type="error",
                    actor="system", content=detail,
                )
            phase(None)
            raise
        else:
            phase("保存回复与会话状态")
            await self._sync(agent, manifest, "completed")
        usage = agent.context_usage
        await emit({"type": "usage", "usage": self._usage(usage)})
        await emit({"type": "done", "summary": (text or prompt)[:80]})
