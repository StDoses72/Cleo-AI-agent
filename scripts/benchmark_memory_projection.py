"""Compare full tool bodies with bounded projection on synthetic, file-free evidence.

Run from the repository root: python -m scripts.benchmark_memory_projection
The baseline uses the same block packer with the original full tool body restored.
No model calls, user configuration, session files or native harness homes are accessed.
"""

import json
import statistics
import time

from cleo.memory.dream_projection import build_blocks, project_events, token_count


def benchmark() -> dict:
    output = ("checking unchanged dependency\n" * 3000
              + "ERROR: connection failed\nCancelled: retry after reconnect\n"
              + "checking unchanged dependency\n" * 3000
              + "Recovered: resumed successfully\n312 tests passed\n")
    events = [
        {"id": "u1", "seq": 1, "type": "user_message",
         "content": "Always preserve original files."},
        {"id": "t1", "seq": 2, "type": "tool_result", "content": output},
    ]
    original = json.dumps(events)
    token_count("Warm the tokenizer before both measurements.")
    times = {"full_body_pack_ms": [], "bounded_projection_and_pack_ms": []}
    for _ in range(5):
        records = project_events(events)
        records[-1].body = {"content": output}
        start = time.perf_counter()
        full = build_blocks(records)
        times["full_body_pack_ms"].append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        bounded = build_blocks(project_events(events))
        times["bounded_projection_and_pack_ms"].append((time.perf_counter() - start) * 1000)
    before, after = ("\n".join(block.text for block in blocks) for blocks in (full, bounded))
    assert json.dumps(events) == original
    assert all(value in after for value in (
        "Always preserve original files.", "connection failed", "Cancelled", "Recovered",
        "312 tests passed", "omitted content",
    ))
    return {
        "source_bytes": len(output.encode()),
        "full_body": {"bytes": len(before.encode()), "tokens": token_count(before),
                      "blocks": len(full)},
        "bounded": {"bytes": len(after.encode()), "tokens": token_count(after),
                    "blocks": len(bounded)},
        "median_ms": {key: round(statistics.median(values), 2) for key, values in times.items()},
        "samples": 5, "raw_events_unchanged": True, "outcome_lines_retained": True,
    }


if __name__ == "__main__":
    print(json.dumps(benchmark(), indent=2))
