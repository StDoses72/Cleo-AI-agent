"""Versioned configuration snapshots with hot reload.

``ConfigService`` owns the process configuration after startup. It reloads ``cleo.json`` and
``harnesses.json`` when the desktop app saves them or when they change on disk, validates
the result as a whole, and swaps the snapshot atomically. A configuration that fails to load
never replaces a working one. Data-directory settings cannot move while the backend runs;
changes to them are kept on disk and reported as ``restartRequired``.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from cleo.config.settings import (
    CONFIG_PATH,
    HARNESSES_CONFIG_PATH,
    SettingsModel,
    bound_settings,
    configure_settings,
    current_settings,
    load_settings,
)

Listener = Callable[[SettingsModel, SettingsModel], None]


@dataclass(frozen=True, slots=True)
class SettingsSnapshot:
    version: int
    settings: SettingsModel


def _describe(error: Exception) -> str:
    """Describe a load failure without echoing input values, which can hold API keys."""
    if isinstance(error, ValidationError):
        return "; ".join(
            f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
            for item in error.errors(include_input=False, include_url=False)[:5]
        )
    return f"{type(error).__name__}: {error}"


def _directory_fields(settings: SettingsModel) -> tuple[str, dict[str, Any]]:
    name = settings.active_profiles.directory
    return name, settings.profiles.directories[name].model_dump(mode="json")


class ConfigService:
    """Hold the current configuration snapshot and reload it without restarting."""

    def __init__(
        self,
        config_path: Path | str = CONFIG_PATH,
        harnesses_path: Path | str = HARNESSES_CONFIG_PATH,
        *,
        initial: SettingsModel | None = None,
    ) -> None:
        self._config_path = Path(config_path)
        self._harnesses_path = Path(harnesses_path)
        self._lock = threading.RLock()
        self._listeners: list[Listener] = []
        self._snapshot = SettingsSnapshot(1, initial or current_settings())
        self._run_snapshot: ContextVar[SettingsSnapshot | None] = ContextVar(
            "cleo_run_snapshot", default=None,
        )
        configure_settings(self._snapshot.settings)
        self._running_directory = _directory_fields(self._snapshot.settings)
        self._signature = self._file_signature()
        self._error: str | None = None
        self._restart_required = False

    @property
    def snapshot(self) -> SettingsSnapshot:
        return self._snapshot

    @property
    def current_snapshot(self) -> SettingsSnapshot:
        """Return the run-bound settings and version, or the latest snapshot outside a run."""
        return self._run_snapshot.get() or self._snapshot

    def status(self) -> dict[str, Any]:
        """Purpose: Describe the live configuration for the desktop app.

        Input: None. Output: ``version`` (increments on every applied change), the last load
        ``error`` or None, and whether a saved change waits for a restart.
        """
        return {"version": self._snapshot.version, "error": self._error,
                "restartRequired": self._restart_required}

    def subscribe(self, listener: Listener) -> None:
        """Purpose: Call ``listener(old, new)`` after each applied change. Output: None."""
        self._listeners.append(listener)

    @contextmanager
    def bind_run(self) -> Iterator[SettingsSnapshot]:
        """Purpose: Pin the current snapshot for one run; later reloads apply next turn."""
        snapshot = self._snapshot
        token = self._run_snapshot.set(snapshot)
        try:
            with bound_settings(snapshot.settings):
                yield snapshot
        finally:
            self._run_snapshot.reset(token)

    def refresh_if_changed(self) -> bool:
        """Purpose: Reload after an external edit, detected by file size and mtime.

        Input: None. Output: Whether a new snapshot was applied. Costs two ``stat`` calls when
        nothing changed, so it can run before every request.
        """
        if self._file_signature() == self._signature:
            return False
        return self.reload()

    def reload(self) -> bool:
        """Purpose: Load both files, validate them together and swap the snapshot.

        Input: None. Output: Whether a new snapshot was applied. On failure the current
        snapshot stays and the error is reported through ``status()``.
        """
        with self._lock:
            self._signature = self._file_signature()
            missing = [path for path in (self._config_path, self._harnesses_path)
                       if not path.is_file()]
            if missing:
                # load_settings would write default templates; never replace a working setup.
                self._error = "配置文件不存在：" + "、".join(str(path) for path in missing)
                return False
            try:
                loaded = load_settings(self._config_path, self._harnesses_path)
            except (OSError, ValueError) as exc:
                self._error = f"配置未生效，继续使用上一份有效配置：{_describe(exc)}"
                return False
            old = self._snapshot.settings
            # Paths of the data home cannot move under a running backend; saving them back
            # to the running values clears the pending restart again.
            self._restart_required = _directory_fields(loaded) != self._running_directory
            if self._restart_required:
                loaded.active_profiles.directory = old.active_profiles.directory
                loaded.profiles.directories = old.profiles.directories
            self._error = None
            self._snapshot = SettingsSnapshot(self._snapshot.version + 1, loaded)
            configure_settings(loaded)
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(old, loaded)
            except Exception as exc:  # A consumer failing must not take the server down.
                self._error = f"配置已加载，但部分组件未能更新：{exc}"
        return True

    def _file_signature(self) -> tuple[tuple[int, int] | None, ...]:
        signature = []
        for path in (self._config_path, self._harnesses_path):
            try:
                stat = path.stat()
            except OSError:
                signature.append(None)
                continue
            signature.append((stat.st_mtime_ns, stat.st_size))
        return tuple(signature)
