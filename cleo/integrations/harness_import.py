"""Copy the user's local Claude/Codex setup into Cleo's own harness directories.

Detects the external harness directory (``CLAUDE_CONFIG_DIR``/``CODEX_HOME`` or the
vendor default) and copies skills, agents, commands, rules, instructions and
settings that Cleo's directory does not have yet. The copy is additive:

- the external directory is only read, never modified;
- existing Cleo files, settings keys and skills are never overwritten;
- each imported item is recorded, so an item the user removes from Cleo's copy is
  not imported again; new external items are picked up on a later start;
- logins/credentials, plugins and session history are not copied.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import shutil
import threading
import tomllib
from datetime import date, datetime, time
from pathlib import Path
from secrets import token_hex
from typing import Any

logger = logging.getLogger(__name__)

STATE_FILE = ".cleo-imported.json"
_ENTRY_DIRECTORIES = {
    "claude": ("skills", "agents", "commands"),
    "codex": ("skills", "rules", "prompts"),
}
_FILES = {"claude": ("CLAUDE.md",), "codex": ("AGENTS.md",)}
# Keys that select credentials, login, billing or state locations, or depend on
# plugin caches that are not copied. Keeping them out avoids silently switching
# the account or provider that Cleo's own login uses.
_EXCLUDED_KEYS = {
    "claude": {
        "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod",
        "forceLoginOrgUUID", "otelHeadersHelper", "enabledPlugins", "extraKnownMarketplaces",
    },
    "codex": {
        "model_provider", "model_providers", "forced_login_method",
        "forced_chatgpt_workspace_id", "preferred_auth_method", "chatgpt_base_url",
        "cli_auth_credentials_store", "sqlite_home", "plugins", "marketplaces",
    },
}
_EXCLUDED_ENVIRONMENT = {
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME",
}
_BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")

_lock = threading.Lock()
_done: set[tuple[str, str]] = set()


def ensure_imported(harness: str, home: Path) -> None:
    """Purpose: Import the external setup once per process before a harness uses ``home``.

    Input: Harness family and Cleo's directory for it. Output: None; failures are logged
    and never block the harness.
    """
    key = (harness, str(home))
    with _lock:
        if key in _done:
            return
        _done.add(key)
        try:
            import_external(harness, home)
        except Exception:  # noqa: BLE001 - importing is best-effort by design.
            logger.warning("Importing the local %s setup failed", harness, exc_info=True)


def import_external(harness: str, home: Path, source: Path | None = None) -> list[str]:
    """Purpose: Copy missing external harness items into Cleo's directory.

    Input: Harness family, Cleo's directory and optionally the external directory.
    Output: Identifiers of items imported in this call.
    """
    from cleo.integrations.harness_home import external_home

    source = (source or external_home(harness)).expanduser()
    if not source.is_dir():
        return []
    try:
        if source.resolve() == home.resolve():
            return []
    except OSError:
        return []
    state_path = home / STATE_FILE
    state = _read_state(state_path)
    if state is None:
        # An unreadable or newer record must not be replaced with an empty one.
        logger.warning("Skipping %s import: unreadable %s", harness, state_path)
        return []
    records = state.setdefault("imported", {})
    if not isinstance(records, dict):
        logger.warning("Skipping %s import: unexpected %s", harness, state_path)
        return []
    done = set(records.get(str(source)) or [])
    imported: list[str] = []

    for directory in _ENTRY_DIRECTORIES[harness]:
        try:
            entries = sorted((source / directory).iterdir())
        except OSError:
            continue
        for entry in entries:
            # Hidden entries are vendor-managed (Codex ``.system``, Claude ``.trash``).
            if entry.name.startswith("."):
                continue
            item = f"{directory}/{entry.name}"
            if item not in done and _copy_missing(entry, home / directory / entry.name):
                imported.append(item)
    for name in _FILES[harness]:
        if name not in done and _copy_missing(source / name, home / name):
            imported.append(name)
    name, codec = _settings_codec(harness)
    imported += _merge_settings(
        source / name, home / name, done, codec, _relocator(harness, source, home),
    )

    if imported:
        records[str(source)] = sorted(done | set(imported))
        _write_atomic(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        logger.info("Imported %d local %s item(s) into %s", len(imported), harness, home)
    return imported


def _settings_codec(harness: str):
    if harness == "claude":
        return "settings.json", _json_settings
    return "config.toml", _toml_settings


def _relocator(harness: str, source: Path, home: Path):
    copied = [*_ENTRY_DIRECTORIES[harness], *_FILES[harness]]

    def relocate(value):
        # Settings that name copied skills/rules/instructions follow them to Cleo's copy;
        # other paths (installed programs, projects) are kept as written.
        if isinstance(value, dict):
            return {key: relocate(item) for key, item in value.items()}
        if isinstance(value, list):
            return [relocate(item) for item in value]
        if isinstance(value, str) and value:
            normalized = os.path.normcase(os.path.normpath(value))
            for name in copied:
                prefix = os.path.normcase(os.path.normpath(source / name))
                if normalized == prefix or normalized.startswith(prefix + os.sep):
                    return str(home / name) + os.path.normpath(value)[len(prefix):]
        return value

    return relocate


def _record(home: Path, source: Path, items: list[str]) -> None:
    """Remember explicit imports so automatic import stays consistent with them."""
    if not items:
        return
    state_path = home / STATE_FILE
    state = _read_state(state_path)
    if state is None or not isinstance(state.setdefault("imported", {}), dict):
        return
    records = state["imported"]
    records[str(source)] = sorted(set(records.get(str(source)) or []) | set(items))
    _write_atomic(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")


# --- Explicit comparison and two-way copy (Settings -> Import) ----------------------------

_MAX_DIGEST_BYTES = 64 * 1024 * 1024


def _digest(path: Path) -> str | None:
    """Content digest of a file or directory tree; None when unreadable or too large."""
    digest = hashlib.sha256()
    total = 0
    try:
        files = [path] if path.is_file() else sorted(
            item for item in path.rglob("*") if item.is_file()
        )
        for item in files:
            relative = "" if item == path else item.relative_to(path).as_posix()
            data = item.read_bytes()
            total += len(data)
            if total > _MAX_DIGEST_BYTES:
                return None
            digest.update(relative.encode("utf-8") + b"\0" + data + b"\0")
    except OSError:
        return None
    return digest.hexdigest()


def _entries(root: Path, harness: str) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for directory in _ENTRY_DIRECTORIES[harness]:
        try:
            children = sorted((root / directory).iterdir())
        except OSError:
            continue
        for child in children:
            if not child.name.startswith("."):
                found[f"{directory}/{child.name}"] = child
    for name in _FILES[harness]:
        if (root / name).is_file():
            found[name] = root / name
    return found


def _valid_item(harness: str, item: str) -> bool:
    if not isinstance(item, str):
        return False
    if item in _FILES[harness]:
        return True
    directory, _, name = item.partition("/")
    return (directory in _ENTRY_DIRECTORIES[harness] and bool(name) and not name.startswith(".")
            and "/" not in name and "\\" not in name and ":" not in name)


def sync_status(harness: str, home: Path, source: Path | None = None) -> dict[str, Any]:
    """Purpose: Compare Cleo's harness directory with the user's local harness setup.

    Input: Harness family, Cleo's directory and optionally the local directory.
    Output: Per-item state (same/different/local_only/cleo_only) and settings Cleo lacks.
    """
    from cleo.integrations.harness_home import external_home

    source = (source or external_home(harness)).expanduser()
    local = _entries(source, harness) if source.is_dir() else {}
    cleo = _entries(home, harness) if home.is_dir() else {}
    items = []
    for item in sorted(set(local) | set(cleo)):
        directory, _, name = item.rpartition("/")
        if item not in cleo:
            state = "local_only"
        elif item not in local:
            state = "cleo_only"
        else:
            same = _digest(local[item])
            state = "same" if same is not None and same == _digest(cleo[item]) else "different"
        items.append({"id": item, "kind": directory or "instructions", "name": name,
                      "state": state})
    settings_name, codec = _settings_codec(harness)
    missing: list[str] = []
    read, _write, excluded = codec()
    try:
        external = read((source / settings_name).read_text(encoding="utf-8-sig"))
        target = home / settings_name
        text = target.read_text(encoding="utf-8-sig") if target.exists() else ""
        current = read(text) if text.strip() else {}
        if isinstance(external, dict) and isinstance(current, dict):
            missing = [".".join(path) for path in _missing_settings(
                external, current, set(), settings_name, excluded)]
    except (OSError, ValueError, UnicodeError):
        pass
    return {
        "harness": harness, "localPath": str(source), "localExists": source.is_dir(),
        "cleoPath": str(home), "items": items,
        "settings": {"file": settings_name, "missingInCleo": missing},
    }


def sync_items(
    harness: str, home: Path, direction: str, items: list[str], *, settings: bool = False,
    source: Path | None = None,
) -> dict[str, list[str]]:
    """Purpose: Copy chosen items between Cleo and the local harness at the user's request.

    Input: ``direction`` is ``import`` (local -> Cleo) or ``export`` (Cleo -> local);
    ``settings`` also merges local settings Cleo lacks (import only).
    Output: Copied and skipped item IDs. Existing files on the target side are never
    overwritten; credentials, plugins and history are never part of the item set.
    """
    from cleo.integrations.harness_home import external_home

    if direction not in {"import", "export"}:
        raise ValueError("direction must be import or export")
    if settings and direction != "import":
        raise ValueError("设置只能从本机导入 Cleo。")
    source = (source or external_home(harness)).expanduser()
    if not source.is_dir():
        raise ValueError(f"本机未找到 {harness} 目录：{source}")
    invalid = [item for item in items if not _valid_item(harness, item)]
    if invalid:
        raise ValueError(f"不支持的项目：{', '.join(map(str, invalid[:5]))}")
    origin, target = (source, home) if direction == "import" else (home, source)
    copied: list[str] = []
    skipped: list[str] = []
    for item in dict.fromkeys(items):
        if _copy_missing(origin / item, target / item):
            copied.append(item)
        else:
            skipped.append(item)
    if settings:
        name, codec = _settings_codec(harness)
        copied += _merge_settings(
            source / name, home / name, set(), codec, _relocator(harness, source, home),
        )
    if direction == "import":
        _record(home, source, copied)
    return {"copied": copied, "skipped": skipped}


def _read_state(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return {"version": 1, "imported": {}}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(state, dict) or not isinstance(state.get("version"), int):
        return None
    if state["version"] > 1:
        return None
    return state


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".cleo-import-{token_hex(6)}.tmp")
    try:
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _copy_missing(source: Path, target: Path) -> bool:
    """Copy a file or directory only if the target does not exist; never overwrite."""
    if not source.exists() or target.exists() or target.is_symlink():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".cleo-import-{token_hex(6)}")
    try:
        if source.is_dir():
            shutil.copytree(source, temporary)
        else:
            shutil.copy2(source, temporary)
        if target.exists():
            return False
        os.rename(temporary, target)
        return True
    except OSError:
        logger.warning("Could not import %s", source, exc_info=True)
        return False
    finally:
        if temporary.is_dir():
            shutil.rmtree(temporary, ignore_errors=True)
        elif temporary.exists():
            temporary.unlink(missing_ok=True)


def _missing_settings(
    external: dict[str, Any], current: dict[str, Any], done: set[str], prefix: str,
    excluded: set[str],
) -> dict[tuple[str, ...], Any]:
    """Top-level keys, and entries of shared tables, that Cleo's settings lack."""
    missing: dict[tuple[str, ...], Any] = {}
    for key, value in external.items():
        if key in excluded:
            continue
        if key == "env" and isinstance(value, dict):
            value = {k: v for k, v in value.items() if k not in _EXCLUDED_ENVIRONMENT}
            if not value:
                continue
        if key not in current:
            if f"{prefix}:{key}" not in done:
                missing[(key,)] = value
        elif isinstance(value, dict) and isinstance(current[key], dict):
            for child, child_value in value.items():
                if child not in current[key] and f"{prefix}:{key}.{child}" not in done:
                    missing[(key, child)] = child_value
    return missing


