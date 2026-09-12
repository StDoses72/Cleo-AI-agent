"""Run previous-source reader/writer round trips on temporary fixtures only."""

import json
import subprocess
import sys
import tarfile
import types
from pathlib import Path

import test_task_harness_selection as fixtures

FILES = ("cleo/config/settings.py", "cleo/desktop/configuration.py", "cleo/sessions/store.py")


def previous_sources(root):
    """Purpose: Read returnable source versions. Input: checkout. Output: named source sets."""
    base = {name: subprocess.check_output(
        ["git", "show", f"HEAD:{name}"], cwd=root,
    ).decode("utf-8") for name in FILES}
    yield "iteration HEAD", base
    for directory in sorted(root.parent.glob("source*")):
        if directory.resolve() == root or not directory.is_dir():
            continue
        if all((directory / name).is_file() for name in FILES):
            yield (
                directory.name,
                {name: (directory / name).read_text(encoding="utf-8") for name in FILES},
            )
    for archive in sorted(
        (root.parent / "builds").glob("*/Cleo/resources/evolution-source.tar.gz")
    ):
        with tarfile.open(archive, "r:gz") as bundle:
            found = {}
            for member in bundle.getmembers():
                for name in FILES:
                    if member.isfile() and member.name.removeprefix("./").endswith(name):
                        found[name] = bundle.extractfile(member).read().decode("utf-8")
            if len(found) != len(FILES):
                raise AssertionError(f"Missing reader/writer in {archive}")
            yield archive.parents[2].name, found


def load_module(name, source):
    """Purpose: Execute the actual previous implementation. Input: source. Output: module."""
    module = types.ModuleType(name)
    module.__file__ = str(Path(fixtures.fixture.name) / name / "module.py")
    sys.modules[name] = module
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


def round_trip(label, sources, index):
    """Purpose: Prove old/new interoperability. Input: saved sources. Output: assertions."""
    from cleo.config.settings import ClaudeHarnessSettings, load_settings
    from cleo.desktop.task_harnesses import register_task_provider
    from cleo.sessions.store import SessionStore

    old_settings = load_module(f"old_settings_{index}", sources[FILES[0]])
    old_config = load_module(f"old_config_{index}", sources[FILES[1]])
    old_store = load_module(f"old_store_{index}", sources[FILES[2]])
    root = Path(fixtures.fixture.name) / str(index)
    root.mkdir()
    config = root / "cleo.json"
    config.write_bytes((Path(fixtures.fixture.name) / "cleo.json").read_bytes())
    harness = root / "harnesses.json"
    original = {"providers": {"codex": {"type": "codex_sdk", "model": "original-model"}}}
    old_config._atomic_write(harness, original)
    assert (
        old_settings.load_settings(config, harness).productivity.provider("codex").model
        == "original-model"
    )
    register_task_provider(
        harness, "claude", ClaudeHarnessSettings(model="opus", models=["sonnet"])
    )
    expected = json.loads(harness.read_text(encoding="utf-8"))
    assert (
        old_settings.load_settings(config, harness).productivity.provider("claude").model == "opus"
    )
    # Older releases have no harness-edit UI. Exercise their actual shared JSON
    # configuration reader/writer, never their first-run default-file creator.
    old_config._atomic_write(harness, old_config._read_config(harness))
    assert json.loads(harness.read_text(encoding="utf-8")) == expected
    assert load_settings(config, harness).productivity.provider("claude").models == ["sonnet"]
    assert expected["providers"]["codex"] == original["providers"]["codex"]

    store = old_store.SessionStore(root / "memory")
    store.create_session(session_id="existing", space="productivity", project="project",
                         provider="codex", owner_type="user", cwd=str(root))
    store.update_manifest("existing", future_field={"keep": [1, 2]}, runtime_options={
        "model": "original-model", "future_option": "keep",
    })
    store.append_event(space="productivity", project="project", session_id="existing",
                       event_type="user_message", actor="user", content="Nonempty conversation")
    memory = root / "memory" / "MEMORY.md"
    memory.write_text("Keep these memory notes.", encoding="utf-8")
    new_store = SessionStore(root / "memory")
    before_events = new_store.read_events("existing")
    new_store.update_manifest("existing", title="New title")
    store.update_manifest("existing", title="Old writer title")
    restored = new_store.load_manifest("existing")
    assert restored["future_field"] == {"keep": [1, 2]}
    assert restored["runtime_options"] == {"model": "original-model", "future_option": "keep"}
    assert new_store.read_events("existing") == before_events
    assert memory.read_text(encoding="utf-8") == "Keep these memory notes."
    print(f"PASS {label}: old -> new -> old -> new; config, session fields, messages, memory")


def main():
    """Purpose: Run isolated compatibility checks. Input: local sources. Output: pass/fail."""
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root))
    fixtures.setUpModule()
    try:
        count = 0
        for index, (label, sources) in enumerate(previous_sources(root)):
            round_trip(label, sources, index)
            count += 1
        print(f"Verified {count} previous source sets; temporary fixtures removed on exit.")
    finally:
        fixtures.tearDownModule()


if __name__ == "__main__":
    main()
