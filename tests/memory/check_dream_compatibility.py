"""Check actual previous readers/writers against isolated DreamAgent fixtures.

Run with a dependency-equipped Python: python -I tests/memory/check_dream_compatibility.py.
Reads HEAD and retained program source archives; writes only disposable fixtures.
"""

import json
import os
import subprocess
import sys
import tarfile
import tempfile
import types
from pathlib import Path


FILES = ("cleo/memory/state.py", "cleo/memory/consolidation.py", "cleo/sessions/store.py")


def previous_sources(source):
    """Purpose: Cover the iteration base and every locally returnable program.
    Input: Checkout. Output: Named original source sets; missing readers fail explicitly.
    """
    yield "iteration HEAD", {
        name: subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=source).decode("utf-8")
        for name in FILES
    }
    for archive in sorted((source.parent / "builds").glob("*/Cleo/resources/evolution-source.tar.gz")):
        with tarfile.open(archive, "r:gz") as bundle:
            files = {member.name.removeprefix("./"): member for member in bundle.getmembers()}
            missing = set(FILES) - files.keys()
            if missing:
                raise AssertionError(f"Unverified {archive}: missing {sorted(missing)}")
            yield archive.parents[2].name, {
                name: bundle.extractfile(files[name]).read().decode("utf-8") for name in FILES
            }


def old_module(name, text):
    """Purpose: Execute a previous implementation without replacing live modules.
    Input: Unique name and original code. Output: Isolated module used only on fixtures.
    """
    module = types.ModuleType(name)
    module.__file__ = f"{name}.py"
    sys.modules[name] = module
    exec(compile(text, module.__file__, "exec"), module.__dict__)
    return module


def round_trip(root, previous, index):
    """Purpose: Verify old → new → old → new preserves data with real storage methods.
    Input: Temporary root and old code. Output: Assertions for events, manifest, queue and checkpoint.
    """
    from cleo.memory import consolidation, state
    from cleo.memory.dream_source import read_dream_source, register_dream_source
    from cleo.memory.paths import compact_path, memory_state_path
    from cleo.sessions.store import SessionStore

    old_state, old_checkpoint, old_store = [
        old_module(f"previous_dream_{index}_{i}", previous[name]) for i, name in enumerate(FILES)
    ]
    old_store.touch_session_source = old_state.touch_session_source
    memory = root / "memory"
    before_store = old_store.SessionStore(memory)
    before_store.create_session(session_id="existing", space="productivity", project="project",
                                provider="codex", owner_type="user")
    before_store.append_events(session_id="existing", space="productivity", project="project", events=[{
        "id": "existing-message", "type": "user_message", "actor": "user",
        "content": "Preserve nonempty chat", "data": {"future_field": {"keep": [1, 2]}},
    }])
    before_store.update_manifest("existing", future_manifest={"keep": [3]},
                                 runtime_options={"model": "source-model", "future_option": [4]})
    before_store.refresh_compact("existing")
    cache = compact_path(memory, "productivity", "project", "existing")
    cached = json.loads(cache.read_text(encoding="utf-8"))
    cached["future_cache"] = {"keep": [5]}
    cache.write_text(json.dumps(cached), encoding="utf-8")
    cache_before = cache.read_bytes()
    markdown = memory / "existing-memory.md"
    markdown.write_text("Existing user memory must remain intact.\n", encoding="utf-8")
    state_path = memory_state_path(memory, "productivity")
    queue = old_state._load_unlocked(state_path)
    source_id = "session:productivity:project:existing"
    queue["future_root"] = {"keep": [6]}
    queue["sources"][source_id]["future_source"] = {"keep": [7]}
    queue["sources"][source_id].pop("processed_hash", None)
    queue["sources"][source_id].pop("review_result", None)
    old_state._save_unlocked(state_path, queue)
    # Model a late turn_diff after the old writer finished compaction.
    before_store.append_event(session_id="existing", space="productivity", project="project",
                               event_type="turn_diff", actor="codex", content="late changes")
    current = SessionStore(memory)
    manifest, events, digest = read_dream_source(current, "productivity", "project", "existing")
    event_snapshot = json.loads(json.dumps(events))
    registered = register_dream_source(current, "productivity", "project", "existing", events)
    assert registered["source_hash"] == digest
    old_state.touch_session_source(space="productivity", project="project", session_id="existing",
                                  source_hash=digest, last_event_seq=events[-1]["seq"], path=state_path)
    old_writer = old_store.SessionStore(memory)
    old_writer.update_manifest("existing", title="Renamed by old version")
    assert old_writer.read_events("existing") == event_snapshot
    after = state._load_unlocked(state_path)
    assert after["future_root"] == queue["future_root"]
    assert after["sources"][source_id]["future_source"] == {"keep": [7]}
    assert after["sources"][source_id]["source_hash"] == digest
    assert current.load_manifest("existing")["future_manifest"] == manifest["future_manifest"]
    assert current.load_manifest("existing")["runtime_options"] == manifest["runtime_options"]
    assert read_dream_source(current, "productivity", "project", "existing")[1] == event_snapshot
    assert cache.read_bytes() == cache_before
    assert markdown.read_text(encoding="utf-8") == "Existing user memory must remain intact.\n"

    checkpoint = root / "dream.json"
    original = {"version": 2, "committed_seq": 0, "committed_hash": None,
                "summary": "Nonempty checkpoint", "pending": {"results": {"block": {"edits": []}},
                "future_pending": [8]}, "future_checkpoint": {"keep": [9]}}
    old_checkpoint.save_checkpoint(checkpoint, original)
    consolidation.save_checkpoint(checkpoint, consolidation.load_checkpoint(checkpoint))
    old_checkpoint.save_checkpoint(checkpoint, old_checkpoint.load_checkpoint(checkpoint))
    assert consolidation.load_checkpoint(checkpoint) == original


def main():
    """Purpose: Run compatibility without touching shared user data.
    Input: This checkout and available bundles. Output: Named results; fixtures auto-cleaned.
    """
    source = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(source))
    with tempfile.TemporaryDirectory(prefix="cleo-dream-compat-") as temporary:
        root = Path(temporary)
        config = root / "cleo.json"
        config.write_text(json.dumps({"active_profiles": {"agent": "test"}, "profiles": {
            "agents": {"test": {"backend": "codex", "provider": "codex", "model": "test"}},
            "directories": {"default": {"root_dir": str(root)}},
        }}), encoding="utf-8")
        harnesses = root / "harnesses.json"
        harnesses.write_text('{}', encoding="utf-8")
        os.environ.update(CLEO_HOME=str(root), CLEO_CONFIG_PATH=str(config),
                          CLEO_HARNESSES_CONFIG_PATH=str(harnesses))
        before = config.read_bytes(), harnesses.read_bytes()
        for index, (label, sources) in enumerate(previous_sources(source)):
            case = root / f"case-{index}"
            case.mkdir()
            round_trip(case, sources, index)
            print(f"PASS old/new/old/new: {label}", flush=True)
        assert (config.read_bytes(), harnesses.read_bytes()) == before


if __name__ == "__main__":
    main()
