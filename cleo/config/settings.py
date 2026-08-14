import json
import os
from pathlib import Path
from typing import Annotated, Any, Literal

from platformdirs import user_data_dir
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from cleo.memory.gate import DEFAULT_MEMORY_GATE_MODEL

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _app_home(source_root: Path = PROJECT_ROOT) -> Path:
    """确定 Cleo 的应用主目录 (APP_HOME)。

    参数:
        source_root: 用于判断是否为源码检出 (source checkout) 的候选根目录;
            来源: 默认取模块常量 PROJECT_ROOT(本文件上两级),仅测试可注入。

    返回:
        解析后的绝对路径 Path;优先级: 环境变量 CLEO_HOME > 含 pyproject.toml
        的源码根目录 > platformdirs 用户数据目录。消费方: 模块级常量
        APP_HOME(本文件第 24 行),继而被 _config_path 等派生路径使用。
    """
    override = os.environ.get("CLEO_HOME")
    if override:
        candidate = Path(override).expanduser()
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        return candidate.resolve()
    if (source_root / "pyproject.toml").is_file():
        return source_root.resolve()
    return Path(user_data_dir("Cleo", appauthor=False)).resolve()


APP_HOME = _app_home()


def _config_path() -> Path:
    """确定主配置文件 cleo.json 的路径。

    参数: 无;读取环境变量 CLEO_CONFIG_PATH(相对路径基于 APP_HOME 解析)。

    返回:
        cleo.json 的绝对路径 Path;消费方: 模块级常量 CONFIG_PATH(本文件
        第 38 行),并被 load_settings 的默认参数及 SettingsModel.PROFILE_DIR
        使用。
    """
    override = os.environ.get("CLEO_CONFIG_PATH")
    if not override:
        return APP_HOME / "config" / "cleo.json"

    candidate = Path(override).expanduser()
    if not candidate.is_absolute():
        candidate = APP_HOME / candidate
    return candidate.resolve()


CONFIG_PATH = _config_path()


def _harnesses_config_path() -> Path:
    """确定 productivity harness 配置 harnesses.json 的路径。

    参数: 无;读取环境变量 CLEO_HARNESSES_CONFIG_PATH(相对路径基于
    APP_HOME 解析),缺省时与 CONFIG_PATH 同目录。

    返回:
        harnesses.json 的绝对路径 Path;消费方: 模块级常量
        HARNESSES_CONFIG_PATH(本文件第 52 行),被 load_settings 使用。
    """
    override = os.environ.get("CLEO_HARNESSES_CONFIG_PATH")
    if not override:
        return CONFIG_PATH.with_name("harnesses.json")

    candidate = Path(override).expanduser()
    if not candidate.is_absolute():
        candidate = APP_HOME / candidate
    return candidate.resolve()


HARNESSES_CONFIG_PATH = _harnesses_config_path()

DEFAULT_ALLOWED_COMMANDS = ["python", "git"]
PLATFORM_ALLOWED_COMMANDS = {
    "nt": ["python", "python.exe", "py", "py.exe", "powershell", "powershell.exe", "git"],
    "posix": ["python", "python3", "sh", "bash", "git"],
}
DEFAULT_DENIED_PATTERNS = [
    "&&",
    "||",
    ";",
    "|",
    ">",
    "<",
    "`",
    "$(",
    "../",
    "..\\",
    " rm ",
    " rmdir ",
    " del ",
    " erase ",
    " format ",
    " shutdown ",
    " restart-computer ",
    " powershell -enc",
    " certutil -decode",
]


def _resolve_path(
    path: Path | str | None,
    default: Path,
    base: Path | None = None,
) -> Path:
    """把可选的相对/绝对路径解析为绝对路径。

    参数:
        path: 配置中给出的路径,可为 None;来源: 各 profile 字段(如
            ShellProfile.sandbox_root),由 SettingsModel 的 SHELL_* property
            与 DirectoryProfile.root_path 传入。
        default: path 为 None 时使用的默认路径;来源: 调用方字面量。
        base: 相对路径的解析基准,缺省为 APP_HOME;来源: 调用方传入的
            DirectoryProfile.root_path 或 None。

    返回:
        解析后的绝对路径 Path;消费方: DirectoryProfile.root_path 及
        SettingsModel.SHELL_SANDBOX_ROOT / SHELL_AUDIT_LOG_PATH。
    """
    candidate = Path(path) if path is not None else default
    if candidate.is_absolute():
        return candidate.resolve()
    return ((base or APP_HOME) / candidate).resolve()


