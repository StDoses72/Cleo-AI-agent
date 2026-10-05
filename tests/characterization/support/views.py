"""Read-only views over backend output and the on-disk data it owns."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

from .home import CleoHome


def collapse_stream(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reduce a live event stream to its deterministic shape.

    Progress ``timing`` events depend on wall-clock throttling and are dropped; the final
    timing summary stays. Consecutive ``upsert-item`` events for the same item collapse
    into the last one, so token chunking does not leak into snapshots while the final
    content of every item and the order in which items appear are still pinned.
    """
    output: list[dict[str, Any]] = []
    for event in events:
        if event.get("type") == "timing" and event["timing"].get("status") == "running":
            continue
        if (event.get("type") == "upsert-item" and output
                and output[-1].get("type") == "upsert-item"
                and output[-1]["item"].get("id") == event["item"].get("id")):
            output[-1] = event
            continue
        output.append(event)
    return output


def streamed_partial_content(events: list[dict[str, Any]], item_id: str) -> list[str]:
    return [event["item"]["content"] for event in events
            if event.get("type") == "upsert-item" and event["item"].get("id") == item_id]


def session_dir(home: CleoHome, space: str, project: str, session_id: str) -> Path:
    return home.memory / space / "projects" / project / "sessions" / session_id


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def session_files(home: CleoHome, manifest: dict[str, Any]) -> dict[str, Any]:
    directory = session_dir(home, manifest["space"], manifest["project"], manifest["id"])
    files: dict[str, Any] = {
        "files": sorted(path.name for path in directory.iterdir()
                        if not path.name.startswith(".desktop-timeline")),
        "manifest.json": read_json(directory / "manifest.json"),
        "events.jsonl": read_jsonl(directory / "events.jsonl"),
    }
    if (directory / "compact.json").exists():
        compact = read_json(directory / "compact.json")
        compression = compact.get("compression") or {}
        # These totals count characters of raw events, which embed the temp-dir path.
        for key in ("raw_characters", "compact_characters"):
            if key in compression:
                compression[key] = "<path-dependent>"
        files["compact.json"] = compact
    return files


def sqlite_rows(path: Path, query: str, values: tuple = ()) -> list[dict[str, Any]]:
    with closing(sqlite3.connect(path)) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(query, values).fetchall()]


def sqlite_schema(path: Path) -> list[dict[str, Any]]:
    """Tables, columns and indexes: the durable contract of a SQLite file."""
    with closing(sqlite3.connect(path)) as connection:
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name")]
        schema = []
        for table in tables:
            columns = [
                {"name": row[1], "type": row[2], "notnull": bool(row[3]), "pk": row[5]}
                for row in connection.execute(f"PRAGMA table_info('{table}')")
            ]
            indexes = sorted(row[1] for row in connection.execute(f"PRAGMA index_list('{table}')")
                             if not row[1].startswith("sqlite_autoindex"))
            schema.append({"table": table, "columns": columns, "indexes": indexes})
        return schema


def index_rows(home: CleoHome) -> list[dict[str, Any]]:
    return sqlite_rows(home.memory / "sessions.sqlite3",
                       "SELECT * FROM sessions ORDER BY created_at, id")


def runtime_state(home: CleoHome) -> Any:
    path = home.home / "data" / "runtime.json"
    return read_json(path) if path.exists() else None


def memory_state(home: CleoHome, space: str) -> Any:
    path = home.memory / space / "memory_state.json"
    return read_json(path) if path.exists() else None


def tree(root: Path, *, skip: tuple[str, ...] = ()) -> list[str]:
    """Relative file paths under ``root`` (forward slashes), excluding rebuildable caches."""
    if not root.exists():
        return []
    return sorted(
        path.relative_to(root).as_posix() for path in root.rglob("*")
        if path.is_file() and not any(part in path.relative_to(root).as_posix() for part in skip)
    )
