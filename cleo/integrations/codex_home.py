"""Cleo-owned Codex state, separate from the user's Codex app and CLI."""

import json
import sys
import tomllib
from dataclasses import replace

from openai_codex import CodexConfig


def isolated_codex_config(config: CodexConfig | None = None) -> CodexConfig:
    """Purpose: Isolate Codex state and supply an executable native Windows sandbox.

    Input: Optional client configuration, with explicit overrides taking precedence.
    Output: A copied configuration; shared state and saved settings remain untouched.
    """
    from cleo.integrations.harness_home import harness_environment, harness_home

    home = harness_home("codex")
    config = config or CodexConfig()
    defaults = ()
    if sys.platform == "win32":
        path = home / "config.toml"
        saved = tomllib.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        if not saved.get("windows", {}).get("sandbox"):
            # A workspace policy alone cannot execute agent commands on Windows.
            # Use the non-admin native sandbox; explicit overrides remain authoritative.
            defaults = ('windows.sandbox="unelevated"',)
    return replace(
        config,
        env=harness_environment("codex", config.env),
        config_overrides=(*defaults, *config.config_overrides,
                          f"sqlite_home={json.dumps(str(home))}"),
    )
