"""Local model-profile configuration used by the desktop settings UI."""

from __future__ import annotations

import json
import os
import re
import secrets
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
                "displayName": str(profile.get("display_name") or name),
                "models": list(dict.fromkeys([profile["model"], *profile.get("models", [])])),
                "provider": str(profile.get("provider") or ""),
                "model": str(profile.get("model") or ""),
                "baseUrl": profile.get("base_url"),
                "maxTokens": int(profile.get("max_tokens") or 100_000),
                "hasApiKey": bool(str(profile.get("api_key") or "").strip()),
                "backend": profile.get("backend", "api"),
                "executable": profile.get("executable") or "",
            }
            for name, profile in sorted(agents.items())
            if isinstance(profile, dict)
        ],
        "activeAgent": str(active.get("agent") or ""),
        "activeDreamAgent": str(active.get("dream_agent") or ""),
        "activeDreamModel": str(active.get("dream_model") or agents.get(
            active.get("dream_agent"), {}
        ).get("model") or ""),
        "dreamEnabled": active.get("dream_enabled", True),
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
    backend = str(profile.get("backend") or "api")
    if backend != "api":
        api_key = ""
    if backend == "api" and not api_key:
        raise ValueError("新增模型 Profile 时必须提供 API Key。")

    candidate = {
        "provider": str(profile.get("provider") or "").strip(),
        "model": str(profile.get("model") or "").strip(),
        "api_key": api_key,
        "base_url": str(profile.get("baseUrl") or "").strip() or None,
        "max_tokens": int(profile.get("maxTokens") or 100_000),
        "temperature": float(existing.get("temperature", 0.7)),
        "backend": backend,
        "executable": str(profile.get("executable") or "").strip() or None,
        "models": profile.get("models", existing.get("models", [])),
        "display_name": (
            _connection_label(profile["displayName"], agents, name)
            if "displayName" in profile else existing.get("display_name")
        ),
    }
    validated = AgentProfile.model_validate(candidate)
    agents[name] = {
        "provider": validated.provider,
        "model": validated.model,
        "api_key": api_key,
        "base_url": validated.base_url,
        "max_tokens": validated.max_tokens,
        "temperature": validated.temperature,
        "backend": validated.backend,
        "executable": validated.executable,
        "models": validated.models,
        "display_name": validated.display_name,
    }
    active = raw.setdefault("active_profiles", {})
    if bool(profile.get("activateAgent")):
        active["agent"] = name
    if bool(profile.get("activateDreamAgent")):
        active["dream_agent"] = name
        active["dream_model"] = validated.model
        active["dream_enabled"] = True
    _atomic_write(path, raw)
    return read_model_settings(path)


def save_dream_settings(
    config_path: Path | str, selection: str, model: str | None = None,
) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    raw = _read_config(path)
    modes = {"mode:follow", "mode:disabled"}
    if selection not in modes and selection not in raw["profiles"]["agents"]:
        raise ValueError("Unknown DreamAgent profile")
    active = raw.setdefault("active_profiles", {})
    active["dream_enabled"] = selection != "mode:disabled"
    active["dream_agent"] = None if selection in modes else selection
    if selection in modes:
        active["dream_model"] = None
    else:
        profile = AgentProfile.model_validate(raw["profiles"]["agents"][selection])
        selected_model = model or profile.model
        if selected_model not in profile.available_models:
            raise ValueError("模型不属于所选连接。")
        active["dream_model"] = selected_model
    _atomic_write(path, raw)
    return read_model_settings(path)


def create_model_connection(config_path: Path | str, connection: dict[str, Any]) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    raw = _read_config(path)
    agents = raw["profiles"]["agents"]
    label = _connection_label(connection.get("displayName"), agents)
    models = connection.get("models")
    if not isinstance(models, list) or not models or any(
        not isinstance(value, str) or not value.strip() for value in models
    ):
        raise ValueError("请至少选择或填写一个模型。")
    models = list(dict.fromkeys(value.strip() for value in models))
    profile = AgentProfile(
        backend=connection.get("backend", "api"), provider=connection["provider"],
        model=models[0], models=models, display_name=label,
        api_key=connection.get("apiKey") or "", base_url=connection.get("baseUrl") or None,
        executable=connection.get("executable") or None,
    )
    identifier = f"connection_{secrets.token_hex(8)}"
    if identifier in agents:
        raise ValueError("连接编号冲突，请重试。")
    agents[identifier] = {
        **profile.model_dump(mode="json", exclude={"api_key"}),
        "api_key": profile.api_key.get_secret_value(),
    }
    _atomic_write(path, raw)
    return read_model_settings(path)


def select_chat_model(config_path: Path | str, profile_id: str, model: str) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    raw = _read_config(path)
    agents = raw["profiles"]["agents"]
    if profile_id not in agents:
        raise ValueError("模型连接不存在。")
    profile = AgentProfile.model_validate(agents[profile_id])
    if model not in profile.available_models:
        raise ValueError("模型不属于所选连接。")
    active = raw["active_profiles"]
    if active.get("dream_agent") == profile_id and not active.get("dream_model"):
        active["dream_model"] = profile.model
    agents[profile_id]["models"] = profile.available_models
    agents[profile_id]["model"] = model
    active["agent"] = profile_id
    _atomic_write(path, raw)
    return read_model_settings(path)


def rename_model_connection(config_path: Path | str, profile_id: str, label: str) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    raw = _read_config(path)
    agents = raw["profiles"]["agents"]
    if profile_id not in agents:
        raise ValueError("模型连接不存在。")
    agents[profile_id]["display_name"] = _connection_label(label, agents, profile_id)
    _atomic_write(path, raw)
    return read_model_settings(path)


def remove_model_connection(config_path: Path | str, profile_id: str) -> dict[str, Any]:
    path = Path(config_path).expanduser().resolve()
    raw = _read_config(path)
    active = raw["active_profiles"]
    if profile_id in {active.get("agent"), active.get("dream_agent")}:
        raise ValueError("这个连接正在被使用。切换所用模型后，才可移除。")
    if profile_id not in raw["profiles"]["agents"]:
        raise ValueError("模型连接不存在。")
    del raw["profiles"]["agents"][profile_id]
    _atomic_write(path, raw)
    return read_model_settings(path)


def _connection_label(value: Any, agents: dict, exclude: str | None = None) -> str:
    label = str(value or "").strip()
    if not label or len(label) > 80:
        raise ValueError("连接名称需要 1–80 个字符。")
    if any(
        str(profile.get("display_name") or name).casefold() == label.casefold()
        for name, profile in agents.items() if name != exclude
    ):
        raise ValueError("这个连接名称已被使用。")
    return label


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
