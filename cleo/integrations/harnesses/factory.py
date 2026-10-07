from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from openai_codex import Sandbox

from cleo.harnesses.adapter import AgentAdapter
from cleo.harnesses.capabilities import Capability, capabilities_of
from cleo.harnesses.provider import AgentProvider
from cleo.integrations.harnesses.acp import AcpAgentSpec, AcpProvider
from cleo.integrations.harnesses.claude import ClaudeProvider
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.sessions.store import SessionStore

if TYPE_CHECKING:
    from cleo.config.settings import ProductivityProviderSettings, ProductivitySettings


_PROVIDER_CLASSES = {
    "codex_sdk": CodexProvider,
    "claude_sdk": ClaudeProvider,
    "acp": AcpProvider,
}


def provider_capabilities(provider_type: str | None) -> frozenset[Capability]:
    """Purpose: What a configured harness type can do, as its provider class declares.

    Input: ``ProductivityProviderSettings.type``. Output: The capabilities; none for an
    unknown type.
    """
    provider_class = _PROVIDER_CLASSES.get(provider_type or "")
    return capabilities_of(provider_class) if provider_class is not None else frozenset()


def create_provider(
    name: str,
    settings: ProductivityProviderSettings,
    *,
    memory_mcp: MemoryMcp | None = None,
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
            memory_mcp=memory_mcp,
            name=name,
            approval_mode=options.approval_mode,
            sandbox=Sandbox(options.sandbox),
        )
    if settings.type == "claude_sdk":
        return ClaudeProvider(
            default_model=settings.model,
            memory_mcp=memory_mcp,
            permission_mode=settings.options.permission_mode,
            name=name,
            models=tuple(settings.models),
        )
    if settings.type == "acp":
        options = settings.options
        return AcpProvider(
            memory_mcp=memory_mcp,
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
    computer_config_path: Path | None = None,
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
    from cleo.memory.reader import preference_context

    memory_root = (
        session_store.memory_root if session_store is not None else Path(project_root) / "memory"
    )
    adapter = AgentAdapter(
        project_root,
        session_store=session_store,
        space=space,
        owner_type=owner_type,
        memory_context=lambda selected_space, project: preference_context(
            memory_root, selected_space, project),
    )
    memory_mcp = MemoryMcp(
        session_store.memory_root if session_store is not None else Path(project_root) / "memory",
        session_store.index_path if session_store is not None else None,
        computer_config_path=computer_config_path,
    )
    adapter.memory_mcp = memory_mcp
    adapter.provider_settings = {}
    sync_providers(adapter, productivity)
    return adapter


def sync_providers(adapter: AgentAdapter, productivity: ProductivitySettings) -> list[str]:
    """Purpose: Apply changed harness settings to new sessions without touching live ones.

    Input: An adapter from ``build_agent_adapter`` and the new productivity settings.
    Output: Names whose provider was added, replaced or removed. Live sessions keep the
    provider instance they were created with until they close.
    """
    known = adapter.provider_settings
    changed = []
    for name, provider_settings in productivity.providers.items():
        if not provider_settings.enabled or known.get(name) == provider_settings:
            continue
        adapter.register(
            create_provider(name, provider_settings, memory_mcp=adapter.memory_mcp),
            replace=name in known,
        )
        known[name] = provider_settings
        changed.append(name)
    for name in list(known):
        provider_settings = productivity.providers.get(name)
        if provider_settings is None or not provider_settings.enabled:
            adapter.unregister(name)
            del known[name]
            changed.append(name)
    return changed
