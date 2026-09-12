"""Provider-neutral, explicitly answered questions; independent of permission policy."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Any

from cleo.harnesses.models import AgentEvent, EventCallback, emit_event


def normalize_questions(raw: Any, *, claude: bool = False) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= 12:
        raise ValueError("提问需要包含 1 至 12 个问题。")
    questions = []
    ids = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not isinstance(item.get("question"), str):
            raise ValueError("问题格式无效。")
        identifier = str(index) if claude else str(item.get("id") or index)
        if identifier in ids or not item["question"].strip() or len(item["question"]) > 16000:
            raise ValueError("问题标识重复或正文无效。")
        ids.add(identifier)
        options = item.get("options") or []
        if (
            not isinstance(options, list)
            or len(options) > 16
            or any(
                not isinstance(option, dict)
                or not isinstance(option.get("label"), str)
                or not option["label"].strip()
                or len(option["label"]) > 500
                or len(str(option.get("description") or "")) > 4000
                for option in options
            )
        ):
            raise ValueError("问题选项格式无效。")
        questions.append(
            {
                "id": identifier,
                "question": item["question"],
                "header": str(item.get("header") or ""),
                "multiple": bool(item.get("multiSelect")) if claude else False,
                "secret": bool(item.get("isSecret")),
                "options": [
                    {"label": o["label"], "description": str(o.get("description") or "")}
                    for o in options
                ],
            }
        )
    if len(json.dumps(questions, ensure_ascii=False).encode()) > 256 * 1024:
        raise ValueError("提问内容过长，请拆分后重新询问。")
    return questions


class QuestionBroker:
    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.enabled = False
        self.callback: EventCallback | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.pending: dict[str, tuple[dict, asyncio.Future]] = {}
        self.receipts: dict[str, dict] = {}
        self.submitting: set[str] = set()
        self.transport_alive = None

    def bind(self, callback: EventCallback | None) -> None:
        self.loop = asyncio.get_running_loop()
        self.callback = callback
        self.receipts.clear()

    def list_pending(self) -> list[dict]:
        return [request for request, future in self.pending.values() if not future.done()]

    async def _emit(self, kind: str, value: dict) -> None:
        if kind == "question_response" and value.get("answers"):
            pending = self.pending.get(value["id"])
            secret = {q["id"] for q in pending[0]["questions"] if q["secret"]} if pending else set()
            value = {
                **value,
                "answers": {
                    key: ["（已隐藏）"] if key in secret else answer
                    for key, answer in value["answers"].items()
                },
            }
        await emit_event(self.callback, AgentEvent(provider=self.provider, type=kind, data=value))

    async def ask(self, questions: list[dict], *, native_id: str = "") -> dict | None:
        request = {
            "id": f"question-{secrets.token_hex(12)}",
            "provider": self.provider,
            "nativeId": native_id,
            "questions": questions,
            "status": "pending",
        }
        if self.callback is None:
            return None
        future = asyncio.get_running_loop().create_future()
        self.pending[request["id"]] = (request, future)
        try:
            await self._emit("question_request", request)
            while not future.done() and self.transport_alive is not None:
                if not self.transport_alive():
                    await self.cancel_all(status="unavailable")
                    break
                await asyncio.wait({future}, timeout=0.25)
            return await future
        except asyncio.CancelledError:
            await self._emit("question_response", {"id": request["id"], "status": "unavailable"})
            raise
        finally:
            self.pending.pop(request["id"], None)

    def ask_sync(self, questions: list[dict], *, native_id: str = "") -> dict | None:
        if self.loop is None or self.callback is None or self.loop.is_closed():
            return None
        return asyncio.run_coroutine_threadsafe(
            self.ask(questions, native_id=native_id),
            self.loop,
        ).result()

    async def resolve(self, identifier: str, answers: dict[str, list[str]]) -> dict:
        if identifier in self.submitting:
            raise ValueError("答案正在提交，请勿重复提交。")
        receipt = self.receipts.get(identifier)
        if receipt is not None:
            if receipt["answers"] != answers:
                raise ValueError("此问题已提交其他答案。")
            return receipt
        pending = self.pending.get(identifier)
        if pending is None or pending[1].done():
            raise ValueError("问题已结束或连接已失效，请让 Agent 重新提问。")
        request, future = pending
        if not isinstance(answers, dict) or set(answers) != {q["id"] for q in request["questions"]}:
            raise ValueError("请回答每一个问题。")
        for question in request["questions"]:
            values = answers[question["id"]]
            if (
                not isinstance(values, list)
                or not values
                or len(values) > 30
                or (not question["multiple"] and len(values) != 1)
                or any(not isinstance(v, str) or not v.strip() or len(v) > 16000 for v in values)
            ):
                raise ValueError("答案格式无效，请检查选择或输入的文字。")
        if sum(len(value) for values in answers.values() for value in values) > 65536:
            raise ValueError("答案总长度不能超过 65,536 字符。")
        receipt = {"id": identifier, "status": "answered", "answers": answers}
        # Persist/display the answer before releasing the waiting agent. Failure remains retryable.
        self.submitting.add(identifier)
        try:
            await self._emit("question_response", receipt)
            if future.done():
                raise ValueError("提交时问题已取消，请查看任务状态。")
            self.receipts[identifier] = receipt
            future.set_result(answers)
        finally:
            self.submitting.discard(identifier)
        return receipt

    async def cancel_all(self, *, status: str = "cancelled") -> None:
        for identifier, (_, future) in list(self.pending.items()):
            if not future.done():
                try:
                    await self._emit("question_response", {"id": identifier, "status": status})
                except Exception:
                    logging.getLogger(__name__).warning(
                        "Question cancellation could not be recorded"
                    )
                finally:
                    if not future.done():
                        future.set_result(None)
