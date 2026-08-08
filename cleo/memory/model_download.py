"""Installer-facing command for prefetching Cleo's local memory-gate model."""

from __future__ import annotations

import argparse
import json

from cleo.memory.gate import DEFAULT_MEMORY_GATE_MODEL, prefetch_memory_gate_model


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download and warm up Cleo's Sentence Transformer memory gate model."
    )
    parser.add_argument("--model", default=DEFAULT_MEMORY_GATE_MODEL)
    args = parser.parse_args()
    result = prefetch_memory_gate_model(args.model)
    print(json.dumps({"status": "ready", **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
