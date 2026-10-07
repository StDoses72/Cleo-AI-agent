"""Build the desktop backend from explicitly loaded settings.

Entry points call these functions instead of relying on import-time globals. Loading the
configuration here, at startup, keeps the existing failure mode: a missing or invalid
configuration stops the process before it serves any request.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cleo.config.settings import SettingsModel, current_settings

if TYPE_CHECKING:
    from cleo.config.service import ConfigService
    from cleo.desktop.service import DesktopService


def load_configuration() -> SettingsModel:
    """Purpose: Load (once) and return the process configuration.

    Input: None; paths come from CLEO_HOME / CLEO_CONFIG_PATH / CLEO_HARNESSES_CONFIG_PATH.
    Output: The loaded settings. Raises when the configuration is missing or invalid.
    """
    return current_settings()


def build_config_service() -> ConfigService:
    """Purpose: Load the configuration and wrap it for hot reload.

    Input: None. Output: A ConfigService holding snapshot version 1. Raises at startup when
    the configuration is missing or invalid, as before.
    """
    from cleo.config.service import ConfigService

    return ConfigService(initial=load_configuration())


def build_desktop_service(config: ConfigService | None = None) -> DesktopService:
    """Purpose: Assemble the desktop use-case service with its stores.

    Input: Optional ConfigService (built here when omitted). Output: A DesktopService that
    reads settings through ``cleo.config.settings.settings``, so it always sees the current
    snapshot, or the run-bound one while a turn runs.
    """
    from cleo.config.settings import settings
    from cleo.desktop.service import DesktopService
    from cleo.runtime.state import Runtime
    from cleo.sessions.store import SessionStore

    config = config or build_config_service()
    configuration = config.snapshot.settings
    return DesktopService(
        settings_model=settings,
        store=SessionStore(configuration.MEMORY_DIR, configuration.SESSION_INDEX_PATH),
        runtime=Runtime(),
        config=config,
    )
