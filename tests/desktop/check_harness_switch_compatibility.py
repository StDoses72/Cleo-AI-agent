"""Exercise actual base/baseline readers and writers on disposable handoff fixtures."""

import asyncio
import json
import subprocess
import sys
import tarfile
import types
from pathlib import Path

import test_harness_switch as fixtures

FILES = ("cleo/sessions/store.py", "cleo/harnesses/service.py", "cleo/config/settings.py",
         "cleo/desktop/configuration.py")


def sources(root):
    yield "iteration HEAD", {name: subprocess.check_output(
        ["git", "show", f"HEAD:{name}"], cwd=root).decode() for name in FILES}
    for folder in sorted(root.parent.glob("source*")):
        if folder.resolve() != root and folder.is_dir():
            if not all((folder / name).is_file() for name in FILES):
                print(f"UNVERIFIED {folder.name}: readers/writers unavailable")
                continue
            yield folder.name, {name: (folder / name).read_text() for name in FILES}
    for archive in sorted((root.parent / "builds").rglob("evolution-source.tar.gz")):
        with tarfile.open(archive) as bundle:
            saved = {}
            for member in bundle.getmembers():
                name = member.name.removeprefix("./")
                if name in FILES:
                    saved[name] = bundle.extractfile(member).read().decode()
            if len(saved) != len(FILES):
                print(f"UNVERIFIED {archive}: readers/writers unavailable")
                continue
            yield str(archive.relative_to(root.parent)), saved


def load(name, source):
    module = types.ModuleType(name)
    module.__file__ = str(Path(fixtures.fixture.name) / (name + ".py"))
    sys.modules[name] = module
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


async def round_trip(label, saved, index):
    from cleo.config.settings import ClaudeHarnessSettings, load_settings
    from cleo.desktop.task_harnesses import register_task_provider
    from cleo.harnesses.handoff import SWITCH_EVENT, pending_handoff
    from cleo.harnesses.service import AgentService
    from cleo.sessions.store import SessionStore

    old_store = load(f"switch_old_store_{index}", saved[FILES[0]]).SessionStore
    old_service = load(f"switch_old_service_{index}", saved[FILES[1]]).AgentService
    old_settings = load(f"switch_old_settings_{index}", saved[FILES[2]])
    old_config = load(f"switch_old_config_{index}", saved[FILES[3]])
    root = Path(fixtures.fixture.name) / str(index)
    root.mkdir()
    # Missing optional config fields and a configured provider with nonempty data.
    config, harness = root / "cleo.json", root / "harnesses.json"
    config.write_bytes((Path(fixtures.fixture.name) / "cleo.json").read_bytes())
    harness.write_text(json.dumps({"providers": {"codex": {
        "type": "codex_sdk", "model": "old-model",
    }}}))
    register_task_provider(harness, "claude", ClaudeHarnessSettings())
    assert old_settings.load_settings(config, harness).productivity.provider("claude").enabled
    before = harness.read_bytes()
    old_config._atomic_write(harness, old_config._read_config(harness))
    assert json.loads(harness.read_bytes()) == json.loads(before)
    assert load_settings(config, harness).productivity.provider("codex").model == "old-model"

    memory = root / "memory" / "MEMORY.md"
    skill = root / "skills" / "custom" / "SKILL.md"
    for path, content in ((memory, "Nonempty memory: preserve decisions."),
                          (skill, "User skill with unknown frontmatter.")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    protected = {path: path.read_bytes() for path in (config, memory, skill)}
    old = old_store(root / "memory")
    old.create_session(session_id="shared", space="productivity", project="project",
                       provider="a", native_session_id="a-old", owner_type="agent", cwd=str(root))
    old.update_manifest("shared", future_field={"ids": ["keep-id"]})
    old.append_event(space="productivity", project="project", session_id="shared",
                     event_type="user_message", actor="user", content="Goal, constraints and steps",
                     data={"unknown": {"meaning": "keep"}})
    old.append_event(space="productivity", project="project", session_id="shared",
                     event_type="tool_result", actor="a", content="Completed step 1",
                     data={"output": ["nonempty"], "future_result": 7})
    a, b = fixtures.Provider("a"), fixtures.Provider("b")
    current = SessionStore(root / "memory")
    service = AgentService(root, session_store=current)
    service.register(a)
    service.register(b)
    before_events = current.read_events("shared")
    await service.switch_session("shared", "b")
    pending = current.read_events("shared")
    marker = next(e for e in pending
                  if e.get("data", {}).get("provider_event_type") == SWITCH_EVENT)
    assert old.load_manifest("shared")["provider"] == "b"
    assert old.read_events("shared") == pending
    old.update_manifest("shared", title="Title written by previous program")
    assert pending_handoff(current.read_events("shared"), "b")
    # New native prompt receives the handoff once, before testing old-provider writes.
    await service.prompt("shared", "Continue step 2")
    await service.close("shared")
    new_written_events = current.read_events("shared")
    prior = old_service(root, session_store=old)
    prior.register(b)
    resumed = await prior.resume_session("b", old.load_manifest("shared")["native_session_id"],
                                         str(root), project="project")
    assert resumed.id == "shared"
    await prior.prompt("shared", "Older version adds a conclusion")
    await prior.close("shared")
    restored = current.load_manifest("shared")
    assert restored["future_field"] == {"ids": ["keep-id"]}
    events = current.read_events("shared")
    assert events[:len(before_events)] == before_events
    assert events[:len(new_written_events)] == new_written_events
    assert next(e for e in events if e["id"] == marker["id"]) == marker
    new_again = AgentService(root, session_store=current)
    new_again.register(a)
    new_again.register(b)
    await new_again.restore_session("shared")
    await new_again.switch_session("shared", "a")
    await new_again.prompt("shared", "Continue latest task")
    assert "Older version adds a conclusion" in a.calls[-1][1]
    assert "Goal, constraints and steps" in a.calls[-1][1]
    assert len({e["id"] for e in events}) == len(events)
    for path, content in protected.items():
        assert path.read_bytes() == content
    print(f"PASS {label}: old -> new switch/write -> old resume/write -> new read/switch; "
          "IDs, events, unknown fields, pending marker, config, memory, skills preserved")


def main():
    root = Path(__file__).resolve().parents[2]
    fixtures.setUpModule()
    try:
        count = 0
        for index, (label, saved) in enumerate(sources(root)):
            asyncio.run(round_trip(label, saved, index))
            count += 1
        print(f"Verified {count} source sets. "
              "Vendor-native continuity uses mocks; manual cases pending.")
    finally:
        fixtures.tearDownModule()


if __name__ == "__main__":
    main()
