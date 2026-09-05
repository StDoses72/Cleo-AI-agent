from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from cleo.harnesses import AgentAdapter, AgentResult
from cleo.integrations.harnesses.codex import CodexProvider
from cleo.integrations.harnesses.memory import MemoryMcp
from cleo.sessions.store import SessionStore


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

    def __init__(
        self, default_model: str, project_root: str | Path,
        *, memory_root: str | Path | None = None,
        session_index_path: str | Path | None = None,
    ) -> None:
        """初始化门面: 自建 ``AgentAdapter`` 并注册默认 ``CodexProvider``。

        参数:
            default_model: 默认模型 id, 来自
                ``settings.active_tools_profile.codex_model``(由
                codex_server.py / codex_tools.py 模块级代码传入)。
            project_root: 项目根目录, 来自
                ``settings.active_directory_profile.root_path``。
        """
        root = Path(memory_root) if memory_root is not None else Path(project_root) / "memory"
        store = SessionStore(root, session_index_path)
        self._adapter = AgentAdapter(project_root, session_store=store)
        self._adapter.register(CodexProvider(
            default_model=default_model, memory_mcp=MemoryMcp(store.memory_root, store.index_path),
        ))
        self._thread_locks: dict[str, tuple[asyncio.Lock, int]] = {}

    async def start(
        self,
        prompt: str,
        project_path: str,
        model: str | None = None,
    ) -> CodexResult:
        """新建 thread 并执行一个完整 turn, 结束后释放底层会话。

        由 MCP 工具 ``codex``(cleo/mcp/codex_server.py)与 langchain 工具
        ``codex_tool``(cleo/agents/tools/codex_tools.py)调用。
        参数:
            prompt: 任务描述文本, 由工具调用方(LLM/agent)提供。
            project_path: Codex 工作目录, 由工具调用方提供(默认 ``.``)。
            model: 可选模型 id, 覆盖 default_model。
        返回:
            ``CodexResult``, 其 ``thread_id`` 可用于后续 ``reply``
            (``reply`` 会按需 resume 已释放的 thread)。
        """
        session = await self._adapter.create_session(
            "codex",
            project_path=project_path,
            model=model,
        )
        try:
            return self._result(await self._adapter.prompt(session.id, prompt))
        finally:
            await self._adapter.close(session.id)

    async def reply(
        self,
        thread_id: str,
        prompt: str,
        project_path: str,
    ) -> CodexResult:
        """在既有 thread 上执行一个后续 turn(必要时先 resume), 结束后释放会话。

        由 MCP 工具 ``codex-reply`` 与 langchain 工具 ``codex_reply_tool``
        调用。
        参数:
            thread_id: ``start`` / 上次 ``reply`` 返回结果中的 thread_id;
                每轮通过 ``AgentAdapter.resume_session`` 恢复,完成后释放
                逻辑 handle。
            prompt: 后续输入文本, 由工具调用方提供。
            project_path: Codex 工作目录, resume 时使用。
        返回:
            ``CodexResult``。
        """
        async with self._serialize_thread(thread_id):
            session = await self._adapter.resume_session(
                provider="codex",
                native_session_id=thread_id,
                project_path=project_path,
            )
            try:
                return self._result(await self._adapter.prompt(session.id, prompt))
            finally:
                await self._adapter.close(session.id)

    async def close(self) -> None:
        """关闭底层 adapter 及其全部 provider session。

        供调用方(如 MCP server 退出前)做资源清理。
        """
        await self._adapter.aclose()

    @asynccontextmanager
    async def _serialize_thread(self, thread_id: str) -> AsyncIterator[None]:
        """串行化同一原生 Codex thread 的并发 reply,并回收空闲锁。

        client 生命周期缩短为单 turn 后,并发 ``reply`` 若同时 resume 同一
        原生 thread 会绕过 provider session 内部的锁。本上下文
        管理器以 thread id 串行化 resume→prompt→close 整段流程;等待者计数
        归零后删除锁,避免长驻 MCP server 随 thread 数量无限积累锁对象。

        参数:
            thread_id: ``start`` 或上次 ``reply`` 返回的原生 Codex thread id。

        返回值:
            异步上下文管理器;``reply`` 在其范围内独占指定 thread。
        """
        entry = self._thread_locks.get(thread_id)
        if entry is None:
            lock = asyncio.Lock()
            waiting = 1
        else:
            lock, waiting = entry
            waiting += 1
        self._thread_locks[thread_id] = (lock, waiting)
        try:
            async with lock:
                yield
        finally:
            current = self._thread_locks.get(thread_id)
            if current is not None and current[0] is lock:
                remaining = current[1] - 1
                if remaining:
                    self._thread_locks[thread_id] = (lock, remaining)
                else:
                    del self._thread_locks[thread_id]

    def _result(self, result: AgentResult) -> CodexResult:
        """把统一 ``AgentResult`` 转换为兼容门面的 ``CodexResult``。

        参数:
            result: ``AgentAdapter.prompt`` 返回的统一结果,来自 ``start`` /
                ``reply``。
        返回:
            ``CodexResult``。逻辑 adapter session 会在本轮结果转换后立即
            关闭;后续 ``reply`` 使用返回的原生 thread id 按需恢复。
        """
        thread_id = result.native_session_id or result.session_id
        return CodexResult(
            thread_id=thread_id,
            turn_id=result.turn_id,
            status=result.status,
            response=result.response,
            error=result.error,
        )
