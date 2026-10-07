"""Golden-master snapshots with deterministic normalization of volatile values.

Generated identifiers, timestamps, durations, cursors and machine paths are replaced with
stable placeholders. The same raw value always maps to the same placeholder inside one
snapshot, so relationships ("this item belongs to that turn") stay visible and checked.

Set ``CLEO_UPDATE_GOLDEN=1`` to (re)record snapshots after an intentional behaviour change.
"""

from __future__ import annotations

import difflib
import json
import os
import re
from pathlib import Path
from typing import Any

import pytest

GOLDEN_DIR = Path(__file__).resolve().parents[1] / "golden"

_ISO_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
_RELATIVE_TIME = re.compile(r"^(?:刚刚|\d+ (?:分钟|小时|天)前)$")
_CLOCK_TIME = re.compile(r"^\d{1,2}:\d{2}$")
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
# Ordered from specific to generic so each kind keeps a readable label.
_ID_PATTERNS = (
    ("event", re.compile(r"\bevt_[0-9a-f]{32}\b")),
    ("thread", re.compile(r"\bcleo_[0-9a-f]{12}\b")),
    ("turn", re.compile(r"\bturn-[0-9a-f]{24}\b")),
    ("agent", re.compile(r"\bagent_[0-9a-f]{12,}\b")),
    ("acp-turn", re.compile(r"\bacp_[0-9a-f]{12}\b")),
    ("timing", re.compile(r"\btiming_[0-9a-f]{8,}\b")),
    ("notice", re.compile(r"\bnotice-[0-9a-f]{8}\b")),
    ("hex", re.compile(r"(?<![0-9A-Za-z])[0-9a-f]{12,64}(?![0-9A-Za-z])")),
)
_VOLATILE_NUMBER_KEYS = re.compile(
    r"(?:Ms|_ms|elapsed|duration|started|ended|mtime|size_bytes|pid)$", re.IGNORECASE)
_VOLATILE_TEXT_KEYS = {"cursor", "before", "after", "revision"}


class Normalizer:
    def __init__(self, replacements: dict[str, str] | None = None) -> None:
        # Longest first so a nested path is replaced before its parent.
        self._paths = sorted((replacements or {}).items(), key=lambda item: -len(item[0]))
        self._ids: dict[str, str] = {}
        self._counters: dict[str, int] = {}

    def _label(self, kind: str, raw: str) -> str:
        key = f"{kind}:{raw}"
        if key not in self._ids:
            self._counters[kind] = self._counters.get(kind, 0) + 1
            self._ids[key] = f"<{kind}:{self._counters[kind]}>"
        return self._ids[key]

    def text(self, value: str) -> str:
        for raw, placeholder in self._paths:
            for variant in {raw, raw.replace("\\", "/"), raw.replace("\\", "\\\\"),
                            raw.replace("/", "\\")}:
                if variant and variant in value:
                    value = value.replace(variant, placeholder)
        if "<" in value:
            # Path separators after a placeholder are platform noise.
            value = re.sub(r"(<(?:HOME|WORKSPACE|ROOT|USER|PYTHON|REPO)>)([^\s\"']*)",
                           lambda match: match.group(1) + match.group(2).replace("\\\\", "/")
                           .replace("\\", "/"), value)
        value = _ISO_TIME.sub("<time>", value)
        value = _UUID.sub(lambda match: self._label("uuid", match.group(0)), value)
        for kind, pattern in _ID_PATTERNS:
            value = pattern.sub(lambda match, kind=kind: self._label(kind, match.group(0)), value)
        return value

    def value(self, value: Any, key: str | None = None) -> Any:
        if isinstance(value, dict):
            # Keys can embed identifiers too (e.g. memory_state source ids).
            return {self.text(name): self.value(item, name) for name, item in value.items()}
        if isinstance(value, list):
            return [self.value(item, key) for item in value]
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            if key and _VOLATILE_NUMBER_KEYS.search(key):
                return "<number>"
            return value
        if isinstance(value, str):
            if key in _VOLATILE_TEXT_KEYS and value:
                return self._label(key, value)
            if _RELATIVE_TIME.match(value):
                return "<relative-time>"
            if key in {"time", "createdAt", "updatedAt"} and _CLOCK_TIME.match(value):
                return "<clock-time>"
            return self.text(value)
        return value


def normalize(data: Any, replacements: dict[str, str] | None = None) -> Any:
    return Normalizer(replacements).value(data)


def assert_golden(name: str, data: Any, replacements: dict[str, str] | None = None) -> Any:
    """Compare ``data`` (after normalization) with ``golden/<name>.json``."""
    actual = normalize(data, replacements)
    rendered = json.dumps(actual, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    path = GOLDEN_DIR / f"{name}.json"
    if os.environ.get("CLEO_UPDATE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered, encoding="utf-8", newline="\n")
        return actual
    if not path.exists():
        pytest.fail(f"Missing golden snapshot {path.name}; record it with CLEO_UPDATE_GOLDEN=1")
    expected = path.read_text(encoding="utf-8")
    if rendered != expected:
        diff = "".join(list(difflib.unified_diff(
            expected.splitlines(keepends=True), rendered.splitlines(keepends=True),
            fromfile=f"golden/{name}.json", tofile="actual",
        ))[:80])
        pytest.fail(
            f"Behaviour differs from golden snapshot {name}.json. If the change is intentional, "
            f"re-record with CLEO_UPDATE_GOLDEN=1 and review the diff.\n{diff}",
            pytrace=False,
        )
    return actual