def _effective_allowed_commands(
    configured: list[str],
    *,
    platform: str | None = None,
) -> list[str]:
    """合并用户配置的 shell allowlist 与平台默认命令并去重(保序)。

    参数:
        configured: cleo.json 中 profiles.shell.allowed_commands 的配置值;
            来源: SettingsModel.SHELL_ALLOWED_COMMANDS 传入。
        platform: 目标平台名(os.name 语义),缺省取当前 os.name;仅供测试
            注入。

    返回:
        去重后的命令名列表 list[str];消费方: SettingsModel.SHELL_ALLOWED_COMMANDS
        (本文件第 432 行),最终由 cleo/agents/tools/shell_tools.py:215 用于
        命令白名单校验。
    """
    platform_name = platform or os.name
    platform_defaults = PLATFORM_ALLOWED_COMMANDS.get(platform_name, ["python", "git"])
    return list(dict.fromkeys([*configured, *platform_defaults]))


class AgentProfile(BaseModel):
    """单个 LLM agent profile(cleo.json 中 profiles.agents.<name>)。

    字段(均来自 cleo.json 的 profiles.agents 配置):
        provider: API provider 标识(如 "openai");消费方: cleo/agents/cleo.py:80
            与 cleo/agents/dream.py:62 构建 chat model。
        model: 模型名(如 "kimi-k2.6");同上消费。
        api_key: 密钥,以 SecretStr 存储避免泄露;同上消费。
        base_url: 可选的 OpenAI-compatible endpoint;同上消费。
        max_tokens: 单次生成最大 token 数(>0);同上消费。
        temperature: 采样温度 [0, 2];同上消费。
    """

    model_config = ConfigDict(extra="forbid")

    provider: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1)
    api_key: SecretStr
    base_url: str | None = None
    max_tokens: int = Field(default=100000, gt=0)
    temperature: float = Field(default=0.7, ge=0, le=2)


