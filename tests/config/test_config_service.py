from __future__ import annotations

import json
from pathlib import Path

import pytest

import cleo.config.settings as settings_module
from cleo.config.service import ConfigService
from cleo.config.settings import current_settings, load_settings

SECRET = "sk-must-not-appear-in-status"


def _cleo(tmp_path: Path, *, model: str = "model-a", root: str | None = None) -> dict:
    return {
        "active_profiles": {"agent": "main"},
        "profiles": {
            "agents": {"main": {"provider": "openai", "model": model, "api_key": SECRET}},
            "directories": {"default": {"root_dir": root or str(tmp_path)}},
        },
    }


HARNESSES = {"default_provider": "codex", "providers": {"codex": {"type": "codex_sdk"}}}


@pytest.fixture
def files(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    monkeypatch.setattr(settings_module, "_current_settings", None)
    config = tmp_path / "cleo.json"
    harnesses = tmp_path / "harnesses.json"
    config.write_text(json.dumps(_cleo(tmp_path)), encoding="utf-8")
    harnesses.write_text(json.dumps(HARNESSES), encoding="utf-8")
    return config, harnesses


def _service(files: tuple[Path, Path]) -> ConfigService:
    config, harnesses = files
    return ConfigService(config, harnesses, initial=load_settings(config, harnesses))


def test_reload_applies_a_valid_change_and_notifies_listeners(files, tmp_path) -> None:
    service = _service(files)
    seen = []
    service.subscribe(lambda old, new: seen.append((old.active_agent_profile.model,
                                                     new.active_agent_profile.model)))
    files[0].write_text(json.dumps(_cleo(tmp_path, model="model-b")), encoding="utf-8")

    assert service.reload() is True
    assert service.status() == {"version": 2, "error": None, "restartRequired": False}
    assert current_settings().active_agent_profile.model == "model-b"
    assert settings_module.settings.active_agent_profile.model == "model-b"
    assert seen == [("model-a", "model-b")]


def test_refresh_only_reloads_when_a_file_changed(files, tmp_path) -> None:
    service = _service(files)
    assert service.refresh_if_changed() is False

    files[0].write_text(json.dumps(_cleo(tmp_path, model="model-longer-name")), encoding="utf-8")

    assert service.refresh_if_changed() is True
    assert service.refresh_if_changed() is False
    assert service.snapshot.version == 2


def test_invalid_edit_keeps_the_working_snapshot_without_echoing_secrets(files, tmp_path) -> None:
    service = _service(files)
    broken = _cleo(tmp_path)
    broken["profiles"]["agents"]["main"]["temperature"] = SECRET  # Invalid value holding a key.
    files[0].write_text(json.dumps(broken), encoding="utf-8")

    assert service.refresh_if_changed() is False
    status = service.status()
    assert status["version"] == 1
    assert status["error"] and "temperature" in status["error"]
    assert SECRET not in status["error"]
    assert current_settings().active_agent_profile.model == "model-a"

    files[0].write_text("{not json", encoding="utf-8")
    assert service.refresh_if_changed() is False
    assert "JSONDecodeError" in service.status()["error"]

    files[0].write_text(json.dumps(_cleo(tmp_path, model="model-c")), encoding="utf-8")
    assert service.refresh_if_changed() is True
    assert service.status()["error"] is None


def test_deleted_configuration_is_reported_and_never_replaced_by_a_template(files) -> None:
    service = _service(files)
    files[0].unlink()

    assert service.refresh_if_changed() is False
    assert "配置文件不存在" in service.status()["error"]
    assert not files[0].exists()
    assert current_settings().active_agent_profile.model == "model-a"


def test_data_directory_changes_wait_for_a_restart(files, tmp_path) -> None:
    service = _service(files)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    files[0].write_text(json.dumps(_cleo(tmp_path, model="model-b", root=str(elsewhere))),
                        encoding="utf-8")

    assert service.reload() is True
    assert service.status()["restartRequired"] is True
    assert current_settings().active_agent_profile.model == "model-b"
    assert current_settings().active_directory_profile.root_path == tmp_path.resolve()

    files[0].write_text(json.dumps(_cleo(tmp_path, model="model-b")), encoding="utf-8")
    assert service.reload() is True
    assert service.status()["restartRequired"] is False


def test_a_running_turn_keeps_the_snapshot_it_started_with(files, tmp_path) -> None:
    service = _service(files)
    with service.bind_run() as run:
        files[0].write_text(json.dumps(_cleo(tmp_path, model="model-b")), encoding="utf-8")
        assert service.reload() is True
        assert run.version == 1
        assert service.current_snapshot is run
        assert service.snapshot.version == service.status()["version"] == 2
        assert current_settings().active_agent_profile.model == "model-a"
        assert settings_module.settings.active_agent_profile.model == "model-a"
    assert service.current_snapshot is service.snapshot
    assert current_settings().active_agent_profile.model == "model-b"


def test_nested_run_restores_settings_and_version_after_failure(files, tmp_path) -> None:
    service = _service(files)
    with service.bind_run() as outer:
        files[0].write_text(json.dumps(_cleo(tmp_path, model="model-b")), encoding="utf-8")
        assert service.reload() is True
        with pytest.raises(RuntimeError, match="run failed"):
            with service.bind_run() as inner:
                assert inner is service.snapshot
                assert service.current_snapshot is inner
                assert current_settings() is inner.settings
                raise RuntimeError("run failed")
        assert service.current_snapshot is outer
        assert current_settings() is outer.settings
    assert service.current_snapshot is service.snapshot
    assert current_settings() is service.snapshot.settings


def test_a_failing_listener_is_reported_instead_of_raising(files, tmp_path) -> None:
    service = _service(files)

    def broken(_old, _new):
        raise RuntimeError("provider rebuild failed")

    service.subscribe(broken)
    files[0].write_text(json.dumps(_cleo(tmp_path, model="model-b")), encoding="utf-8")

    assert service.reload() is True
    assert "provider rebuild failed" in service.status()["error"]
    assert current_settings().active_agent_profile.model == "model-b"
