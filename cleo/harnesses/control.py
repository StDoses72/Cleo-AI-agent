"""Optional rich-control models for harnesses that expose more than chat turns."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class HarnessModel:
    id: str
    display_name: str
    description: str
    is_default: bool
    default_effort: str | None
    supported_efforts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SessionOptions:
    model: str | None = None
    effort: str | None = None
    approval_mode: str | None = None
    sandbox: str | None = None

    def as_dict(self) -> dict[str, str | None]:
        return {
            "model": self.model,
            "effort": self.effort,
            "approval_mode": self.approval_mode,
            "sandbox": self.sandbox,
        }


@dataclass(frozen=True, slots=True)
class NativeSession:
    id: str
    name: str | None
    preview: str
    cwd: str
    status: str
    source: str
    model_provider: str
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class NativeSessionPage:
    sessions: tuple[NativeSession, ...]
    next_cursor: str | None = None


@dataclass(frozen=True, slots=True)
class NativeSessionDetail:
    session: NativeSession
    turns: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class HarnessAccount:
    authenticated: bool
    account_type: str | None = None
    email: str | None = None
    plan: str | None = None