class MemoryGateSettings(BaseModel):
    """Local Sentence Transformer gate used before DreamAgent consolidation."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    model: str = Field(default=DEFAULT_MEMORY_GATE_MODEL, min_length=1)
    local_files_only: bool = False
    minimum_similarity: float = Field(default=0.42, ge=-1, le=1)
    run_margin: float = Field(default=0.08, ge=0, le=2)
    skip_margin: float = Field(default=0.10, ge=0, le=2)
    max_messages: int = Field(default=24, gt=0, le=256)
    max_characters_per_message: int = Field(default=1200, gt=0, le=20_000)
    positive_prototypes: list[str] = Field(
        default_factory=lambda: [
            "The user stated a durable preference that should apply in future conversations.",
            "The user corrected an important fact or a previous misunderstanding.",
            "The conversation established or accepted a lasting technical decision.",
            "The user introduced a durable constraint, plan, open question, or next action.",
            "The interaction revealed a stable project-independent communication preference.",
            "用户表达了今后也应当遵循的长期偏好。",
            "用户纠正了一个重要事实或之前的误解。",
            "对话确认了需要长期保留的技术决定、约束、计划或下一步行动。",
            "交互体现了稳定且跨项目的沟通或相处偏好。",
        ],
        min_length=1,
    )
    negative_prototypes: list[str] = Field(
        default_factory=lambda: [
            "The conversation only contains a greeting, thanks, or acknowledgement.",
            "The user made casual small talk with no lasting preference or decision.",
            "The exchange contains only transient status chatter or repeated noise.",
            "The user ended or cancelled the interaction without creating durable information.",
            "对话只有问候、感谢、确认或告别，没有值得长期保存的信息。",
            "用户只是随意闲聊，没有形成长期偏好、决定、约束或后续行动。",
            "内容只是临时状态、重复信息或调试噪声。",
        ],
        min_length=1,
    )


class DirectoryProfile(BaseModel):
    """目录布局 profile(cleo.json 中 profiles.directories.<name>)。

    字段(均来自 cleo.json 的 profiles.directories 配置,相对路径基于
    root_dir 解析):
        root_dir: 项目根目录;经 root_path 暴露,消费方: cleo/cli/chat.py:422、
            cleo/cli/productivity.py:545、cleo/agents/cleo.py:107 等。
        data_dir / skills_dir / workspace_dir / memory_dir: 各功能子目录;
            经对应 *_path property 暴露给 SettingsModel 的 DATA_DIR 等。
        memory_policy_path: memory 抽取策略文件;经 MEMORY_POLICY_PATH 暴露。
        persona_path: 全局人格投影文件;经 PERSONA_PATH 暴露。
        session_index_path: 会话索引 SQLite;经 SESSION_INDEX_PATH 暴露,
            消费方: cleo/cli/application.py:172 等 SessionStore 构造处。
        session_artifacts_dir: 会话产物目录;经 SESSION_ARTIFACTS_DIR 暴露。
        runtime_state_path: 运行时状态 JSON;经 RUNTIME_STATE_PATH 暴露,
            消费方: cleo/runtime/state.py:96。
    """

    model_config = ConfigDict(extra="forbid")

    root_dir: Path = Path(".")
    data_dir: Path = Path("data")
    skills_dir: Path = Path("skills")
    workspace_dir: Path = Path("workspace")
    memory_dir: Path = Path("memory")
    memory_policy_path: Path = Path("memory/MEMORY_POLICY.md")
    persona_path: Path = Path("PERSONA.md")
    session_index_path: Path = Path("memory/sessions.sqlite3")
    session_artifacts_dir: Path = Path("data/session_artifacts")
    runtime_state_path: Path = Path("data/runtime.json")

    def project_path(self, path: Path) -> Path:
        """把 profile 内的相对路径解析到 root_path 之下。

        参数:
            path: 配置中的相对或绝对路径;来源: 下方各 *_path property 传入
                对应的配置字段值(如 self.data_dir)。

        返回:
            绝对路径 Path(绝对输入原样 resolve);消费方: 本类各 *_path
            property,最终经 SettingsModel 暴露给 CLI、memory、runtime 模块。
        """
        if path.is_absolute():
            return path.resolve()
        return (self.root_path / path).resolve()

    @property
    def root_path(self) -> Path:
        """项目根目录绝对路径。

        来源: root_dir 字段; 消费方: cleo/agents/cleo.py:107、cleo/cli/chat.py:422 等。
        """
        return _resolve_path(self.root_dir, Path("."))

    @property
    def data_path(self) -> Path:
        """data 目录绝对路径;来源: data_dir 字段;消费方: SettingsModel.DATA_DIR。"""
        return self.project_path(self.data_dir)

    @property
    def skills_path(self) -> Path:
        """skills 目录绝对路径;来源: skills_dir 字段;消费方: SettingsModel.SKILLS_DIR。"""
        return self.project_path(self.skills_dir)

    @property
    def workspace_path(self) -> Path:
        """workspace 目录绝对路径;来源: workspace_dir 字段;消费方: SettingsModel.WORKSPACE_DIR。"""
        return self.project_path(self.workspace_dir)

    @property
    def memory_path(self) -> Path:
        """memory 目录绝对路径;来源: memory_dir 字段;消费方: SettingsModel.MEMORY_DIR。"""
        return self.project_path(self.memory_dir)

    @property
    def memory_policy_file(self) -> Path:
        """memory 策略文件绝对路径。

        来源: memory_policy_path 字段; 消费方: SettingsModel.MEMORY_POLICY_PATH。
        """
        return self.project_path(self.memory_policy_path)

    @property
    def persona_file(self) -> Path:
        """全局人格投影绝对路径;默认与 ``AGENTS.md`` 同处应用根目录。"""
        return self.project_path(self.persona_path)

    @property
    def session_index_file(self) -> Path:
        """会话索引 SQLite 绝对路径。

        来源: session_index_path 字段; 消费方: SettingsModel.SESSION_INDEX_PATH。
        """
        return self.project_path(self.session_index_path)

    @property
    def session_artifacts_path(self) -> Path:
        """会话产物目录绝对路径。

        来源: session_artifacts_dir 字段; 消费方: SettingsModel.SESSION_ARTIFACTS_DIR。
        """
        return self.project_path(self.session_artifacts_dir)

    @property
    def runtime_state_file(self) -> Path:
        """运行时状态文件绝对路径。

        来源: runtime_state_path 字段; 消费方: SettingsModel.RUNTIME_STATE_PATH。
        """
        return self.project_path(self.runtime_state_path)


class ShellProfile(BaseModel):
    """shell 工具安全策略 profile(cleo.json 中 profiles.shell.<name>)。

    字段(均来自 cleo.json 的 profiles.shell 配置):
        sandbox_root: 沙箱根目录;经 SettingsModel.SHELL_SANDBOX_ROOT 暴露,
            消费方: cleo/agents/tools/shell_tools.py(路径映射与沙箱校验)。
        audit_log_path: 审计日志路径;经 SHELL_AUDIT_LOG_PATH 暴露,
            消费方: shell_tools.py:25-26 追加审计记录。
        require_allowlist / enforce_sandbox / require_approval: 三个安全开关;
            消费方: shell_tools.py:199/214/223 的执行前校验。
        timeout_seconds: 命令超时(>0);消费方: shell_tools.py:262。
        max_output_chars: 输出截断长度;消费方: shell_tools.py:105。
        allowed_commands: 用户配置的白名单命令;经 SHELL_ALLOWED_COMMANDS
            与平台默认合并后供 shell_tools.py:215 使用。
        include_platform_defaults: 是否并入 PLATFORM_ALLOWED_COMMANDS。
        denied_patterns: 拒绝匹配的子串模式;消费方: shell_tools.py:133。
    """

    model_config = ConfigDict(extra="forbid")

    sandbox_root: Path | None = None
    audit_log_path: Path | None = None
    require_allowlist: bool = False
    enforce_sandbox: bool = False
    require_approval: bool = False
    timeout_seconds: int = Field(default=30, gt=0)
    max_output_chars: int = Field(default=12000, ge=0)
    allowed_commands: list[str] = Field(default_factory=lambda: DEFAULT_ALLOWED_COMMANDS.copy())
    include_platform_defaults: bool = True
    denied_patterns: list[str] = Field(default_factory=list)


class BrowserToolSettings(BaseModel):
    """Configuration for Cleo's dedicated agent-browser adapter."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    command: str = Field(default="agent-browser", min_length=1)
    headless: bool = True
    allow_private_network: bool = False
    allowed_domains: list[str] = Field(default_factory=list)
    timeout_seconds: int = Field(default=45, gt=0, le=300)
    operation_timeout_ms: int = Field(default=25000, gt=0, le=120000)
    idle_timeout_seconds: int = Field(default=900, ge=0, le=86400)
    max_output_chars: int = Field(default=12000, ge=1000, le=200000)


