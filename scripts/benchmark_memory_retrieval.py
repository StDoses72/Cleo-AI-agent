"""Compare raw-log I/O and latency against another checkout using one synthetic fixture.

Prepare once with --prepare, then run this same script with PYTHONPATH pointing at each
checkout. --memory-root must be a disposable task directory; no user data is inspected.
Results include complete pagination and the first page so the old ranking cutoff is visible.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from time import perf_counter

from cleo.memory import compaction
from cleo.memory.reader import MemoryReader
from cleo.sessions import event_log
from cleo.sessions.store import SessionStore


def prepare(root: Path, sessions: int, turns: int) -> None:
    if root.exists():
        raise ValueError("Preparation requires a new disposable directory")
    store = SessionStore(root)
    for number in range(sessions):
        identifier = f"session-{number:04}"
        store.create_session(session_id=identifier, space="productivity", project="benchmark",
                             provider="fixture", owner_type="user")
        events = []
        for turn in range(turns):
            events.extend([
                {"type": "user_message", "actor": "user",
                 "content": ("Needle recovery strongest exact conclusion" if number == sessions - 1
                             else "Needle progress") + f". Investigate step {turn}."},
                {"type": "tool_result", "actor": "tool", "data": {"name": "shell",
                                                                          "status": "success"},
                 "content": "checking dependency and execution state\n" * 240
                            + "Completed successfully; original evidence retained."},
                {"type": "assistant_message", "actor": "assistant",
                 "content": "Validated the operation; continue the saved session after restart."},
            ])
        store.append_events(session_id=identifier, space="productivity", project="benchmark",
                            events=events)
        store.refresh_compact(identifier, materialize=False)


def search(reader: MemoryReader, query: str) -> tuple[list[str], int, int]:
    cursor, first, hits, pages = None, [], 0, 0
    while True:
        page = reader.search_conversation_history(query,
                                                  cursor=cursor, limit=20)
        if page["status"] != "ok":
            raise RuntimeError(f"Benchmark query did not complete: {page}")
        if not pages:
            first = [row["session_id"] for row in page["results"]]
        hits += len(page["results"])
        pages += 1
        cursor = page["next_cursor"]
        if not cursor:
            return first, hits, pages


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", type=Path, required=True)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--sessions", type=int, default=60)
    parser.add_argument("--turns", type=int, default=40)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--label", default="current")
    parser.add_argument("--query", default="recovery strongest exact conclusion")
    args = parser.parse_args()
    if args.prepare:
        prepare(args.memory_root, args.sessions, args.turns)
    reader = MemoryReader(args.memory_root)
    search(reader, args.query)  # Warm derived indexes and revision receipts, as in an active app.
    counts: Counter[str] = Counter()
    original = compaction.load_events

    def observed(path):
        counts[str(path)] += 1
        return original(path)

    compaction.load_events = observed
    event_log.load_events = observed
    samples = []
    for _ in range(args.repeat):
        started = perf_counter()
        first, hits, pages = search(reader, args.query)
        samples.append(perf_counter() - started)
    print(json.dumps({"label": args.label, "module": str(Path(compaction.__file__).resolve()),
                      "sessions": args.sessions, "turns_per_session": args.turns,
                      "query": args.query,
                      "repeated_searches": args.repeat, "full_log_reads": sum(counts.values()),
                      "seconds": samples, "total_seconds": sum(samples),
                      "hits_per_search": hits, "pages_per_search": pages,
                      "first_page_session_ids": first}, indent=2))


if __name__ == "__main__":
    main()
