"""Local model-profile configuration used by the desktop settings UI."""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from cleo.config.settings import AgentProfile

_PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def read_model_settings(config_path: Path | str) -> dict[str, Any]:
    raw = _read_config(config_path)
    agents = raw.get("profiles", {}).get("agents", {})
    active = raw.get("active_profiles", {})
    return {
        "profiles": [
            {
                "name": name,
                "provider": str(profile.get("provider") or ""),
                "model": str(profile.get("model") or ""),
                "baseUrl": profile.get("base_url"),
                "maxTokens": int(profile.get("max_tokens") or 100_000),
                "hasApiKey": bool(str(profile.get("api_key") or "").strip()),
            }
            for name, profile in sorted(agents.items())
            if isinstance(profile, dict)
        ],
        "activeAgent": str(active.get("agent") or ""),
        "activeDreamAgent": str(active.get("dream_agent") or active.get("agent") or ""),
    }


def save_model_profile(config_path: Path | str, profile: dict[str, Any]) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    raw = _read_config(path)
    name = str(profile.get("name") or "").strip()
    if not _PROFILE_NAME.fullmatch(name):
        raise ValueError("Profile 名称只能包含字母、数字、下划线和连字符，且最长 64 位。")

    agents = raw.setdefault("profiles", {}).setdefault("agents", {})
    existing = agents.get(name) if isinstance(agents.get(name), dict) else {}
    api_key = str(profile.get("apiKey") or "").strip() or str(existing.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("新增模型 Profile 时必须提供 API Key。")

    candidate = {
        "provider": str(profile.get("provider") or "").strip(),
        "model": str(profile.get("model") or "").strip(),
        "api_key": api_key,
        "base_url": str(profile.get("baseUrl") or "").strip() or None,
        "max_tokens": int(profile.get("maxTokens") or 100_000),
        "temperature": float(existing.get("temperature", 0.7)),
    }
    validated = AgentProfile.model_validate(candidate)
    agents[name] = {
        "provider": validated.provider,
        "model": validated.model,
        "api_key": api_key,
        "base_url": validated.base_url,
        "max_tokens": validated.max_tokens,
        "temperature": validated.temperature,
    }
    active = raw.setdefault("active_profiles", {})
    if bool(profile.get("activateAgent")):
        active["agent"] = name
    if bool(profile.get("activateDreamAgent")):
        active["dream_agent"] = name
    _atomic_write(path, raw)
    return read_model_settings(path)


def _read_config(config_path: Path | str) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    with path.open(encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise ValueError("Cleo 配置必须是 JSON object。")
    return raw


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