class ToolsProfile(BaseModel):
    """工具 profile(cleo.json 中 profiles.tools.<name>)。

    字段(均来自 cleo.json 的 profiles.tools 配置):
        tavily_api_key: Tavily 搜索密钥(SecretStr);经 SettingsModel.TAVILY_API_KEY
            暴露给前台 web_search 工具。
        codex_model: codex 工具默认模型;消费方: cleo/agents/tools/codex_tools.py:7
            与 cleo/mcp/codex_server.py:10。
        browser: 专用 agent-browser 适配器的启用状态、命令、网络边界、超时与输出上限。
    """

    model_config = ConfigDict(extra="forbid")

    tavily_api_key: SecretStr | None = None
    codex_model: str = Field(default="gpt-5.5", min_length=1)
    browser: BrowserToolSettings = Field(default_factory=BrowserToolSettings)


class HarnessProviderSettings(BaseModel):
    """harness provider 的公共基座(harnesses.json 中 providers.<name>)。

    字段(均来自 config/harnesses.json 的 providers 配置):
        enabled: 是否启用;消费方: cleo/integrations/harnesses/factory.py:70
            决定是否注册进 AgentAdapter。
        model: 默认模型覆盖;消费方: factory.py 构造 provider 及
            cleo/cli/productivity.py:562 的 --model 缺省值。
        models: provider 未暴露模型枚举接口时，由用户显式声明的可选模型。
    """

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    model: str | None = Field(default=None, min_length=1)
    models: list[str] = Field(default_factory=list)


class CodexHarnessOptions(BaseModel):
    """codex_sdk harness 的专有选项(harnesses.json providers.<name>.options)。

    字段(来自 config/harnesses.json):
        approval_mode: 审批模式("deny_all"/"auto_review");消费方:
            cleo/integrations/harnesses/factory.py:29 映射为 ApprovalMode。
        sandbox: 沙箱级别("read-only"/"workspace-write"/"full-access");
            消费方: factory.py:30 映射为 Sandbox。
    """

    model_config = ConfigDict(extra="forbid")

    approval_mode: Literal["deny_all", "auto_review"] = "deny_all"
    sandbox: Literal["read-only", "workspace-write", "full-access"] = "workspace-write"


class ClaudeHarnessOptions(BaseModel):
    """claude_sdk harness 的专有选项(harnesses.json providers.<name>.options)。

    字段(来自 config/harnesses.json):
        permission_mode: Claude SDK 权限模式;消费方:
            cleo/integrations/harnesses/factory.py:35 传给 ClaudeProvider。
    """

    model_config = ConfigDict(extra="forbid")

    permission_mode: Literal[
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
        "dontAsk",
        "auto",
    ] = "acceptEdits"


class AcpHarnessOptions(BaseModel):
    """acp harness 的专有选项(harnesses.json providers.<name>.options)。

    字段(来自 config/harnesses.json;消费方均为
    cleo/integrations/harnesses/factory.py:42-49 组装 AcpAgentSpec):
        command: 启动 ACP agent 的可执行命令(必填)。
        args: 命令参数列表。
        env: 追加的环境变量。
        auth_method: 可选的 ACP 认证方法 id。
        auto_approve: 是否自动批准权限请求。
        model_config_id: 可选的 ACP 侧模型配置 id。
    """

    model_config = ConfigDict(extra="forbid")

    command: str = Field(..., min_length=1)
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    auth_method: str | None = None
    auto_approve: bool = False
    model_config_id: str | None = None


class CodexHarnessSettings(HarnessProviderSettings):
    """discriminated union 中 type="codex_sdk" 的 provider 配置。

    字段(来自 config/harnesses.json;消费方: factory.py:24-31):
        type: 判别字段,固定 "codex_sdk"。
        model: 默认模型(覆盖基类,必填且默认 "gpt-5.5")。
        options: CodexHarnessOptions。
    """

    type: Literal["codex_sdk"] = "codex_sdk"
    model: str = Field(default="gpt-5.5", min_length=1)
    options: CodexHarnessOptions = Field(default_factory=CodexHarnessOptions)


