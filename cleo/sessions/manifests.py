"""Session manifests: one ``manifest.json`` per session directory."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cleo.memory.paths import MEMORY_SPACES, manifest_path, validate_name, validate_space
from cleo.sessions.files import atomic_write_json

MANIFEST_SCHEMA_VERSION = 1


class JsonManifestRepository:
    """Read, validate and atomically replace session manifests under ``memory_root``."""

    def __init__(self, memory_root: Path) -> None:
        self.memory_root = memory_root

    def path(self, space: str, project: str, session_id: str) -> Path:
        return manifest_path(self.memory_root, space, project, session_id)

    @staticmethod
    def read_raw(path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8-sig"))

    def read(self, path: Path, session_id: str) -> dict[str, Any]:
        """Purpose: Load a manifest. Unreadable files raise FileNotFoundError(session_id)."""
        try:
            manifest = self.read_raw(path)
        except (OSError, json.JSONDecodeError) as exc:
            raise FileNotFoundError(session_id) from exc
        self.validate(manifest)
        return manifest

    @staticmethod
    def write(path: Path, manifest: dict[str, Any]) -> None:
        atomic_write_json(path, manifest)

    def scan(self) -> list[tuple[dict[str, Any], Path]]:
        """Purpose: Return every valid manifest on disk with its path; skip broken ones."""
        manifests: list[tuple[dict[str, Any], Path]] = []
        for space in MEMORY_SPACES:
            pattern = f"{space}/projects/*/sessions/*/manifest.json"
            for path in self.memory_root.glob(pattern):
                try:
                    manifest = self.read_raw(path)
                    self.validate(manifest)
                except (OSError, json.JSONDecodeError, ValueError):
                    continue
                manifests.append((manifest, path))
        return manifests

    @staticmethod
    def validate(manifest: dict[str, Any]) -> None:
        if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
            raise ValueError("session manifest schema is not supported")
        validate_space(str(manifest.get("space") or ""))
        validate_name(str(manifest.get("project") or ""), "project")
        validate_name(str(manifest.get("id") or ""), "session_id")
        validate_name(str(manifest.get("provider") or ""), "provider")
        validate_name(str(manifest.get("owner_type") or ""), "owner_type")
