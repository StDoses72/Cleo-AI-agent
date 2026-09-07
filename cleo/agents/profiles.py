"""Resolve saved chat choices without persisting credentials in session manifests."""

from typing import Any

from cleo.config.settings import AgentProfile


def profile_snapshot(profile: AgentProfile) -> dict[str, Any]:
    return profile.model_dump(mode="json", exclude={"api_key"})


def session_profile(settings: Any, manifest: dict[str, Any]) -> AgentProfile:
    options = manifest.get("runtime_options") or {}
    name = options.get("agent_profile") or settings.active_profiles.agent
    profile = settings.profiles.agents.get(name)
    if profile is None:
        raise ValueError(f"Session model profile {name!r} is no longer configured")
    snapshot = options.get("chat_profile")
    if not snapshot:
        return profile
    # Credentials can rotate, but a connection cannot silently become another provider.
    if (snapshot.get("backend", "api"), snapshot["provider"], snapshot.get("base_url")) != (
        profile.backend,
        profile.provider,
        profile.base_url,
    ):
        raise ValueError("This session's connection changed. Restore it or create a new chat.")
    return AgentProfile.model_validate({**snapshot, "api_key": profile.api_key})


def dream_profile(settings: Any, manifest: dict[str, Any]) -> AgentProfile:
    name = settings.active_profiles.dream_agent
    if name:
        return settings.profiles.agents[name]
    if manifest.get("space") == "productivity" and not (manifest.get("runtime_options") or {}).get(
        "agent_profile"
    ):
        raise ValueError("Select a DreamAgent profile to consolidate a Productivity session.")
    return session_profile(settings, manifest)