class ClaudeHarnessSettings(HarnessProviderSettings):
    """discriminated union 中 type="claude_sdk" 的 provider 配置。

    字段(来自 config/harnesses.json;消费方: factory.py:32-37):
        type: 判别字段,固定 "claude_sdk"。
        options: ClaudeHarnessOptions。
    """

    type: Literal["claude_sdk"] = "claude_sdk"
    options: ClaudeHarnessOptions = Field(default_factory=ClaudeHarnessOptions)


class AcpHarnessSettings(HarnessProviderSettings):
    """discriminated union 中 type="acp" 的 provider 配置。

    字段(来自 config/harnesses.json;消费方: factory.py:38-50):
        type: 判别字段,固定 "acp"。
        options: AcpHarnessOptions(必填,因 command 必填)。
    """

    type: Literal["acp"] = "acp"
    options: AcpHarnessOptions


ProductivityProviderSettings = Annotated[
    CodexHarnessSettings | ClaudeHarnessSettings | AcpHarnessSettings,
    Field(discriminator="type"),
]


def _default_productivity_providers() -> dict[str, ProductivityProviderSettings]:
    """构造 productivity providers 的默认值(仅启用内置 codex)。

    参数: 无(pydantic default_factory)。

    返回:
        {"codex": CodexHarnessSettings()} 字典;消费方: ProductivitySettings
        .providers 的 default_factory(本文件下方)。
    """
    return {"codex": CodexHarnessSettings()}


class ProductivitySettings(BaseModel):
    """productivity harness 配置根(config/harnesses.json 的整体结构)。

    字段(来自 config/harnesses.json):
        default_provider: 默认 provider 名;消费方: cleo/cli/productivity.py:557
            作为 --provider 缺省值。
        providers: 名称 -> provider 配置(discriminated union);消费方:
            cleo/integrations/harnesses/factory.py:69 遍历注册 enabled 项。
    """

    model_config = ConfigDict(extra="forbid")

    default_provider: str = Field(default="codex", min_length=1)
    providers: dict[str, ProductivityProviderSettings] = Field(
        default_factory=_default_productivity_providers
    )

    @model_validator(mode="after")
    def validate_default_provider(self) -> "ProductivitySettings":
        """校验 default_provider 存在且已启用。

        参数:
            self: 正在校验的实例;来源: pydantic model_validator 在
                SettingsModel.model_validate 时自动调用(load_settings 末尾)。

        返回:
            校验通过的自身;若默认 provider 缺失或被禁用则抛 ValueError,
            由 load_settings 的调用方(模块导入期)暴露为启动错误。
        """
        provider = self.providers.get(self.default_provider)
        if provider is None:
            raise ValueError(f"Default productivity provider not found: {self.default_provider}")
        if not provider.enabled:
            raise ValueError(f"Default productivity provider is disabled: {self.default_provider}")
        return self

    def provider(self, name: str) -> ProductivityProviderSettings:
        """按名称取出 provider 配置,未知名称抛带说明的 KeyError。

        参数:
            name: provider 名;来源: cleo/cli/productivity.py:562 传入
                --provider CLI 参数或 default_provider。

        返回:
            对应的 ProductivityProviderSettings;消费方: productivity.py:562
            取其 model 作为 --model 缺省值。
        """
        try:
            return self.providers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown productivity provider: {name}") from exc


class ActiveProfiles(BaseModel):
    """当前激活的 profile 选择(cleo.json 中 active_profiles)。

    字段(来自 cleo.json 的 active_profiles;消费方:
    SettingsModel.validate_active_profiles 校验存在性,各
    active_*_profile property 据此查 ProfileRegistry):
        agent: 前台 Cleo 使用的 agent profile 名。
        dream_agent: DreamAgent 独立使用的 agent profile 名,缺省回退 agent。
        directory / shell / tools: 其余 profile 名,默认 "default"。
    """

    model_config = ConfigDict(extra="forbid")

    agent: str
    dream_agent: str | None = None
    directory: str = "default"
    shell: str = "default"
    tools: str = "default"


class ProfileRegistry(BaseModel):
    """全部可用 profile 的注册表(cleo.json 中 profiles)。

    字段(来自 cleo.json 的 profiles;消费方: SettingsModel 的
    active_*_profile property 按 active_profiles 中的名字索引):
        agents: 名称 -> AgentProfile(必填,至少要有 active 的那个)。
        directories / shell / tools: 名称 -> 对应 profile,默认各含一个
            "default" 项。
    """

    model_config = ConfigDict(extra="forbid")

    agents: dict[str, AgentProfile]
    directories: dict[str, DirectoryProfile] = Field(
        default_factory=lambda: {"default": DirectoryProfile()}
    )
    shell: dict[str, ShellProfile] = Field(default_factory=lambda: {"default": ShellProfile()})
    tools: dict[str, ToolsProfile] = Field(default_factory=lambda: {"default": ToolsProfile()})


