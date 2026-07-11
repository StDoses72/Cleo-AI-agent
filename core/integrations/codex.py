from __future__ import annotations

import os
from pathlib import Path

from openai_codex import ApprovalMode, Codex, Sandbox, TurnResult
from pydantic import BaseModel, ConfigDict


class CodexResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    thread_id: str
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None


class CodexAdapter:
    """Synchronous application boundary around the Codex SDK."""

    def __init__(self, default_model: str, project_root: str | Path) -> None:
        self._default_model = self._required_text(default_model, "default_model")
        self._project_root = Path(project_root).expanduser().resolve()
        if not self._project_root.is_dir():
            raise ValueError(f"Project root does not exist: {self._project_root}")

    def start(
        self,
        prompt: str,
        project_path: str,
        model: str | None = None,
    ) -> CodexResult:
        prompt = self._required_text(prompt, "prompt")
        project_path = self._project_directory(project_path)
        model = self._required_text(model or self._default_model, "model")

        with Codex() as client:
            thread = client.thread_start(
                approval_mode=ApprovalMode.deny_all,
                cwd=project_path,
                model=model,
                sandbox=Sandbox.workspace_write,
            )
            result = thread.run(
                prompt,
                approval_mode=ApprovalMode.deny_all,
                cwd=project_path,
                sandbox=Sandbox.workspace_write,
            )

        return self._result(thread.id, result)

    def reply(
        self,
        thread_id: str,
        prompt: str,
        project_path: str,
    ) -> CodexResult:
        thread_id = self._required_text(thread_id, "thread_id")
        prompt = self._required_text(prompt, "prompt")
        project_path = self._project_directory(project_path)

        with Codex() as client:
            thread = client.thread_resume(
                thread_id,
                approval_mode=ApprovalMode.deny_all,
                cwd=project_path,
                sandbox=Sandbox.workspace_write,
            )
            result = thread.run(
                prompt,
                approval_mode=ApprovalMode.deny_all,
                cwd=project_path,
                sandbox=Sandbox.workspace_write,
            )

        return self._result(thread.id, result)

    @staticmethod
    def _required_text(value: str, field_name: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError(f"{field_name} cannot be empty")
        return value

    def _project_directory(self, project_path: str) -> str:
        raw_path = self._required_text(project_path, "project_path")
        expanded_path = os.path.expanduser(raw_path)
        drive, _ = os.path.splitdrive(expanded_path)

        if os.name == "nt" and expanded_path.startswith(("/", "\\")) and not drive:
            path = self._project_root / expanded_path.lstrip("/\\")
        else:
            path = Path(expanded_path)
            if not path.is_absolute():
                path = self._project_root / path

        path = path.resolve()
        if not path.is_dir():
            raise ValueError(f"Project directory does not exist: {path}")
        return os.path.normcase(str(path))

    @staticmethod
    def _result(thread_id: str, result: TurnResult) -> CodexResult:
        return CodexResult(
            thread_id=thread_id,
            turn_id=result.id,
            status=result.status.value,
            response=result.final_response,
            error=result.error.message if result.error is not None else None,
        )
