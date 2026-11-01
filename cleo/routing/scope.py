"""Host-bound parent identity for API tools and process-local harness MCP tools."""

import hashlib
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from cleo.routing.catalog import atomic_json


@dataclass(frozen=True)
class DelegationScope:
    parent_session_id: str
    project_path: Path


current_scope: ContextVar[DelegationScope | None] = ContextVar(
    "cleo_delegation_scope", default=None
)


@contextmanager
def delegation_scope(parent_session_id: str, project_path: Path):
    """Purpose: Bind tools to the coordinator. Input: host identity. Output: context."""
    token = current_scope.set(DelegationScope(parent_session_id, Path(project_path).resolve()))
    try:
        yield
    finally:
        current_scope.reset(token)


def parent_binding_path(memory_root: Path, key: str):
    """Purpose: Avoid model-controlled filenames. Input: opaque launch key. Output: local path."""
    if not re.fullmatch(r"[0-9a-f]{32}", key):
        raise ValueError("Invalid process binding")
    return (
        Path(memory_root)
        / ".routing"
        / "parents"
        / (hashlib.sha256(key.encode()).hexdigest() + ".json")
    )


def bind_parent(store, provider, provider_session_id, session_id):
    """Purpose: Bind MCP after session creation. Input: host route. Output: local file."""
    method = getattr(provider, "delegation_parent_key", None)
    if callable(method) and hasattr(store, "memory_root"):
        key = method(provider_session_id)
        if key:
            atomic_json(parent_binding_path(store.memory_root, key), {"session_id": session_id})
