"""Optional rich-control models for harnesses that expose more than chat turns."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class HarnessModel:
    """provider 支持的单个模型的描述。

    字段(来源: 各 provider 的 list_models 实现,如
    cleo/integrations/harnesses/codex.py:197;消费方:
    AgentAdapter.list_models -> productivity TUI 的模型选择 UI):
        id: 模型标识。
        display_name: 展示名。
        description: 描述文本。
        is_default: 是否为 provider 默认模型。
        default_effort: 默认 effort 档位(可 None)。
        supported_efforts: 支持的 effort 档位元组。
    """

    id: str
    display_name: str
    description: str
    is_default: bool
    default_effort: str | None
    supported_efforts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class SessionOptions:
    """会话的运行时选项(均可选,None 表示未设置/不修改)。

    字段(来源: provider 的 session_options/update_session_options 返回值;
    消费方: AgentAdapter.session_options/update_session_options,经
    as_dict 写入 SessionStore manifest.runtime_options):
        model: 当前模型。
        effort: 推理强度档位。
        approval_mode: 审批模式。
        sandbox: 沙箱级别。
    """

    model: str | None = None
    effort: str | None = None
    approval_mode: str | None = None
    sandbox: str | None = None

    def as_dict(self) -> dict[str, str | None]:
        """转为普通 dict 以便 JSON 持久化。

        参数: 无(仅 self)。

        返回:
            四键 dict;消费方: AgentAdapter.update_session_options 与
            _add_route 写入 SessionStore 的 manifest.runtime_options。
        """
        return {
            "model": self.model,
            "effort": self.effort,
            "approval_mode": self.approval_mode,
            "sandbox": self.sandbox,
        }


@dataclass(frozen=True, slots=True)
class NativeSession:
    """provider 侧原生会话的元数据。

    字段(来源: provider 的 list_native_sessions/read_native_session 实现;
    消费方: productivity TUI 的会话列表与详情展示):
        id: 原生会话 id。
        name: 可选会话名。
        preview: 内容预览文本。
        cwd: 会话工作目录。
        status: 原生状态字符串。
        source: 来源标识(如 CLI/IDE)。
        model_provider: 模型提供方标识。
        created_at / updated_at: ISO 时间字符串。
    """

    id: str
    name: str | None
    preview: str
    cwd: str
    status: str
    source: str
    model_provider: str
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class NativeSessionPage:
    """一页原生会话列表结果。

    字段(来源: provider 的 list_native_sessions 实现,如 codex.py:232;
    消费方: AgentAdapter.list_native_sessions -> productivity TUI 浏览):
        sessions: 本页 NativeSession 元组。
        next_cursor: 下一页游标,None 表示没有更多。
    """

    sessions: tuple[NativeSession, ...]
    next_cursor: str | None = None


@dataclass(frozen=True, slots=True)
class NativeSessionDetail:
    """单个原生会话的完整详情。

    字段(来源: provider 的 read_native_session 实现;消费方:
    AgentAdapter.read_native_session -> productivity TUI 的详情展示):
        session: 会话元数据。
        turns: 各 turn 的原始 dict 元组(结构由 provider 定义)。
    """

    session: NativeSession
    turns: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class HarnessAccount:
    """provider 账号状态。

    字段(来源: provider 的 account_status 实现;消费方:
    AgentAdapter.account_status -> productivity TUI 的账号状态展示):
        authenticated: 是否已登录。
        account_type: 账号类型(如 API key / OAuth)。
        email: 账号邮箱。
        plan: 订阅计划名。
    """

    authenticated: bool
    account_type: str | None = None
    email: str | None = None
    plan: str | None = None
