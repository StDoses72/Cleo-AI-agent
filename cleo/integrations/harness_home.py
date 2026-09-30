"""Fixed, Cleo-owned state directories for coding harnesses.

Each harness keeps its login, configuration, native sessions and user skills in
``<CLEO_HOME>/data/<harness>``. The directory is stable across sessions and
Cleo versions. It holds harness state only: agents still work in the project the
user selected, and permissions still follow the session's chosen mode.

Skills, instructions and settings from the user's own harness directory are copied
in once (see ``harness_import``); logins are not. Sessions created before isolation
stay in the user's own harness directory; nothing is moved or deleted there.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

HOME_VARIABLES = {"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR"}
_NATIVE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def harness_home(harness: str, *, create: bool = True) -> Path:
    """Purpose: Locate the one state directory every entry point uses for a harness.

    Input: Harness family (``codex`` or ``claude``); ``create`` makes the directory and,
    once per process, copies the user's local harness setup into it (additive only).
    Output: Absolute ``<CLEO_HOME>/data/<harness>`` path.
    """
    if harness not in HOME_VARIABLES:
        raise ValueError(f"Unknown harness home: {harness!r}")
    from cleo.config.settings import APP_HOME

    home = (APP_HOME / "data" / harness).resolve()
    if create:
        home.mkdir(parents=True, exist_ok=True)
        from cleo.integrations.harness_import import ensure_imported

        ensure_imported(harness, home)
    return home


def external_home(harness: str) -> Path:
    """Purpose: Locate the user's own harness directory (import source, legacy sessions).

    Input: Harness family. Output: Inherited override or the vendor default under the home.
    """
    value = os.environ.get(HOME_VARIABLES[harness])
    return Path(value).expanduser() if value else Path.home() / f".{harness}"


def harness_environment(harness: str, env: dict[str, str] | None = None) -> dict[str, str]:
    """Purpose: Point a harness process at Cleo's directory without changing ``os.environ``.

    Input: Harness family and an optional base environment (copied, never mutated).
    Output: New environment with the harness home variables set.
    """
    home = str(harness_home(harness))
    extra = {"CODEX_SQLITE_HOME": home} if harness == "codex" else {}
    return {**(env or {}), HOME_VARIABLES[harness]: home, **extra}


def _has_claude_session(home: Path, native_id: str) -> bool:
    try:
        return any((home / "projects").glob(f"*/{native_id}.jsonl"))
    except OSError:
        return False


def claude_session_is_external(native_id: str | None) -> bool:
    """Purpose: Keep resumable history for Claude sessions created before isolation.

    Input: Claude native session ID, or None for a new session.
    Output: True only when the transcript exists in the user's own Claude directory
    and not in Cleo's; such sessions keep using that directory in place.
    """
    if not native_id or not _NATIVE_ID.fullmatch(native_id):
        return False
    if _has_claude_session(harness_home("claude", create=False), native_id):
        return False
    return _has_claude_session(external_home("claude"), native_id)


def claude_environment(
    env: dict[str, str] | None = None, *, external: bool = False,
) -> dict[str, str]:
    """Purpose: Build the Claude process environment for Cleo's or a legacy session's home.

    Input: Optional base environment and whether the session predates isolation.
    Output: Copied environment; legacy sessions keep the inherited Claude directory.
    """
    if external:
        return dict(env or {})
    return harness_environment("claude", env)


CLAUDE_LOGIN_HINT = (
    "Cleo 的 Claude 使用独立目录，不读取外部 Claude 登录。"
    "请在“设置 → 模型 → 新增连接 → 账号登录 → Claude Code”中登录。"
)
