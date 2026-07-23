"""Merge Cleo-managed sessions with browse-only native harness history."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core.integrations.agent_adapter.control import NativeSession


def merge_session_rows(
    managed: list[dict[str, Any]],
    native: tuple[NativeSession, ...] = (),
    *,
    provider: str = "codex",
) -> list[dict[str, Any]]:
    linked = {
        str(row.get("native_session_id")): row
        for row in managed
        if row.get("provider") == provider and row.get("native_session_id")
    }
    rows: list[dict[str, Any]] = []
    for row in managed:
        merged = dict(row)
        merged["origin"] = (
            "cleo+native"
            if str(row.get("native_session_id") or "") in linked
            else "cleo"
        )
        rows.append(merged)

    for thread in native:
        managed_row = linked.get(thread.id)
        if managed_row is not None:
            for row in rows:
                if row.get("id") == managed_row.get("id"):
                    row["status"] = thread.status
                    row["updated_at"] = thread.updated_at
                    row["title"] = thread.name or thread.preview
                    row["source"] = thread.source
                    break
            continue
        rows.append(
            {
                "id": thread.id,
                "native_session_id": thread.id,
                "space": "productivity",
                "project": Path(thread.cwd).name or "external",
                "provider": provider,
                "status": thread.status,
                "cwd": thread.cwd,
                "created_at": thread.created_at,
                "updated_at": thread.updated_at,
                "origin": "native",
                "title": thread.name or thread.preview,
                "source": thread.source,
            }
        )
    return sorted(rows, key=lambda row: str(row.get("updated_at") or ""), reverse=True)