class SettingsModel(BaseModel):
    """经验证的全局配置根,由 load_settings 产出并经模块级 settings 单例暴露。

    字段:
        active_profiles: 激活选择;来源: cleo.json。
        profiles: profile 注册表;来源: cleo.json。
        productivity: productivity harness 配置;来源: config/harnesses.json,
            由 load_settings 合并进 cleo.json 数据后统一 validate。

    消费方: cleo/agents/cleo.py、cleo/agents/dream.py、cleo/cli/*、
    cleo/agents/tools/*、cleo/runtime/state.py、cleo/memory/* 等通过
    `from cleo.config.settings import settings` 读取下方各 property。
    """

    model_config = ConfigDict(extra="forbid")

    active_profiles: ActiveProfiles
    profiles: ProfileRegistry
    productivity: ProductivitySettings = Field(default_factory=ProductivitySettings)
    memory_gate: MemoryGateSettings = Field(default_factory=MemoryGateSettings)

    @model_validator(mode="after")
    def validate_active_profiles(self) -> "SettingsModel":
        """校验 active_profiles 引用的每个 profile 都存在于注册表。

        参数:
            self: 正在校验的实例;来源: pydantic 在 load_settings 的
                SettingsModel.model_validate 时自动调用。

        返回:
            校验通过的自身;存在缺失时抛 ValueError,在模块导入期使应用
            以明确错误信息启动失败。
        """
        missing: list[str] = []
        if self.active_profiles.agent not in self.profiles.agents:
            missing.append(f"agent:{self.active_profiles.agent}")
        if (
            self.active_profiles.dream_agent is not None
            and self.active_profiles.dream_agent not in self.profiles.agents
        ):
            missing.append(f"dream_agent:{self.active_profiles.dream_agent}")
        if self.active_profiles.directory not in self.profiles.directories:
            missing.append(f"directory:{self.active_profiles.directory}")
        if self.active_profiles.shell not in self.profiles.shell:
            missing.append(f"shell:{self.active_profiles.shell}")
        if self.active_profiles.tools not in self.profiles.tools:
            missing.append(f"tools:{self.active_profiles.tools}")
        if missing:
            raise ValueError(f"Active profile(s) not found: {', '.join(missing)}")
        return self

    @property
    def active_agent_profile(self) -> AgentProfile:
        """前台 Cleo 激活的 AgentProfile。

        来源: active_profiles.agent 索引 profiles.agents; 消费方: cleo/agents/cleo.py:80。
        """
        return self.profiles.agents[self.active_profiles.agent]

    @property
    def active_dream_agent_profile(self) -> AgentProfile:
        """DreamAgent 激活的 AgentProfile(dream_agent 缺省回退 agent)。

        消费方: cleo/agents/dream.py:62。
        """
        profile_name = self.active_profiles.dream_agent or self.active_profiles.agent
        return self.profiles.agents[profile_name]

    @property
    def active_directory_profile(self) -> DirectoryProfile:
        """激活的 DirectoryProfile;消费方: cleo/cli/chat.py:422、cleo/mcp/codex_server.py:11 等。"""
        return self.profiles.directories[self.active_profiles.directory]

    @property
    def active_shell_profile(self) -> ShellProfile:
        """激活的 ShellProfile;消费方: 下方 SHELL_* property,最终由 shell_tools.py 使用。"""
        return self.profiles.shell[self.active_profiles.shell]

    @property
    def active_tools_profile(self) -> ToolsProfile:
        """激活的 ToolsProfile;消费方: codex_tools.py:7、mcp/codex_server.py:10。"""
        return self.profiles.tools[self.active_profiles.tools]

    @property
    def PROFILE_DIR(self) -> Path:
        """主配置文件 cleo.json 的路径(历史命名,实为文件而非目录);来源: 模块常量 CONFIG_PATH。"""
        return CONFIG_PATH

    @property
    def TAVILY_API_KEY(self) -> str | None:
        """明文 Tavily API key 或 None。

        来源: active tools profile 的 tavily_api_key; 由前台 web_search 工具消费。
        """
        key = self.active_tools_profile.tavily_api_key
        return key.get_secret_value() if key else None

    @property
    def DATA_DIR(self) -> Path:
        """data 目录绝对路径;来源: active directory profile;当前仓库内暂无直接消费方。"""
        return self.active_directory_profile.data_path

    @property
    def SKILLS_DIR(self) -> Path:
        """skills 目录绝对路径;来源: active directory profile;当前仓库内暂无直接消费方。"""
        return self.active_directory_profile.skills_path

    @property
    def WORKSPACE_DIR(self) -> Path:
        """workspace 目录绝对路径;来源: active directory profile;当前仓库内暂无直接消费方。"""
        return self.active_directory_profile.workspace_path

    @property
    def MEMORY_DIR(self) -> Path:
        """memory 目录绝对路径。

        来源: active directory profile; 消费方: cleo/cli/application.py:172、
        cleo/memory/store.py:564、cleo/agents/tools/dream_agent_tools.py 等。
        """
        return self.active_directory_profile.memory_path

    @property
    def MEMORY_POLICY_PATH(self) -> Path:
        """memory 策略文件绝对路径;来源: active directory profile;当前仓库内暂无直接消费方。"""
        return self.active_directory_profile.memory_policy_file

    @property
    def PERSONA_PATH(self) -> Path:
        """全局人格投影路径;来源: active directory profile。"""
        return self.active_directory_profile.persona_file

    @property
    def SESSION_INDEX_PATH(self) -> Path:
        """会话索引 SQLite 路径。

        来源: active directory profile; 消费方: cleo/cli/application.py:172、
        chat.py:89、lifecycle.py:32。
        """
        return self.active_directory_profile.session_index_file

    @property
    def SESSION_ARTIFACTS_DIR(self) -> Path:
        """会话产物目录绝对路径;来源: active directory profile;当前仓库内暂无直接消费方。"""
        return self.active_directory_profile.session_artifacts_path

    @property
    def RUNTIME_STATE_PATH(self) -> Path:
        """运行时状态 JSON 路径;来源: active directory profile;消费方: cleo/runtime/state.py:96。"""
        return self.active_directory_profile.runtime_state_file

    @property
    def SHELL_SANDBOX_ROOT(self) -> Path:
        """shell 沙箱根目录绝对路径。

        来源: active shell profile.sandbox_root(相对路径基于 directory root);
        消费方: shell_tools.py:50/96/100/183。
        """
        return _resolve_path(
            self.active_shell_profile.sandbox_root,
            Path("."),
            self.active_directory_profile.root_path,
        )

    @property
    def SHELL_AUDIT_LOG_PATH(self) -> Path:
        """shell 审计日志绝对路径。

        来源: active shell profile.audit_log_path; 消费方: shell_tools.py:25-26。
        """
        return _resolve_path(
            self.active_shell_profile.audit_log_path,
            Path("data/shell_audit.log"),
            self.active_directory_profile.root_path,
        )

    @property
    def SHELL_REQUIRE_ALLOWLIST(self) -> bool:
        """是否强制命令白名单;来源: active shell profile;消费方: shell_tools.py:214。"""
        return self.active_shell_profile.require_allowlist

    @property
    def SHELL_ENFORCE_SANDBOX(self) -> bool:
        """是否强制沙箱路径限制;来源: active shell profile;消费方: shell_tools.py:223。"""
        return self.active_shell_profile.enforce_sandbox

    @property
    def SHELL_REQUIRE_APPROVAL(self) -> bool:
        """是否执行前需要人工批准;来源: active shell profile;消费方: shell_tools.py:199。"""
        return self.active_shell_profile.require_approval

    @property
    def SHELL_TIMEOUT_SECONDS(self) -> int:
        """命令超时秒数;来源: active shell profile;消费方: shell_tools.py:262/283/286。"""
        return self.active_shell_profile.timeout_seconds

    @property
    def SHELL_MAX_OUTPUT_CHARS(self) -> int:
        """命令输出最大字符数;来源: active shell profile;消费方: shell_tools.py:105。"""
        return self.active_shell_profile.max_output_chars

    @property
    def SHELL_ALLOWED_COMMANDS(self) -> list[str]:
        """有效命令白名单(按 include_platform_defaults 决定是否并入平台默认)。

        来源: active shell profile; 消费方: shell_tools.py:215。
        """
        configured = self.active_shell_profile.allowed_commands
        if not self.active_shell_profile.include_platform_defaults:
            return configured
        return _effective_allowed_commands(configured)

    @property
    def SHELL_DENIED_PATTERNS(self) -> list[str]:
        """拒绝匹配的子串模式列表;来源: active shell profile;消费方: shell_tools.py:133。"""
        return self.active_shell_profile.denied_patterns