def _merge_settings(source: Path, target: Path, done: set[str], codec, relocate) -> list[str]:
    if not source.is_file():
        return []
    read, write, excluded = codec()
    try:
        external = read(source.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError):
        logger.warning("Skipping unreadable %s", source)
        return []
    try:
        text = target.read_text(encoding="utf-8-sig") if target.exists() else ""
        current = read(text) if text.strip() else {}
    except (OSError, ValueError, UnicodeError):
        # Cleo's own settings are unreadable: leave them untouched.
        logger.warning("Skipping settings import into unreadable %s", target)
        return []
    if not isinstance(external, dict) or not isinstance(current, dict):
        return []
    missing = {
        path: relocate(value)
        for path, value in _missing_settings(external, current, done, source.name, excluded).items()
    }
    if not missing:
        return []
    written = write(text, current, missing)
    if written is None:
        return []
    result, applied = written
    _write_atomic(target, result)
    return [f"{source.name}:{'.'.join(path)}" for path in applied]


# --- Claude settings.json -----------------------------------------------------------------


def _json_settings():
    return json.loads, _write_json, _EXCLUDED_KEYS["claude"]


def _write_json(_text, current, missing):
    merged = dict(current)
    for path, value in missing.items():
        if len(path) == 1:
            merged[path[0]] = value
        else:
            merged[path[0]] = {**merged[path[0]], path[1]: value}
    return json.dumps(merged, ensure_ascii=False, indent=2) + "\n", list(missing)


