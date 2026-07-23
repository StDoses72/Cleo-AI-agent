from __future__ import annotations

from pathlib import Path

import config.settings as settings_module


def test_app_home_prefers_explicit_override(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    override = tmp_path / "cleo-home"
    monkeypatch.setenv("CLEO_HOME", str(override))

    assert settings_module._app_home(source_root) == override.resolve()


def test_app_home_uses_source_checkout_when_pyproject_exists(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    (source_root / "pyproject.toml").write_text("", encoding="utf-8")
    monkeypatch.delenv("CLEO_HOME", raising=False)

    assert settings_module._app_home(source_root) == source_root.resolve()


def test_app_home_uses_platform_user_data_for_installed_package(
    tmp_path: Path,
    monkeypatch,
) -> None:
    source_root = tmp_path / "site-packages"
    source_root.mkdir()
    user_data = tmp_path / "local-data" / "Cleo"
    monkeypatch.delenv("CLEO_HOME", raising=False)
    monkeypatch.setattr(
        settings_module,
        "user_data_dir",
        lambda *_args, **_kwargs: str(user_data),
    )

    assert settings_module._app_home(source_root) == user_data.resolve()
