from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AgentEvent(BaseModel):
    """provider 上报的流式事件(frozen)。

    字段(来源: 各 provider 实现,如 cleo/integrations/harnesses/codex.py、
    claude.py、acp.py 中的事件翻译;消费方: AgentAdapter.prompt 经
    _stored_provider_event 落盘,以及 EventCallback 渲染):
        provider: 事件来源 provider 名。
        type: 事件类型(如 "tool_call"、"agent_message_chunk")。
        text: 可选文本内容。
        data: 原始负载(dict,含 schema_version/provider_event_type 等)。
    """

    model_config = ConfigDict(frozen=True)

    provider: str
    type: str
    text: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class AgentSession(BaseModel):
    """对外暴露的会话句柄(frozen)。

    字段(来源: AgentAdapter._add_route 组装;消费方:
    cleo/cli/productivity.py 与 cleo/integrations/codex.py 用 id 继续调用
    prompt/close 等):
        id: 对外 session handle("agent_" + 随机 hex 或复用存储 id)。
        provider: provider 名。
        project_path: 规范化后的项目目录。
        native_session_id: harness 原生会话 id(可 None)。
        space: SessionStore 分组,默认 "productivity"。
        project: project 分组名,默认 "general"。
    """

    model_config = ConfigDict(frozen=True)

    id: str
    provider: str
    project_path: str
    native_session_id: str | None = None
    space: str = "productivity"
    project: str = "general"


class AgentResult(BaseModel):
    """一轮 prompt 的最终结果(frozen)。

    字段(来源: AgentAdapter.prompt 由 ProviderTurn 组装;消费方:
    cleo/cli/productivity.py 渲染输出,cleo/integrations/codex.py 经
    _result 转为工具返回值):
        session_id: 对外 session handle。
        provider: provider 名。
        native_session_id: turn 后的原生会话 id(可能被 provider 更新)。
        turn_id: provider 侧 turn id。
        status: 终态("completed"/"failed"/"cancelled" 等)。
        response: 汇总的助手回复文本。
        error: 失败时的错误信息。
        events: 本轮全部 AgentEvent。
        space / project: SessionStore 分组信息。
    """

    model_config = ConfigDict(frozen=True)

    session_id: str
    provider: str
    native_session_id: str | None = None
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None
    events: list[AgentEvent] = Field(default_factory=list)
    space: str = "productivity"
    project: str = "general"


EventCallback = Callable[[AgentEvent], Awaitable[None] | None]


async def emit_event(callback: EventCallback | None, event: AgentEvent) -> None:
    """统一派发事件: callback 为 None 时跳过,返回 awaitable 时 await。

    参数:
        callback: 事件回调(同步或 async);来源: 各 provider 的 prompt
            实现(codex.py:153、claude.py:100、acp.py:76)透传自
            AgentAdapter.prompt 的 on_event。
        event: 待派发的 AgentEvent;来源: provider 事件翻译循环。

    返回: None;事件最终由 cleo/cli/productivity.py 的 renderer 消费。
    """
    if callback is None:
        return
    result = callback(event)
    if inspect.isawaitable(result):
        await result