# --- Codex config.toml --------------------------------------------------------------------


def _toml_settings():
    return tomllib.loads, _write_toml, _EXCLUDED_KEYS["codex"]


def _toml_key(key: str) -> str:
    return key if _BARE_KEY.fullmatch(key) else json.dumps(key)


def _toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if math.isinf(value):
            return "inf" if value > 0 else "-inf"
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(_toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(
            f"{_toml_key(k)} = {_toml_value(v)}" for k, v in value.items()
        ) + " }"
    raise ValueError(f"Unsupported TOML value: {type(value).__name__}")


def _write_toml(text, current, missing):
    """Append missing entries without reformatting the user's file; verify by parsing."""
    head: list[str] = []
    tail: list[str] = []
    applied: list[tuple[str, ...]] = []
    expected = json.loads(json.dumps(current, default=str))
    try:
        for path, value in missing.items():
            if len(path) == 1:
                key = path[0]
                if isinstance(value, dict):
                    tail.append(f"\n[{_toml_key(key)}]")
                    tail += [f"{_toml_key(k)} = {_toml_value(v)}" for k, v in value.items()]
                else:
                    head.append(f"{_toml_key(key)} = {_toml_value(value)}")
                expected[key] = value
                applied.append(path)
            elif isinstance(value, dict):
                header = ".".join(_toml_key(part) for part in path)
                tail.append(f"\n[{header}]")
                tail += [f"{_toml_key(k)} = {_toml_value(v)}" for k, v in value.items()]
                expected[path[0]] = {**expected[path[0]], path[1]: value}
                applied.append(path)
            # A scalar inside an existing table cannot be appended safely; skip it.
    except ValueError:
        return None
    if not applied:
        return None
    parts = []
    if head:
        parts.append("# Imported by Cleo from the local Codex configuration.\n"
                     + "\n".join(head) + "\n")
    parts.append(text if not text or text.endswith("\n") else text + "\n")
    if tail:
        parts.append("\n# Imported by Cleo from the local Codex configuration."
                     + "\n".join(tail) + "\n")
    result = "".join(parts)
    try:
        parsed = tomllib.loads(result)
    except ValueError:
        return None
    if json.dumps(parsed, sort_keys=True, default=str) != json.dumps(
        expected, sort_keys=True, default=str,
    ):
        return None
    return result, applied
