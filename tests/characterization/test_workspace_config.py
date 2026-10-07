"""B2 — Workspace bootstrap, projects and local configuration over the protocol.

Configuration writes are followed by a backend restart to show the change was persisted;
before S1b the desktop shell restarted after every connection change. Live application of
changes is covered by ``test_hot_reload.py``.
"""

from __future__ import annotations

import json

from .support.backend import Backend
from .support.golden import assert_golden
from .support.home import CHAT_API_KEY, CleoHome
from .support.views import read_json, runtime_state


def _restart(backend: Backend) -> Backend:
    backend.stop()
    return Backend(backend.home).start()


def test_fresh_home_workspace_snapshot(backend: Backend, replacements: dict) -> None:
    assert_golden("workspace/fresh_home", backend.call("load_workspace"), replacements)


def test_read_only_catalogs(backend: Backend, cleo_home: CleoHome, replacements: dict) -> None:
    assert_golden("workspace/catalogs", {
        "runtime_catalog": backend.call("get_runtime_catalog"),
        "model_settings": backend.call("get_model_settings"),
        "subscription_catalog": backend.call("get_subscription_catalog"),
        "agent_instructions": backend.call("get_agent_instructions"),
        "harness_sync": backend.call("get_harness_sync"),
        "local_skills": backend.call("get_local_skills", provider="scripted",
                                     project_path=str(cleo_home.workspace)),
        "productivity_models": backend.call("get_productivity_models", provider="scripted",
                                            project_path=str(cleo_home.workspace)),
        "config_template_keys": sorted(backend.call("get_config_templates")),
        "is_evolution_thread_unknown": backend.call_error(
            "is_evolution_thread", thread_id="missing").name,
    }, replacements)


def test_project_registration_lifecycle(
    backend: Backend, cleo_home: CleoHome, replacements: dict,
) -> None:
    added = backend.call("add_project", space="productivity",
                         project_path=str(cleo_home.workspace))
    (cleo_home.workspace / "draft.txt").write_text("dirty\n", encoding="utf-8")
    dirty = backend.call("load_workspace")
    missing = backend.call_error("add_project", space="productivity",
                                 project_path=str(cleo_home.root / "missing"))
    bad_space = backend.call_error("add_project", space="other",
                                   project_path=str(cleo_home.workspace))
    removed = backend.call("remove_project", project_id_value="productivity:workspace")
    general = backend.call_error("remove_project", project_id_value="chat:general")
    invalid = backend.call_error("remove_project", project_id_value="nowhere")
    readded = backend.call("add_project", space="productivity",
                           project_path=str(cleo_home.workspace))
    assert_golden("workspace/projects", {
        "added": {"selectedProjectId": added["selectedProjectId"],
                  "projects": added["projects"]},
        "dirty_projects": dirty["projects"],
        "errors": {"missing": missing.message, "bad_space": bad_space.message,
                   "remove_general": general.message, "remove_invalid": invalid.message},
        "after_remove": removed["projects"],
        "after_readd": readded["projects"],
        "runtime.json": runtime_state(cleo_home),
    }, replacements)


def test_agent_instructions_round_trip(backend: Backend, cleo_home: CleoHome,
                                       replacements: dict) -> None:
    saved = backend.call("save_agent_instructions", content="# New rules\r\nBe brief.\n")
    on_disk = (cleo_home.home / "AGENTS.md").read_bytes().decode("utf-8")
    assert_golden("workspace/agent_instructions", {
        "saved": saved, "on_disk": on_disk,
        "reloaded": backend.call("get_agent_instructions"),
        "non_text": backend.call_error("save_agent_instructions", content=["x"]).name,
    }, replacements)


def test_model_connection_lifecycle(backend: Backend, cleo_home: CleoHome,
                                    replacements: dict) -> None:
    checked = backend.call("check_model_connection", connection={
        "provider": "openai", "apiKey": "sk-new-connection",
        "baseUrl": replacements_url(replacements)})
    created = backend.call("create_model_connection", connection={
        "displayName": "Second fake", "provider": "openai", "apiKey": "sk-new-connection",
        "baseUrl": replacements_url(replacements), "models": ["fake-chat", "fake-chat-mini"]})
    second = next(p["name"] for p in created["profiles"] if p["name"] != "fake_chat")
    duplicate = backend.call_error("create_model_connection", connection={
        "displayName": "second FAKE", "provider": "openai", "apiKey": "k", "models": ["m"]})
    no_models = backend.call_error("create_model_connection", connection={
        "displayName": "Empty", "provider": "openai", "apiKey": "k", "models": []})
    renamed = backend.call("rename_model_connection", profile_id=second, label="Renamed")
    selected = backend.call("select_chat_model", profile_id=second, model="fake-chat-mini")
    wrong_model = backend.call_error("select_chat_model", profile_id=second, model="nope")
    in_use = backend.call_error("remove_model_connection", profile_id=second)
    dream = backend.call("save_dream_settings", selection="mode:disabled")
    config_after = read_json(cleo_home.config_path)
    restarted = _restart(backend)
    try:
        catalog = restarted.call("get_runtime_catalog")
        workspace_runtime = restarted.call("load_workspace")["runtime"]
        removed_original = restarted.call("remove_model_connection", profile_id="fake_chat")
    finally:
        restarted.kill()
    assert CHAT_API_KEY not in json.dumps([created, renamed, selected, dream])
    assert_golden("workspace/model_connections", {
        "check": checked,
        "created": created, "renamed": renamed, "selected": selected, "dream": dream,
        "errors": {"duplicate": duplicate.message, "no_models": no_models.message,
                   "wrong_model": wrong_model.message, "in_use": in_use.message},
        "config_on_disk": config_after,
        "after_restart": {"catalog": catalog, "runtime": workspace_runtime},
        "removed_original": removed_original,
    }, replacements)


def replacements_url(replacements: dict) -> str:
    return next(raw for raw, placeholder in replacements.items() if placeholder == "<LLM_URL>")
