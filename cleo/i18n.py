"""Localize application-owned messages without changing user or model content."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

_messages = json.loads(Path(__file__).with_name("locales.json").read_text(encoding="utf-8"))
_language: ContextVar[str | Callable[[], str]] = ContextVar("ui_language", default="zh-CN")


def get_language() -> str:
    selected = _language.get()
    return selected() if callable(selected) else selected


@contextmanager
def language_context(language: str | Callable[[], str]) -> Iterator[None]:
    token = _language.set(language)
    try:
        yield
    finally:
        _language.reset(token)


def tr(key: str, **params: object) -> str:
    entry = _messages[key]
    text = entry.get(get_language(), entry["en"])
    return re.sub(r"\{(\w+)\}", lambda match: str(params[match[1]])
                  if match[1] in params else match[0], text)
