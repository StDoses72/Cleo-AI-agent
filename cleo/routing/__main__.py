"""Operator CLI: inspect routing, refresh benchmarks or import an offline snapshot."""

import argparse
import asyncio
import json
from pathlib import Path

from cleo.routing.benchmarks import BenchmarkCache
from cleo.routing.execution import create_service
from cleo.routing.models import load_policy


async def run(args):
    """Purpose: Run an explicit operator action. Input: CLI arguments. Output: public JSON."""
    from cleo.config.settings import current_settings

    settings = current_settings()
    policy = load_policy(Path(settings.PROFILE_DIR).parent / "routing.json")
    state = Path(settings.MEMORY_DIR) / ".routing"
    cache = BenchmarkCache(state / "benchmarks.json", policy)
    if args.command == "benchmark-status":
        return cache.read().model_dump(mode="json")
    if args.command == "benchmark-refresh":
        return (await cache.refresh()).model_dump(mode="json")
    if args.command == "benchmark-import":
        return cache.import_snapshot(Path(args.snapshot)).model_dump(mode="json")
    if not args.parent:
        raise ValueError("--parent must identify the coordinating session")
    service = create_service(args.parent)
    try:
        if args.command == "candidates":
            root = service._project(".")
            return {
                "candidates": [
                    item.model_dump(mode="json")
                    for item in await service.catalog.list(str(root), refresh=args.refresh)
                ]
            }
        assessment = json.loads(Path(args.assessment).read_text(encoding="utf-8"))
        return (await service.preview(assessment)).model_dump(mode="json")
    finally:
        await service.adapter.aclose()


def main():
    """Purpose: Provide a local, reviewable management surface. Input: argv. Output: JSON/stdout."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", help="Cleo parent session ID (required for candidates/preview)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("benchmark-status")
    commands.add_parser("benchmark-refresh")
    commands.add_parser("benchmark-import").add_argument("snapshot")
    commands.add_parser("candidates").add_argument("--refresh", action="store_true")
    commands.add_parser("preview").add_argument("assessment")
    args = parser.parse_args()
    try:
        result = asyncio.run(run(args))
    except (ValueError, KeyError, OSError):
        parser.exit(2, "Invalid routing configuration, local input or parent session.\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
