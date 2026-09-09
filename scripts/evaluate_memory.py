"""Run frozen memory cases through the production DreamAgent in disposable storage.

No rubric is sent to the model. Outputs require human semantic scoring; structural
checks alone never produce a semantic pass. Only synthetic fixtures are supported.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def evaluate(args):
    from cleo.agents import dream as dream_module
    from cleo.agents.profiles import dream_profile
    from cleo.config.settings import SettingsModel
    from cleo.memory.reader import MemoryReader
    from cleo.memory.repository import MemoryRepository
    from cleo.sessions.store import SessionStore

    settings_module = importlib.import_module("cleo.config.settings")
    original = settings_module.settings
    original_dream = dream_module.settings
    profile = dream_profile(original, {})
    corpus = json.loads(args.fixtures.read_text(encoding="utf-8"))
    cases = [c for c in corpus["cases"] if not args.cases or c["id"] in args.cases.split(",")]
    if not cases:
        raise ValueError("no matching cases")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "model": profile.model,
        "provider": profile.provider,
        "backend": profile.backend,
        "semantic_status": "unreviewed",
        "fixture_sha256": hashlib.sha256(args.fixtures.read_bytes()).hexdigest(),
        "prompt_sha256": hashlib.sha256(
            dream_module.DREAM_AGENT_SYSTEM_PROMPT.encode()
        ).hexdigest(),
        "temperature": profile.temperature,
        "results": [],
    }
    try:
        with tempfile.TemporaryDirectory(
            prefix="memory-eval-", dir=args.output.parent
        ) as directory:
            for repetition in range(args.repeat):
                for case in cases:
                    root = Path(directory) / f"{case['id']}-{repetition}"
                    config = SettingsModel.model_validate(
                        {
                            "active_profiles": {"agent": "eval", "dream_agent": "eval"},
                            "profiles": {
                                "agents": {"eval": profile.model_dump()},
                                "directories": {"default": {"root_dir": str(root)}},
                            },
                        }
                    )
                    settings_module.settings = dream_module.settings = config
                    store = SessionStore(config.MEMORY_DIR, config.SESSION_INDEX_PATH)
                    repository = MemoryRepository(config.MEMORY_DIR)
                    first_scope = case["rounds"][0]["scope"]
                    path = repository.path(first_scope["space"], first_scope["project"])
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if case["initial_memory"]:
                        path.write_text(case["initial_memory"], encoding="utf-8")
                    session_id = f"eval-{case['id']}"
                    store.create_session(
                        session_id=session_id,
                        space=first_scope["space"],
                        project=first_scope["project"],
                        provider="cleo",
                        owner_type="user",
                    )
                    store.update_manifest(session_id, title=first_scope["work_item"])
                    for number, turn in enumerate(case["rounds"], 1):
                        scope = turn["scope"]
                        if (scope["space"], scope["project"]) != (
                            first_scope["space"],
                            first_scope["project"],
                        ):
                            raise ValueError("one case must use one storage scope")
                        for message in turn["messages"]:
                            kind = {
                                "user": "user_message",
                                "assistant": "assistant_message",
                                "tool": "tool_result",
                            }[message["role"]]
                            store.append_event(
                                session_id=session_id,
                                space=scope["space"],
                                project=scope["project"],
                                event_id=message["id"],
                                event_type=kind,
                                actor=message["role"],
                                content=message["content"],
                            )
                        store.refresh_compact(session_id)
                        before = repository.read(scope["space"], scope["project"])
                        started = time.monotonic()
                        try:
                            outcome = await dream_module.DreamAgent().invoke(
                                session_id,
                                scope["project"],
                                scope["space"],
                                force=turn["refresh_snapshot"],
                            )
                        except Exception as exc:
                            outcome = {"status": "error", "error": str(exc)}
                        after = repository.read(scope["space"], scope["project"])
                        item = {
                            "case": case["id"],
                            "round": number,
                            "repetition": repetition + 1,
                            "outcome": outcome,
                            "seconds": round(time.monotonic() - started, 2),
                            "before": before,
                            "after": after,
                            "characters": len(after),
                            "change_matches": (before != after)
                            == (turn["expectations"]["change"] == "changed"),
                            "readable": MemoryReader(config.MEMORY_DIR).search_long_term_memory(
                                space=scope["space"], project=scope["project"]
                            ),
                            "history": repository.history(scope["space"], scope["project"]),
                            "expectations": turn["expectations"],
                            "semantic_status": "unreviewed",
                        }
                        report["results"].append(item)
                        args.output.write_text(
                            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
                        )
                        print(
                            f"{case['id']}.{number} #{repetition + 1}: {outcome['status']}, "
                            f"{len(after)} chars, {item['seconds']}s",
                            flush=True,
                        )
                        if outcome["status"] == "error":
                            break
    finally:
        settings_module.settings = original
        dream_module.settings = original_dream


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "tests/fixtures/memory_rewrite/scenarios.json",
    )
    parser.add_argument("--cases", default="")
    parser.add_argument("--repeat", type=int, choices=range(1, 11), default=1)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="JSON report path in the task temporary directory",
    )
    asyncio.run(evaluate(parser.parse_args()))
