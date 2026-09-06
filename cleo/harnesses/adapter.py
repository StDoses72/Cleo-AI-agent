"""Backward-compatible entry point that supplies local infrastructure defaults."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from cleo.harnesses.service import AgentService
from cleo.sessions.ports import SessionRepository

if TYPE_CHECKING:
    from cleo.integrations.harnesses.acp import AcpAgentSpec


class AgentAdapter(AgentService):
    """Keep the original constructor and ACP convenience API for existing callers."""

    def __init__(
        self,
        project_root: str | Path,
        *,
        session_store: SessionRepository | None = None,
        space: str = "productivity",
        owner_type: str = "agent",
    ) -> None:
        root = Path(project_root).expanduser().resolve()
        if not root.is_dir():
            raise ValueError(f"Project root does not exist: {root}")
        if session_store is None:
            from cleo.sessions.store import SessionStore

            session_store = SessionStore(root / "memory")
        super().__init__(
            root, session_store=session_store, space=space, owner_type=owner_type,
        )

    def register_acp(self, name: str, spec: AcpAgentSpec) -> None:
        """Construct an ACP provider at the compatibility boundary."""
        from cleo.integrations.harnesses.acp import AcpProvider

        self.register(AcpProvider(name=name, spec=spec))
