"""Shared test isolation."""

import pytest


@pytest.fixture(autouse=True)
def _no_local_harness_import(monkeypatch, tmp_path):
    # Native-home tests must never read or migrate the developer's real account state.
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "native-codex"))
    monkeypatch.setenv("CODEX_SQLITE_HOME", str(tmp_path / "native-codex"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "native-claude"))
    monkeypatch.setattr("cleo.config.settings.APP_HOME", tmp_path / "cleo")
    monkeypatch.setattr(
        "cleo.integrations.harness_import.ensure_imported", lambda *args, **kwargs: None,
    )
