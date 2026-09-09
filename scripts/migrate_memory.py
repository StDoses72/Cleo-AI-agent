"""Preview legacy project memory from original sessions, or apply a reviewed Markdown file.

Preview never writes to the source directory. Applying is a separate explicit action,
requires the original memory hash, and preserves the previous file in local Git history.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def preview(args):
    from cleo.agents import dream as dream_module
    from cleo.agents.profiles import dream_profile
    from cleo.config.settings import SettingsModel
    from cleo.memory.compaction import load_events
    from cleo.memory.markdown import parse_memory
    from cleo.memory.repository import MemoryRepository, digest
    from cleo.sessions.store import SessionStore

    settings_module = importlib.import_module("cleo.config.settings")
    source = MemoryRepository(args.source_root)
    before = source.read(args.space, args.project)
    if args.apply_reviewed:
        if not args.expected_hash or args.expected_hash != digest(before):
            raise ValueError("source memory changed or --expected-hash was not supplied")
        candidate = args.apply_reviewed.read_text(encoding="utf-8")
        parse_memory(candidate)
        print(
            source.publish(
                args.space, args.project, before, candidate, "Apply reviewed preference migration"
            )
        )
        return
    if not args.output:
        raise ValueError("preview requires --output")
    output = args.output.resolve()
    if output.is_relative_to(source.root):
        raise ValueError("preview output must be outside the source memory directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    originals = settings_module.settings, dream_module.settings
    profile = dream_profile(originals[0], {})
    sessions = source.path(args.space, args.project).parent / "sessions"
    manifests = [
        json.loads(p.read_text(encoding="utf-8")) for p in sessions.glob("*/manifest.json")
    ]
    manifests = [m for m in manifests if not args.sessions or m["id"] in args.sessions.split(",")]
    manifests.sort(key=lambda m: (m["updated_at"], m["id"]))
    if not manifests:
        raise ValueError("no source sessions selected")
    source_hashes = {}
    try:
        with tempfile.TemporaryDirectory(
            prefix="memory-migration-", dir=output.parent
        ) as directory:
            config = SettingsModel.model_validate(
                {
                    "active_profiles": {"agent": "migration", "dream_agent": "migration"},
                    "profiles": {
                        "agents": {"migration": profile.model_dump()},
                        "directories": {"default": {"root_dir": directory}},
                    },
                }
            )
            settings_module.settings = dream_module.settings = config
            store = SessionStore(config.MEMORY_DIR, config.SESSION_INDEX_PATH)
            target = MemoryRepository(config.MEMORY_DIR)
            for manifest in manifests:
                session_id = manifest["id"]
                path = sessions / session_id / "events.jsonl"
                source_hashes[path] = digest(path.read_text(encoding="utf-8"))
                events = load_events(path)
                store.create_session(
                    session_id=session_id,
                    space=args.space,
                    project=args.project,
                    provider="cleo",
                    owner_type="user",
                )
                store.append_events(
                    session_id=session_id,
                    space=args.space,
                    project=args.project,
                    events=[e for e in events if e["type"] != "session_created"],
                )
                store.update_manifest(session_id, title=manifest.get("title", session_id))
                store.refresh_compact(session_id)
                result = await dream_module.DreamAgent().invoke(
                    session_id, args.project, args.space
                )
                if result["status"] != "complete":
                    raise ValueError(f"migration needs review: {result}")
                print(f"{session_id}: preference preview updated", flush=True)
            candidate = target.read(args.space, args.project)
            parse_memory(candidate)
            if source.read(args.space, args.project) != before:
                raise ValueError("source memory changed during preview")
            for path, expected in source_hashes.items():
                if digest(path.read_text(encoding="utf-8")) != expected:
                    raise ValueError("source events changed during preview")
            output.write_text(candidate, encoding="utf-8")
            print(f"Preview: {output}\nOriginal memory hash: {digest(before)}")
    finally:
        settings_module.settings, dream_module.settings = originals


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--space", choices=["productivity", "non_productivity"], required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--sessions", default="")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--apply-reviewed", type=Path)
    parser.add_argument("--expected-hash")
    asyncio.run(preview(parser.parse_args()))