def _default_config() -> dict[str, Any]:
    """生成首次运行时写入 cleo.json 的默认配置字典。

    参数: 无。

    返回:
        可被 SettingsModel 校验的嵌套 dict;消费方: _create_default_config
        (本文件下方)序列化为 JSON。
    """
    return {
        "active_profiles": {
            "agent": "moonshot_openai_compatible",
            "dream_agent": "moonshot_openai_compatible",
            "directory": "default",
            "shell": "default",
            "tools": "default",
        },
        "profiles": {
            "agents": {
                "moonshot_openai_compatible": {
                    "provider": "openai",
                    "model": "kimi-k2.6",
                    "temperature": 0.7,
                    "max_tokens": 100000,
                    "api_key": "YOUR_MOONSHOT_API_KEY",
                    "base_url": "https://api.moonshot.cn/v1",
                }
            },
            "directories": {
                "default": {
                    "root_dir": ".",
                    "data_dir": "data",
                    "skills_dir": "skills",
                    "workspace_dir": "workspace",
                    "memory_dir": "memory",
                    "memory_policy_path": "memory/MEMORY_POLICY.md",
                    "persona_path": "PERSONA.md",
                    "session_index_path": "memory/sessions.sqlite3",
                    "session_artifacts_dir": "data/session_artifacts",
                    "runtime_state_path": "data/runtime.json",
                }
            },
            "shell": {
                "default": {
                    "sandbox_root": ".",
                    "audit_log_path": "data/shell_audit.log",
                    "require_allowlist": True,
                    "enforce_sandbox": True,
                    "require_approval": False,
                    "timeout_seconds": 30,
                    "max_output_chars": 12000,
                    "allowed_commands": DEFAULT_ALLOWED_COMMANDS,
                    "include_platform_defaults": True,
                    "denied_patterns": DEFAULT_DENIED_PATTERNS,
                }
            },
            "tools": {
                "default": {
                    "tavily_api_key": None,
                    "codex_model": "gpt-5.5",
                    "browser": {
                        "enabled": True,
                        "command": "agent-browser",
                        "headless": True,
                        "allow_private_network": False,
                        "allowed_domains": [],
                        "timeout_seconds": 45,
                        "operation_timeout_ms": 25000,
                        "idle_timeout_seconds": 900,
                        "max_output_chars": 12000,
                    },
                }
            },
        },
    }


