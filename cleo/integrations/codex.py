from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from cleo.harnesses import AgentAdapter, AgentResult
from cleo.integrations.harnesses.codex import CodexProvider


class CodexResult(BaseModel):
    """一次 Codex turn 的最终结果(不可变)。

    由 ``CodexAdapter._result`` 从 ``AgentResult`` 转换生成; 经
    ``model_dump`` 序列化后返回给 MCP 工具(cleo/mcp/codex_server.py)与
    langchain 工具(cleo/agents/tools/codex_tools.py)的调用方。
    """

    model_config = ConfigDict(frozen=True)

    thread_id: str
    turn_id: str
    status: str
    response: str | None = None
    error: str | None = None


class CodexAdapter:
    """Backward-compatible Codex facade backed by the unified agent adapter."""

    def __init__(self, default_model: str, project_root: str | Path) -> None:
        """初始化门面: 自建 ``AgentAdapter`` 并注册默认 ``CodexProvider``。

        参数:
            default_model: 默认模型 id, 来自
                ``settings.active_tools_profile.codex_model``(由
                codex_server.py / codex_tools.py 模块级代码传入)。
            project_root: 项目根目录, 来自
                ``settings.active_directory_profile.root_path``。
        """
        self._adapter = AgentAdapter(project_root)
        self._adapter.register(CodexProvider(default_model=default_model))
        self._handles: dict[str, str] = {}

    async def start(
        self,
        prompt: str,
        project_path: str,
        model: str | None = None,
    ) -> CodexResult:
        """新建 thread 并执行一个完整 turn。

        由 MCP 工具 ``codex``(cleo/mcp/codex_server.py)与 langchain 工具
        ``codex_tool``(cleo/agents/tools/codex_tools.py)调用。
        参数:
            prompt: 任务描述文本, 由工具调用方(LLM/agent)提供。
            project_path: Codex 工作目录, 由工具调用方提供(默认 ``.``)。
            model: 可选模型 id, 覆盖 default_model。
        返回:
            ``CodexResult``, 其 ``thread_id`` 可用于后续 ``reply``。
        """
        result = await self._adapter.run(
            provider="codex",
            prompt=prompt,
            project_path=project_path,
            model=model,
        )
        return self._result(result)

    async def reply(
        self,
        thread_id: str,
        prompt: str,
        project_path: str,
    ) -> CodexResult:
        """在既有 thread 上执行一个后续 turn(必要时先 resume)。

        由 MCP 工具 ``codex-reply`` 与 langchain 工具 ``codex_reply_tool``
        调用。
        参数:
            thread_id: ``start`` / 上次 ``reply`` 返回结果中的 thread_id;
                首次出现时通过 ``AgentAdapter.resume_session`` 恢复并缓存
                逻辑 handle。
            prompt: 后续输入文本, 由工具调用方提供。
            project_path: Codex 工作目录, resume 时使用。
        返回:
            ``CodexResult``。
        """
        handle = self._handles.get(thread_id)
        if handle is None:
            session = await self._adapter.resume_session(
                provider="codex",
                native_session_id=thread_id,
                project_path=project_path,
            )
            handle = session.id
            self._handles[thread_id] = handle
        return self._result(await self._adapter.prompt(handle, prompt))

    async def close(self) -> None:
        """关闭底层 adapter 及其全部 provider session。

        供调用方(如 MCP server 退出前)做资源清理。
        """
        await self._adapter.aclose()

    def _result(self, result: AgentResult) -> CodexResult:
        """把统一 ``AgentResult`` 转换为兼容门面的 ``CodexResult``。

        参数:
            result: ``AgentAdapter.run`` / ``prompt`` 返回的统一结果,
                来自 ``start`` / ``reply``。
        返回:
            ``CodexResult``; 同时更新 ``_handles`` 中 thread_id→逻辑
            session handle 的映射, 供 ``reply`` 复用。
        """
        thread_id = result.native_session_id or result.session_id
        self._handles[thread_id] = result.session_id
        return CodexResult(
            thread_id=thread_id,
            turn_id=result.turn_id,
            status=result.status,
            response=result.response,
            error=result.error,
        )
