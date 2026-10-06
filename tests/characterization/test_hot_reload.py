"""B2b — Configuration changes apply to the running backend (S1b hot reload).

Since S1b the desktop shell no longer restarts the backend after a configuration write when
``load_workspace().backend.hotReload`` is true. These snapshots pin what a running process
does with a change saved through the protocol, an external edit of ``cleo.json`` or
``harnesses.json``, an edit that does not load, and a data-directory change.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .support.backend import Backend
from .support.fake_llm import FakeLLM
from .support.golden import assert_golden
from .support.home import FAKE_ACP_AGENT, CleoHome
from .support.views import read_json


def _config_status(backend: Backend) -> dict[str, Any]:
    return backend.call("load_workspace")["backend"]["config"]


def _write(path: Path, content: str) -> None:
    """Rewrite a file and move its mtime forward, as an editor save would."""
    previous = path.stat().st_mtime_ns if path.exists() else time.time_ns()
    path.write_text(content, encoding="utf-8")
    stamp = max(time.time_ns(), previous + 1_000_000)
    os.utime(path, ns=(stamp, stamp))


def _chat_catalog(backend: Backend) -> list[dict[str, Any]]:
    return [{key: profile[key] for key in ("id", "model", "active")}
            for profile in backend.call("get_runtime_catalog")["nonProductivityProfiles"]]


def _harness_ids(backend: Backend) -> list[str]:
    return [provider["id"] for provider in
            backend.call("get_runtime_catalog")["productivityProviders"]]


def _request_summary(body: dict[str, Any]) -> dict[str, Any]:
    names = [tool["function"]["name"] for tool in body.get("tools", [])]
    return {"model": body.get("model"),
            "browser_tools": sorted(name for name in names if name.startswith("browser_"))}


def _chat_model(backend: Backend, fake_llm: FakeLLM) -> str | None:
    """Run one turn in a new chat and return the model the backend asked for."""
    thread = backend.call("create_thread", space="chat", project_id_value="chat:general")
    backend.run_turn(thread["id"], "Which model answers?")
    return fake_llm.chat_requests()[-1].get("model")


def test_saved_and_external_changes_apply_without_restart(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    base_url = next(raw for raw, label in replacements.items() if label == "<LLM_URL>")
    first_model = _chat_model(backend, fake_llm)
    initial = _config_status(backend)

    created = backend.call("create_model_connection", connection={
        "displayName": "Second fake", "provider": "openai", "apiKey": "sk-second",
        "baseUrl": base_url, "models": ["fake-chat", "fake-chat-mini"]})
    second = next(p["name"] for p in created["profiles"] if p["name"] != "fake_chat")
    backend.call("select_chat_model", profile_id=second, model="fake-chat-mini")
    after_save = {
        "config": _config_status(backend),
        "catalog": _chat_catalog(backend),
        "chat_model": _chat_model(backend, fake_llm),
    }

    config = read_json(cleo_home.config_path)
    config["profiles"]["agents"][second]["model"] = "fake-chat"
    _write(cleo_home.config_path, json.dumps(config, indent=2))
    after_edit = {"config": _config_status(backend), "catalog": _chat_catalog(backend),
                  "chat_model": _chat_model(backend, fake_llm)}

    # A running turn keeps the snapshot it started with. The same thread's next turn rebuilds
    # its agent: tool settings follow the new snapshot, while the model stays pinned to the
    # thread's chat_profile as in v0.7.1. New chats use the new model.
    thread = backend.call("create_thread", space="chat", project_id_value="chat:general")
    running = backend.stream_turn(thread["id"], "Take your time [[delay]]")
    running.wait_for(lambda event: event["type"] == "turn-started")
    config["profiles"]["agents"][second]["model"] = "fake-chat-mini"
    config["profiles"]["tools"]["default"]["browser"] = {"enabled": True}
    _write(cleo_home.config_path, json.dumps(config, indent=2))
    during_run = _config_status(backend)
    assert running.result() is None
    running_request = fake_llm.chat_requests()[-1]
    backend.run_turn(thread["id"], "And now?")
    same_thread = {"config_during_run": during_run,
                   "running_turn": _request_summary(running_request),
                   "next_turn": _request_summary(fake_llm.chat_requests()[-1]),
                   "new_chat_model": _chat_model(backend, fake_llm)}

    assert_golden("workspace/hot_reload_changes", {
        "first_model": first_model,
        "initial": initial,
        "after_save": after_save,
        "after_external_edit": after_edit,
        "same_thread": same_thread,
    }, replacements)


def test_broken_edits_keep_the_working_configuration(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM, replacements: dict,
) -> None:
    valid = cleo_home.config_path.read_text(encoding="utf-8")
    initial = _config_status(backend)  # The process has loaded its configuration.

    _write(cleo_home.config_path, "{not json")
    broken_json = {"config": _config_status(backend),
                   "chat_model": _chat_model(backend, fake_llm)}

    invalid = json.loads(valid)
    invalid["profiles"]["agents"]["fake_chat"]["max_tokens"] = "sk-not-a-number"
    _write(cleo_home.config_path, json.dumps(invalid, indent=2))
    invalid_value = _config_status(backend)
    assert "sk-not-a-number" not in json.dumps(invalid_value)

    _write(cleo_home.config_path, valid)
    repaired = backend.call("get_config_status")  # Window focus: the first call applies it.
    assert repaired == _config_status(backend)

    moved = json.loads(valid)
    moved["profiles"]["directories"]["default"]["data_dir"] = "data-moved"
    _write(cleo_home.config_path, json.dumps(moved, indent=2))
    directory_change = {"config": _config_status(backend),
                        "chat_model": _chat_model(backend, fake_llm)}

    _write(cleo_home.config_path, valid)
    directory_reverted = _config_status(backend)

    assert_golden("workspace/hot_reload_failures", {
        "initial": initial,
        "broken_json": broken_json,
        "invalid_value": invalid_value,
        "repaired": repaired,
        "directory_change": directory_change,
        "directory_reverted": directory_reverted,
        "config_on_disk_untouched": cleo_home.config_path.read_text(encoding="utf-8") == valid,
    }, replacements)


def test_non_object_config_keeps_backend_running_and_can_be_repaired(
    backend: Backend, cleo_home: CleoHome, fake_llm: FakeLLM,
) -> None:
    valid = cleo_home.config_path.read_text(encoding="utf-8")
    initial = backend.call("get_config_status")
    for content in ("[]", "null"):
        _write(cleo_home.config_path, content)
        status = backend.call("get_config_status", timeout=10)
        assert status["version"] == initial["version"]
        assert "cleo.json must contain a JSON object." in status["error"]
        assert not status["restartRequired"]
        assert backend.returncode is None
        assert _chat_model(backend, fake_llm) == "fake-chat"
        assert cleo_home.config_path.read_text(encoding="utf-8") == content

    _write(cleo_home.config_path, valid)
    repaired = backend.call("get_config_status")
    assert repaired == {"version": initial["version"] + 1, "error": None,
                        "restartRequired": False}
    assert _chat_model(backend, fake_llm) == "fake-chat"
    # Release chat agents so shutdown does not launch a detached memory worker.
    for thread in backend.call("load_workspace")["threads"]:
        backend.call("delete_thread", thread_id=thread["id"])
    assert backend.call("shutdown") == {"stopped": True}
    assert backend.wait_exit(30) == 0


def test_harness_changes_reach_new_sessions(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    def new_task(provider: str) -> Any:
        return backend.call("create_thread", space="productivity",
                            project_id_value="productivity:workspace",
                            project_path=str(cleo_home.workspace), provider=provider)

    initial = _harness_ids(backend)  # The process has loaded its configuration.
    before = backend.call_error("create_thread", space="productivity",
                                project_id_value="productivity:workspace",
                                project_path=str(cleo_home.workspace), provider="second_agent")

    harnesses = read_json(cleo_home.harnesses_path)
    harnesses["providers"]["second_agent"] = {
        "type": "acp", "enabled": True,
        "options": {"command": harnesses["providers"]["scripted"]["options"]["command"],
                    "args": ["-u", str(FAKE_ACP_AGENT)], "auto_approve": False},
    }
    _write(cleo_home.harnesses_path, json.dumps(harnesses, indent=2))
    listed = _harness_ids(backend)
    added = new_task("second_agent")
    backend.run_turn(added["id"], "Hello from the new harness")
    turn = backend.call("load_thread", thread_id=added["id"])

    harnesses["providers"]["second_agent"]["enabled"] = False
    _write(cleo_home.harnesses_path, json.dumps(harnesses, indent=2))
    disabled = backend.call_error("create_thread", space="productivity",
                                  project_id_value="productivity:workspace",
                                  project_path=str(cleo_home.workspace),
                                  provider="second_agent")

    assert_golden("workspace/hot_reload_harnesses", {
        "initial": initial,
        "before": {"name": before.name, "message": before.message},
        "listed_after_add": listed,
        "listed_after_disable": _harness_ids(backend),
        "added": {key: added["runtime"].get(key) for key in ("provider", "model", "models")},
        "turn_items": [item.get("type") for item in turn.get("items", [])],
        "disabled": {"name": disabled.name, "message": disabled.message},
        "config": _config_status(backend),
    }, replacements)
