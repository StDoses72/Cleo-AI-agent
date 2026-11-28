"""Workflows and kept node definitions as files: `<root>/<id>.json` and `<root>/roles/<id>.json`."""

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from cleo.workflows.models import Definition, NodeFields, Role, Schema

IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,80}")


class WorkflowStore:
    """Purpose: Keep each workflow in a file of its own, so one can be copied, shared or put
    under version control by itself. A file that cannot be read is left alone and not listed."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def workflows(self) -> list[Definition]:
        """Output: Saved workflows, most recently saved first."""
        found = self._read_all(self.root, Definition)
        return sorted(found, key=lambda item: item.updated_at or "", reverse=True)

    def get(self, workflow_id: str) -> Definition | None:
        return self._read(self._path(self.root, workflow_id), Definition)

    def save(self, definition: Definition) -> Definition:
        """Input: A definition; it needs a name, and need not be able to run yet.
        Output: What was written, stamped with the time."""
        name = definition.name.strip()
        if not name:
            raise ValueError("A workflow needs a name.")
        stamp = datetime.now(UTC).isoformat()
        saved = definition.model_copy(update={"name": name, "updated_at": stamp})
        self._write(self._path(self.root, saved.id), saved)
        return saved

    def remove(self, workflow_id: str) -> None:
        self._path(self.root, workflow_id).unlink(missing_ok=True)

    def roles(self) -> list[Role]:
        return self._read_all(self.root / "roles", Role)

    def save_role(self, role_id: str, fields: NodeFields) -> Role:
        """Saving under a name that is already kept replaces that definition."""
        if not fields.role.strip():
            raise ValueError("A node needs a name.")
        for other in self.roles():
            if other.fields.role == fields.role:
                self.remove_role(other.id)
        role = Role(id=role_id, fields=fields)
        self._write(self._path(self.root / "roles", role.id), role)
        return role

    def remove_role(self, role_id: str) -> None:
        self._path(self.root / "roles", role_id).unlink(missing_ok=True)

    @staticmethod
    def _path(folder: Path, identifier: str) -> Path:
        # The id is a file name, so it is held to the shape the models hold theirs to.
        if not IDENTIFIER.fullmatch(identifier):
            raise ValueError("Not a workflow id.")
        return folder / f"{identifier}.json"

    @staticmethod
    def _read[Kind: Schema](path: Path, kind: type[Kind]) -> Kind | None:
        try:
            return kind.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError):
            return None

    def _read_all[Kind: Schema](self, folder: Path, kind: type[Kind]) -> list[Kind]:
        if not folder.is_dir():
            return []
        items = (self._read(path, kind) for path in sorted(folder.glob("*.json")))
        return [item for item in items if item is not None]

    @staticmethod
    def _write(path: Path, value: Schema) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        draft = path.with_suffix(".json.tmp")
        text = json.dumps(value.model_dump(by_alias=True), ensure_ascii=False, indent=2)
        draft.write_text(text + "\n", encoding="utf-8")
        os.replace(draft, path)
