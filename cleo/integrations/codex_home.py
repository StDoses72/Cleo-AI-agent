"""Cleo-owned Codex state, separate from the user's Codex app and CLI."""

import json
from dataclasses import replace

from openai_codex import CodexConfig

from cleo.config.settings import APP_HOME


def isolated_codex_config(config: CodexConfig | None = None) -> CodexConfig:
    home = (APP_HOME / "data" / "codex").resolve()
    home.mkdir(parents=True, exist_ok=True)
    config = config or CodexConfig()
    return replace(
        config,
        env={**(config.env or {}), "CODEX_HOME": str(home), "CODEX_SQLITE_HOME": str(home)},
        config_overrides=(*config.config_overrides, f"sqlite_home={json.dumps(str(home))}"),
    )
