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


def desktop_client(home: Path, version: str, build: str, *, modified: int = 0) -> Path:
    """A Claude Code build as the Claude desktop application lays it out on macOS."""
    path = (home / "Library" / "Application Support" / "Claude" / "claude-code" / version / build
            / "claude.app" / "Contents" / "MacOS" / "claude")
    path.parent.mkdir(parents=True)
    path.write_text("fixture", encoding="utf-8")
    path.chmod(0o700)
    if modified:
        os.utime(path, (modified, modified))
    return path


def without_command(tmp_path, monkeypatch, platform="darwin"):
    """A process started from the desktop: nothing named ``claude`` on any searched path."""
    monkeypatch.setattr(subscriptions, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(Path, "home", classmethod(lambda _: tmp_path))
    empty_path = tmp_path / "empty-path"
    empty_path.mkdir(exist_ok=True)
    monkeypatch.setenv("PATH", str(empty_path))
    # The Homebrew directories are searched on macOS; the machine running the test may have one.
    monkeypatch.setattr(subscriptions, "_runtime_path", lambda: str(empty_path))
    return AgentProfile(backend="claude_code", provider="claude_code", model="default")


def test_claude_code_kept_by_the_claude_desktop_app_is_found(tmp_path, monkeypatch):
    profile = without_command(tmp_path, monkeypatch)
    with pytest.raises(FileNotFoundError):
        subscriptions.executable(profile)
    # The installation from the report: one version, one build, an application bundle.
    path = desktop_client(tmp_path, "2.1.330", "4262a1273231")
    assert Path(subscriptions.executable(profile)) == path


def test_the_newest_desktop_version_that_can_still_run_is_used(tmp_path, monkeypatch):
    profile = without_command(tmp_path, monkeypatch)
    left_behind = desktop_client(tmp_path, "2.1.99", "aaaa")
    older_build = desktop_client(tmp_path, "2.1.330", "bbbb", modified=1_000)
    current = desktop_client(tmp_path, "2.1.330", "cccc", modified=2_000)
    # Version numbers compare as numbers, and the later build of one version wins.
    assert Path(subscriptions.executable(profile)) == current
    # An update removed the files that were in use: the next lookup moves on by itself.
    current.unlink()
    assert Path(subscriptions.executable(profile)) == older_build
    older_build.unlink()
    assert Path(subscriptions.executable(profile)) == left_behind
    # A directory the application never finished, and one that is not a version at all.
    (left_behind.parents[4] / "2.2.0" / "dddd").mkdir(parents=True)
    (left_behind.parents[4] / "tmp").mkdir()
    assert Path(subscriptions.executable(profile)) == left_behind
    left_behind.chmod(0o600)
    if os.name != "nt":  # Windows has no execute bit to take away.
        with pytest.raises(FileNotFoundError):
            subscriptions.executable(profile)


def test_a_command_on_the_search_path_comes_before_the_desktop_app(tmp_path, monkeypatch):
    path = installed_client(tmp_path, monkeypatch)
    desktop_client(tmp_path, "9.9.9", "eeee")
    profile = AgentProfile(backend="claude_code", provider="claude_code", model="default")
    assert Path(subscriptions.executable(profile)) == path


def test_the_desktop_app_location_is_only_used_where_it_was_confirmed(tmp_path, monkeypatch):
    path = desktop_client(tmp_path, "2.1.330", "4262a1273231")
    for platform in ("win32", "linux"):
        with monkeypatch.context() as other:
            profile = without_command(tmp_path, other, platform)
            with pytest.raises(FileNotFoundError):
                subscriptions.executable(profile)
    # Another client is not looked for in Claude's directory, and a configured client that is
    # missing is still an error instead of a quiet switch to another installation.
    profile = without_command(tmp_path, monkeypatch)
    assert Path(subscriptions.executable(profile)) == path
    with pytest.raises(FileNotFoundError):
        subscriptions.executable(profile.model_copy(update={"backend": "gemini"}))
    with pytest.raises(FileNotFoundError):
        subscriptions.executable(profile.model_copy(update={"executable": "claude-nightly"}))
