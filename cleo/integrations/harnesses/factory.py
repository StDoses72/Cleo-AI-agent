from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from openai_codex import Sandbox

from cleo.harnesses.adapter import AgentAdapter
from cleo.harnesses.provider import AgentProvider
from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.sessions.store import SessionStore

if TYPE_CHECKING:
    from cleo.config.settings import ProductivityProviderSettings, ProductivitySettings


def create_provider(
    name: str,
    settings: ProductivityProviderSettings,
) -> AgentProvider:
    """Create one harness provider from its validated configuration.

    根据配置类型实例化对应的 provider(CodexProvider / ClaudeProvider /
    AcpProvider)。由 ``build_agent_adapter`` 及测试
    (tests/integrations/test_harness_factory.py) 调用。
    参数:
        name: provider 名称, 来自 ``ProductivitySettings.providers`` 的 key。
        settings: 已校验的 provider 配置(pydantic settings), 由
            ``build_agent_adapter`` 遍历传入。
    返回:
        实现 ``AgentProvider`` 协议的 provider 实例; 未知 ``settings.type``
        时抛 ``TypeError``。
    """
    if settings.type == "codex_sdk":
        options = settings.options
        return CodexProvider(
            default_model=settings.model,
            name=name,
            approval_mode=options.approval_mode,
            sandbox=Sandbox(options.sandbox),
        )
    if settings.type == "claude_sdk":
        return ClaudeProvider(
            default_model=settings.model,
            permission_mode=settings.options.permission_mode,
            name=name,
            models=tuple(settings.models),
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
    """Build an AgentAdapter and register every enabled configured provider.

    由 CLI productivity 入口(cleo/cli/productivity.py:544)及测试调用。
    参数:
        project_root: 项目根目录, 由 CLI 传入, 作为 adapter 的工作根。
        productivity: 全局 productivity 配置, 遍历其中 enabled 的 providers
            并逐一 ``create_provider`` 注册。
        session_store: 可选会话存储, 由调用方注入; None 时 adapter 自建。
        space / owner_type: adapter 的会话空间与属主标识, 通常用默认值。
    返回:
        已注册全部启用 provider 的 ``AgentAdapter``, 由 CLI 会话循环消费。
    """
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
