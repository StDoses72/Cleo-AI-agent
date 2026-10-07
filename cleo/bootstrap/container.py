"""Build the desktop backend from explicitly loaded settings.

Entry points call these functions instead of relying on import-time globals. Loading the
configuration here, at startup, keeps the existing failure mode: a missing or invalid
configuration stops the process before it serves any request.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cleo.config.settings import SettingsModel, current_settings

if TYPE_CHECKING:
    from cleo.desktop.service import DesktopService


def load_configuration() -> SettingsModel:
    """Purpose: Load (once) and return the process configuration.

    Input: None; paths come from CLEO_HOME / CLEO_CONFIG_PATH / CLEO_HARNESSES_CONFIG_PATH.
    Output: The loaded settings. Raises when the configuration is missing or invalid.
    """
    return current_settings()


def build_desktop_service(configuration: SettingsModel | None = None) -> DesktopService:
    """Purpose: Assemble the desktop use-case service with its stores.

    Input: Optional settings (defaults to the loaded process configuration).
    Output: A DesktopService that shares this configuration object with every module
    reading ``cleo.config.settings.settings``.
    """
    from cleo.desktop.service import DesktopService
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore

    configuration = configuration or load_configuration()
    return DesktopService(
        settings_model=configuration,
        store=SessionStore(configuration.MEMORY_DIR, configuration.SESSION_INDEX_PATH),
        runtime=Runtime(),
    )
