from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from cleo.harnesses.models import AgentEvent, EventCallback


@dataclass(frozen=True, slots=True)
class ProviderSession:
    """provider 侧会话句柄(create/resume/fork 的返回)。

    字段(来源: 各 provider 实现,如 cleo/integrations/harnesses/codex.py:74;
    消费方: AgentAdapter._add_route 据此登记路由):
        id: provider 侧会话 id。
        native_id: harness 原生会话 id(可 None)。
    """

    id: str
    native_id: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderTurn:
    """一轮 prompt 在 provider 侧的原始结果。

    字段(来源: 各 provider 的 prompt 实现,如 codex.py:158;消费方:
    AgentAdapter.prompt 翻译为 AgentResult 并落盘):
        native_session_id: turn 后的原生会话 id(可能新建/更新)。
        turn_id: turn 标识。
        status: 终态字符串。
        response: 汇总回复文本。
        error: 错误信息。
        events: 本轮 AgentEvent 元组。
    """

    native_session_id: str | None
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None
    events: tuple[AgentEvent, ...] = ()


class AgentProvider(Protocol):
    """harness provider 协议: AgentAdapter 依赖的最小接口。

    实现方: cleo/integrations/harnesses/{codex,claude,acp}.py 及测试 fake;
    可选能力(list_models、fork_session 等)不在协议内,由
    AgentAdapter._capability 以 duck-typing 探测。
    """

    name: str

    async def create_session(
        self,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        """创建 provider 侧会话。

        参数:
            project_path: 已规范化的项目目录;来源: AgentAdapter.create_session。
            model: 可选模型覆盖;来源: 同上。

        返回: ProviderSession;消费方: AgentAdapter._add_route。
        """
        ...

    async def resume_session(
        self,
        native_session_id: str,
        project_path: str,
        model: str | None = None,
    ) -> ProviderSession:
        """按原生会话 id 恢复会话。

        参数:
            native_session_id: 原生会话 id;来源: AgentAdapter.resume_session。
            project_path / model: 同 create_session。

        返回: ProviderSession;消费方: AgentAdapter._add_route。
        """
        ...

    async def prompt(
        self,
        session_id: str,
        prompt: str,
        on_event: EventCallback | None = None,
    ) -> ProviderTurn:
        """执行一轮 prompt 并(可选)流式上报事件。

        参数:
            session_id: provider 侧会话 id;来源: AgentAdapter.prompt 的路由。
            prompt: 用户输入;来源: 同上。
            on_event: 事件回调;来源: AgentAdapter.prompt 透传的 CLI renderer。

        返回: ProviderTurn;消费方: AgentAdapter.prompt。
        """
        ...

    async def cancel(self, session_id: str) -> None:
        """取消进行中的 turn;来源: AgentAdapter.cancel;返回 None。"""
        ...

    async def close(self, session_id: str) -> None:
        """释放会话资源;来源: AgentAdapter.close/aclose;返回 None。"""
        ...
