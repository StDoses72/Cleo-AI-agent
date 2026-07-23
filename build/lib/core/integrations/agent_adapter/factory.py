from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from openai_codex import ApprovalMode, Sandbox

from core.integrations.agent_adapter.acp import AcpAgentSpec, AcpProvider
from core.integrations.agent_adapter.adapter import AgentAdapter
from core.integrations.agent_adapter.claude import ClaudeProvider
from core.integrations.agent_adapter.codex import CodexProvider
from core.integrations.agent_adapter.provider import AgentProvider
from core.memory.session_store import SessionStore

if TYPE_CHECKING:
    from config.settings import ProductivityProviderSettings, ProductivitySettings


def create_provider(
    name: str,
    settings: ProductivityProviderSettings,
) -> AgentProvider:
    """Create one harness provider from its validated configuration."""
    if settings.type == "codex_sdk":
        options = settings.options
        return CodexProvider(
            default_model=settings.model,
            name=name,
            approval_mode=ApprovalMode(options.approval_mode),
            sandbox=Sandbox(options.sandbox),
        )
    if settings.type == "claude_sdk":
        return ClaudeProvider(
            default_model=settings.model,
            permission_mode=settings.options.permission_mode,
            name=name,
        )
    if settings.type == "acp":
        options = settings.options
        return AcpProvider(
            name=name,
            spec=AcpAgentSpec(
                command=options.command,
                args=tuple(options.args),
                env=dict(options.env),
                auth_method=options.auth_method,
                auto_approve=options.auto_approve,
                model_config_id=options.model_config_id,
            ),
        )
    raise TypeError(f"Unsupported productivity provider settings: {type(settings)!r}")


def build_agent_adapter(
    project_root: str | Path,
    productivity: ProductivitySettings,
    *,
    session_store: SessionStore | None = None,
    space: str = "productivity",
    owner_type: str = "agent",
) -> AgentAdapter:
    """Build an AgentAdapter and register every enabled configured provider."""
    adapter = AgentAdapter(
        project_root,
        session_store=session_store,
        space=space,
        owner_type=owner_type,
    )
    for name, provider_settings in productivity.providers.items():
        if provider_settings.enabled:
            adapter.register(create_provider(name, provider_settings))
    return adapter
