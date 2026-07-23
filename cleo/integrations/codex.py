from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from cleo.harnesses import AgentAdapter, AgentResult
from cleo.integrations.harnesses.codex import CodexProvider


class CodexResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    thread_id: str
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None


class CodexAdapter:
    """Backward-compatible Codex facade backed by the unified agent adapter."""

    def __init__(self, default_model: str, project_root: str | Path) -> None:
        self._adapter = AgentAdapter(project_root)
        self._adapter.register(CodexProvider(default_model=default_model))
        self._handles: dict[str, str] = {}

    async def start(
        self,
        prompt: str,
        project_path: str,
        model: str | None = None,
    ) -> CodexResult:
        result = await self._adapter.run(
            provider="codex",
            prompt=prompt,
            project_path=project_path,
            model=model,
        )
        return self._result(result)

    async def reply(
        self,
        thread_id: str,
        prompt: str,
        project_path: str,
    ) -> CodexResult:
        handle = self._handles.get(thread_id)
        if handle is None:
            session = await self._adapter.resume_session(
                provider="codex",
                native_session_id=thread_id,
                project_path=project_path,
            )
            handle = session.id
            self._handles[thread_id] = handle
        return self._result(await self._adapter.prompt(handle, prompt))

    async def close(self) -> None:
        await self._adapter.aclose()

    def _result(self, result: AgentResult) -> CodexResult:
        thread_id = result.native_session_id or result.session_id
        self._handles[thread_id] = result.session_id
        return CodexResult(
            thread_id=thread_id,
            turn_id=result.turn_id,
            status=result.status,
            response=result.response,
            error=result.error,
        )
