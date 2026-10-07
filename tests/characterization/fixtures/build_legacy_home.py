"""Generate the frozen v0.7.1 data home used by ``test_legacy_home.py``.

Run this ONLY with the v0.7.1 backend (``git checkout v0.7.1``). Its output is the
compatibility contract for user data written by that release; regenerating it with a
refactored backend would silently erase that guarantee.

    python -m tests.characterization.fixtures.build_legacy_home

Machine-specific values are replaced by ``{{TOKENS}}`` that the test substitutes back.
The global session index is stored as a SQL dump (``sessions.sqlite3.sql``) because it
embeds absolute manifest paths. Pure caches (timeline index, timing database) are left out:
the backend must rebuild them from the authoritative files.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
from contextlib import closing
from pathlib import Path

from tests.characterization.support.backend import Backend
from tests.characterization.support.fake_llm import FakeLLM
from tests.characterization.support.home import FAKE_ACP_AGENT, build_home

OUTPUT = Path(__file__).resolve().parent / "legacy_home_v0_7_1"
HASHES = OUTPUT.with_name("legacy_home_v0_7_1.hashes.json")
EXCLUDED_NAMES = {"sessions.sqlite3", ".timings-v1.sqlite3", ".memory-git.lock", ".dream.lock"}
EXCLUDED_PARTS = (".desktop-timeline", "-wal", "-shm", "/.git/", "context-v1")
TEXT_SUFFIXES = {".json", ".jsonl", ".md"}


def _drive(backend: Backend, workspace: Path, research: Path) -> None:
    chat = backend.call("create_thread", space="chat", project_id_value="chat:general")
    backend.run_turn(chat["id"], "Plan my week, I like concise weekly plans [[prefer]]")
    backend.run_turn(chat["id"], "Add a gym session on Friday")
    edited = backend.call("load_thread", thread_id=chat["id"])["editableTurnIds"][-1]
    backend.call("rewind_thread", thread_id=chat["id"], item_id=edited)
    backend.run_turn(chat["id"], "Add a gym session on Saturday")
    backend.run_turn(chat["id"], "/rename Weekly plan")
    backend.call("review_memory_source", action="consolidate", space="non_productivity",
                 project="general", session_id=chat["id"])

    backend.call("add_project", space="chat", project_path=str(research))
    research = backend.call("create_thread", space="chat", project_id_value="chat:research")
    backend.run_turn(research["id"], "Collect reading notes")
    backend.call("review_memory_source", action="skip", space="non_productivity",
                 project="research", session_id=research["id"])

    task = backend.call("create_thread", space="productivity",
                        project_id_value="productivity:workspace",
                        project_path=str(workspace))
    backend.run_turn(task["id"], "Write the notes file [[plan]] [[tool]] [[write]]")
    backend.run_turn(task["id"], "Summarize what changed")
    backend.call("load_thread", thread_id=chat["id"])  # Leave the chat thread active.


def _tokenize(text: str, tokens: dict[str, str], *, json_text: bool) -> str:
    for raw, token in sorted(tokens.items(), key=lambda item: -len(item[0])):
        # Productivity paths are stored normcased (lower-case on Windows).
        variants = {raw, raw.replace("\\", "/"), os.path.normcase(raw)}
        if json_text:
            variants |= {json.dumps(value)[1:-1] for value in list(variants)}
        for variant in sorted(variants, key=len, reverse=True):
            text = text.replace(variant, token)
    return text


def write_hashes() -> None:
    """Freeze v0.7.1's content hash of each (tokenized) fixture event log."""
    from cleo.memory.compaction import event_content_hash, load_events

    hashes = {
        path.parent.name: event_content_hash(load_events(path))
        for path in sorted(OUTPUT.glob("memory/*/projects/*/sessions/*/events.jsonl"))
    }
    HASHES.write_text(json.dumps(hashes, indent=2) + "\n", encoding="utf-8", newline="\n")


def main() -> None:
    if "--hashes-only" in sys.argv:
        write_hashes()
        return
    with tempfile.TemporaryDirectory(prefix="cleo-legacy-") as directory:
        root = Path(directory)
        llm = FakeLLM().start()
        home = build_home(root, llm.base_url)
        backend = Backend(home).start()
        try:
            research = root / "research"
            research.mkdir()
            _drive(backend, home.workspace, research)
        finally:
            backend.kill()
            llm.stop()
        tokens = {
            str(home.home): "{{HOME}}", str(home.workspace): "{{WORKSPACE}}",
            str(home.user_home): "{{USER}}", llm.base_url: "{{LLM_URL}}",
            str(root / "research"): "{{RESEARCH}}",
            str(FAKE_ACP_AGENT): "{{FAKE_ACP_AGENT}}", sys.executable: "{{PYTHON}}",
        }
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        for source in sorted(home.home.rglob("*")):
            relative = source.relative_to(home.home).as_posix()
            if (not source.is_file() or source.name in EXCLUDED_NAMES
                    or any(part in "/" + relative for part in EXCLUDED_PARTS)):
                continue
            target = OUTPUT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix in TEXT_SUFFIXES:
                text = source.read_text(encoding="utf-8")
                target.write_text(_tokenize(text, tokens, json_text=source.suffix != ".md"),
                                  encoding="utf-8", newline="\n")
            else:
                data = source.read_bytes()
                for raw in tokens:
                    if raw.encode("utf-8") in data:
                        raise RuntimeError(f"{relative} embeds a machine path: {raw}")
                target.write_bytes(data)
        with closing(sqlite3.connect(home.memory / "sessions.sqlite3")) as connection:
            dump = "\n".join(connection.iterdump()) + "\n"
        (OUTPUT / "memory" / "sessions.sqlite3.sql").write_text(
            _tokenize(dump, tokens, json_text=False), encoding="utf-8", newline="\n")
    write_hashes()
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
