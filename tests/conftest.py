"""Shared test isolation."""

import pytest


@pytest.fixture(autouse=True)
def _no_local_harness_import(monkeypatch):
    # Harness homes copy the developer's real ~/.claude and ~/.codex setup on first use.
    # Tests must not read that live data; import tests re-enable it with fixtures.
    monkeypatch.setattr(
        "cleo.integrations.harness_import.ensure_imported", lambda *args, **kwargs: None,
    )