def _default_harnesses_config() -> dict[str, Any]:
    """生成首次运行时写入 harnesses.json 的默认配置字典。

    参数: 无。

    返回:
        可被 ProductivitySettings 校验的嵌套 dict;消费方:
        _create_default_harnesses_config(本文件下方)序列化为 JSON。
    """
    return {
        "default_provider": "codex",
        "providers": {
            "codex": {
                "type": "codex_sdk",
                "enabled": True,
                "model": "gpt-5.5",
                "options": {
                    "approval_mode": "deny_all",
                    "sandbox": "workspace-write",
                },
            }
        },
    }


def _create_default_config(path: Path) -> None:
    """在 path 处写入默认 cleo.json(必要时创建父目录)。

    参数:
        path: 目标文件路径;来源: load_settings 在配置文件不存在时传入
            config_path。

    返回: None;副作用是写文件,随后 load_settings 抛 FileNotFoundError
    提示用户补全 API key。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_default_config(), f, ensure_ascii=False, indent="\t")


def _create_default_harnesses_config(path: Path) -> None:
    """在 path 处写入默认 harnesses.json(必要时创建父目录)。

    参数:
        path: 目标文件路径;来源: load_settings 在 harnesses 配置不存在时
            传入推导出的 harnesses_path。

    返回: None;副作用是写文件,之后 load_settings 立即读回该文件。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_default_harnesses_config(), f, ensure_ascii=False, indent="\t")


def load_settings(
    config_path: Path = CONFIG_PATH,
    harnesses_config_path: Path | None = None,
) -> SettingsModel:
    """加载并校验 cleo.json 与 harnesses.json,产出全局 SettingsModel。

    参数:
        config_path: cleo.json 路径;来源: 默认 CONFIG_PATH,测试
            (tests/integrations/test_harness_factory.py:18)可注入临时路径。
        harnesses_config_path: harnesses.json 路径;None 时按 config_path
            推导(默认配置用 HARNESSES_CONFIG_PATH,自定义路径则取同目录
            harnesses.json);来源: 调用方或 None。

    返回:
        校验通过的 SettingsModel;消费方: 模块级单例
        `settings = load_settings()`(本文件末尾),被全仓库
        `from cleo.config.settings import settings` 使用。

    异常:
        FileNotFoundError: cleo.json 不存在时先写默认配置再抛出,提示补全。
        ValueError: cleo.json 中误放 "productivity" 段,或 profile 校验失败。
    """
    if not config_path.exists():
        _create_default_config(config_path)
        raise FileNotFoundError(
            f"Created default config at {config_path}. "
            "Please fill in your API key, model, and related profile settings."
        )

    with open(config_path, encoding="utf-8") as f:
        raw_config = json.load(f)

    if "productivity" in raw_config:
        raise ValueError(
            "Productivity configuration belongs in config/harnesses.json, not cleo.json."
        )

    harnesses_path = harnesses_config_path
    if harnesses_path is None:
        harnesses_path = (
            HARNESSES_CONFIG_PATH
            if config_path.resolve() == CONFIG_PATH
            else config_path.with_name("harnesses.json")
        )
    if not harnesses_path.exists():
        _create_default_harnesses_config(harnesses_path)
    with open(harnesses_path, encoding="utf-8") as f:
        raw_config["productivity"] = json.load(f)

    return SettingsModel.model_validate(raw_config)


settings: SettingsModel = load_settings()
