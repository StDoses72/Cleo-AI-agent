"""One native state directory for each harness, independent of project cwd."""

from __future__ import annotations

import os
from pathlib import Path

HOME_VARIABLES = {"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR"}


def external_home(harness: str) -> Path:
    """Resolve the inherited native home without creating or reading it."""
    if harness not in HOME_VARIABLES:
        raise ValueError(f"Unknown harness home: {harness!r}")
    value = os.environ.get(HOME_VARIABLES[harness], "").strip()
    return (Path(value).expanduser() if value else Path.home() / f".{harness}").resolve()


def harness_home(harness: str, *, create: bool = True) -> Path:
    """Use native state everywhere; safely publish recoverable legacy files on first use."""
    home = external_home(harness)
    if create:
        home.mkdir(parents=True, exist_ok=True)
        from cleo.config.settings import APP_HOME
        from cleo.integrations.harness_migration import ensure_migrated

        ensure_migrated(harness, APP_HOME / "data" / harness, home)
    return home


def harness_environment(harness: str, env: dict[str, str] | None = None) -> dict[str, str]:
    """Copy the caller environment and use the same resolved home as login and discovery."""
    return {**(env or {}), HOME_VARIABLES[harness]: str(harness_home(harness))}


def claude_session_is_external(native_id: str | None) -> bool:
    """Compatibility for saved runtime state: every session now uses the native home."""
    return False


def claude_environment(
    env: dict[str, str] | None = None, *, external: bool = False,
) -> dict[str, str]:
    """Legacy runtime flags cannot switch the login or state directory."""
    return harness_environment("claude", env)


CLAUDE_LOGIN_HINT = (
    "Cleo 与原生 Claude Code 共用登录和配置目录。"
    "请在原生 Claude Code 或“设置 → 模型 → 新增连接 → 账号登录”中检查登录。"
)
