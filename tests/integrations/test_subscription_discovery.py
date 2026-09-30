import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from cleo.config.settings import AgentProfile
from cleo.integrations import subscriptions


def installed_client(tmp_path, monkeypatch):
    monkeypatch.setattr(subscriptions, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(Path, "home", classmethod(lambda _: tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    path = tmp_path / ".local" / "bin" / ("claude.exe" if os.name == "nt" else "claude")
    path.parent.mkdir(parents=True)
    path.write_text("fixture", encoding="utf-8")
    path.chmod(0o700)
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir()
    monkeypatch.setenv("PATH", str(empty_path))
    return path


def test_gui_process_finds_native_client_without_shell_path(tmp_path, monkeypatch):
    path = installed_client(tmp_path, monkeypatch)
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")
    original_path = os.environ["PATH"]
    assert Path(subscriptions.executable(profile)) == path
    environment = subscriptions.runtime_environment()
    directories = environment["PATH"].split(os.pathsep)
    assert str(path.parent) in directories
    assert str(Path("/opt/homebrew/bin")) in directories
    assert str(Path("/usr/local/bin")) in directories
    assert os.environ["PATH"] == original_path


def test_explicit_missing_client_does_not_silently_use_another_install(tmp_path, monkeypatch):
    installed_client(tmp_path, monkeypatch)
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default",
                           executable=str(tmp_path / "missing-claude"))
    with pytest.raises(FileNotFoundError):
        subscriptions.executable(profile)


def test_configured_home_relative_path_is_expanded(tmp_path, monkeypatch):
    path = installed_client(tmp_path, monkeypatch)
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default",
                           executable=f"~/.local/bin/{path.name}")
    assert Path(subscriptions.executable(profile)) == path


def test_configured_command_name_uses_the_same_search_path(tmp_path, monkeypatch):
    path = installed_client(tmp_path, monkeypatch)
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default",
                           executable="claude")
    assert Path(subscriptions.executable(profile)) == path


def test_search_respects_existing_path_order(tmp_path, monkeypatch):
    local = installed_client(tmp_path, monkeypatch)
    preferred = tmp_path / "preferred" / local.name
    preferred.parent.mkdir()
    preferred.write_text("preferred fixture", encoding="utf-8")
    preferred.chmod(0o700)
    monkeypatch.setenv("PATH", str(preferred.parent))
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")
    assert Path(subscriptions.executable(profile)) == preferred
