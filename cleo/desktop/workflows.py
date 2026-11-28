"""The workflow library as the desktop serves it: saved workflows, kept node definitions and
what each harness can be held to (ADR 0020)."""

from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

from cleo.desktop.task_harnesses import task_providers
from cleo.workflows.models import Definition, NodeFields
from cleo.workflows.store import WorkflowStore

# A generic ACP harness has approvals and no sandbox: nothing holds a node on it to reading.
_NO_READ_ONLY = {"acp"}
# Harnesses Cleo cannot hand its tools to, so a node on one cannot return a verdict or a list.
_NO_TOOLS = {"antigravity_sdk"}


class WorkflowLibrary:
    """Purpose: Serve and change the user's workflows. Models are not listed here: the desktop
    reads them per harness with ``get_productivity_models``, which can take a while."""

    def __init__(self, root: Path, productivity: Any) -> None:
        self._store = WorkflowStore(root)
        self._productivity = productivity

    def view(self) -> dict[str, Any]:
        return {
            "workflows": [_wire(item) for item in self._store.workflows()],
            "roles": [_wire(item) for item in self._store.roles()],
            "harnesses": [
                {"id": name, "type": provider.type,
                 "readOnly": provider.type not in _NO_READ_ONLY,
                 "tools": provider.type not in _NO_TOOLS}
                for name, provider in task_providers(self._productivity).items()
                if provider.enabled
            ],
        }

    def save(self, definition: dict[str, Any]) -> dict[str, Any]:
        return _wire(self._store.save(Definition.model_validate(definition)))

    def remove(self, workflow_id: str) -> None:
        self._store.remove(workflow_id)

    def save_role(self, fields: dict[str, Any]) -> dict[str, Any]:
        role = self._store.save_role(secrets.token_hex(8), NodeFields.model_validate(fields))
        return _wire(role)

    def remove_role(self, role_id: str) -> None:
        self._store.remove_role(role_id)


def _wire(value: Definition | Any) -> dict[str, Any]:
    return value.model_dump(by_alias=True)
