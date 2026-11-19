# 0015. 首屏与发送不等待 harness SDK 的导入；开始写消息时提前打开 harness 会话

- **Status**: Proposed
- **Date**: 2026-11-19

## Context

Issue #183（关联 #162）：开机后第一次打开 Cleo 需要等较长时间；点击发送后，消息交给 harness 也偏慢。issue 要求先测基线、再定位瓶颈，并且不能把首屏省下的等待转移到第一条消息上。

基线（2026-11-19，本机，`v0.14.1` 的 `main`）：用 `scripts/bench_desktop_latency.py` 按 Electron 的方式驱动真实后端（`python -m cleo.desktop.server`，JSON-lines 协议），各阶段计时如下。读数见 PR 说明。定位到的原因：

- **任何 `cleo.integrations.*` 的导入都会拉起全部 harness SDK。** `cleo/integrations/__init__.py` 和 `cleo/integrations/harnesses/__init__.py` 会直接导入 Codex、Claude、ACP 三个 provider，这些 provider 再导入 `openai_codex`（含 `generated.v2_all`）、`claude_agent_sdk`、`acp`。`import cleo.desktop.server` 共约 5.4 秒，其中 4.5 秒花在这里。Cleo 自己的 MCP 服务（记忆、computer）也要经过 `cleo.integrations.harness_home` 等模块，同样付出约 4.5 秒，而 Codex 必须等这些 required 的 MCP 服务就绪才开始建线程，Claude 同样要等它们连接上。
- **首屏的两个请求里，运行时目录构建了整个 adapter**，只是为了判断哪些 harness 已注册，结果就是没有消除导入，只是把它挪到了另一个请求。
- **会话存储顺带加载了 LangChain**（约 0.4 秒），而首屏用到的标题、事件读取都不需要它。
- **每个后端进程第一次打开会话时，会在事件循环上对整个 CLI 计算 SHA-256**（Codex 385 MB 约 0.6 秒，Claude 237 MB 约 2.6 秒），作为可用性证据的范围标识。
- **打包版在创建窗口之前**，先用子进程检查托管的 Python 运行时和 Codex CLI；后端则要等渲染进程发出第一个请求才启动。
- **Claude 每次带着 effort 新建或恢复会话都会启动两次 CLI**：先按默认值连接，接着设置 effort 时因为 effort 只能在启动时指定，又重连一次，MCP 服务也随之重启。
- **重启后在已有任务里发出的第一条消息**，要先等 harness 进程启动、MCP 服务就绪、线程恢复（Codex 约 8 秒），才轮到这一轮本身（约 2–3 秒）。

## Decision

- **SDK 只在构建 provider 时导入。** 两个包入口改为 PEP 562 的 `__getattr__` 延迟导出；`factory.create_provider`、`MemoryMcp`、`codex_home`、`subscriptions` 都在函数内部导入 SDK；provider 类型的能力集中放到 `cleo/harnesses/capabilities.py` 的 `PROVIDER_CAPABILITIES`，查询能力不再需要导入 provider 类。
- **运行时目录直接从设置中读出已启用的 harness**，不再构建 adapter。
- **首屏返回后，在工作线程里预先导入已启用 harness 的模块**（`DesktopService._warm_harnesses`，由第一次 `load_workspace` 触发）。这样随后的模型列表和第一条消息不会再把导入时间补回来。
- **LangChain 只在需要构建或还原 LangChain 消息时导入。**
- **CLI 的摘要按路径、大小、修改时间保存在 `data/runtime-digests.json`**，文件不变就不再重新计算。
- **Electron 在运行时检查进行的同时创建窗口。** 检查期间后端请求排队，检查结束后按原顺序发出；检查一结束就启动后端，让 Python 的导入和渲染进程的加载重叠进行。
- **新建和恢复会话时，把将要应用的选项随启动一起传给 provider**（`launch_options`）：桌面端新建时带上草稿的 effort，恢复时带上保存的选项。Claude 用这些选项启动 CLI，之后同样的选项不会再触发重连。
- **在开发任务里开始写消息时，提前打开它的 harness 会话**（新的 `prepare_thread`）。同一任务的并发打开共用一次：`_ensure_productivity_session` 记录正在进行的打开，后台准备和随后的发送等待的是同一个。后台打开失败不会保留，随后的发送会重新打开并照常报错。

## Alternatives considered

- **把 Cleo 的 MCP 服务改为非 required，让 Codex 不必等它们。** 第一轮可能拿不到记忆工具，这会改变行为。否决。
- **在打开会话（查看）时就预先恢复 harness。** 只是浏览会话也会启动进程。改为在开始写消息时才做，因为那时发送的意图已经明确。
- **为新草稿预先创建备用的 harness 会话。** 能省下新任务首条消息约 8 秒，但没发出的草稿会留下空的原生线程和常驻进程，需要另外设计清理和取消。这次不做，列为后续工作。
- **在后台线程里构建整个 adapter。** adapter 的构建会注册 provider 并读写设置，放到线程里与事件循环并发并不安全；只预先导入模块就足够了。

## Consequences

- 首屏不再导入任何 harness SDK；第一条消息如果在预热导入完成前就发出，仍要等剩余的导入（在线程里进行，不阻塞事件循环）。
- 新任务的第一条消息仍要等 harness 进程和 MCP 服务启动（Codex 约 8 秒），只是少了 SDK 导入的部分；进一步优化见上文的后续工作。
- 新增的后端方法 `prepare_thread` 只读、可重复调用；旧前端不会调用它。

## References

- Issue #183、#162；ADR 0010（加载工作区的开销不随历史规模增长）
- `cleo/integrations/__init__.py`、`cleo/integrations/harnesses/__init__.py`、`cleo/harnesses/capabilities.py`、`cleo/harnesses/availability.py`、`cleo/desktop/service.py`（`get_runtime_catalog`、`_ensure_productivity_session`、`prepare_thread`、`_warm_harnesses`）、`ui/electron/main.mjs`、`ui/electron/backend.mjs`、`ui/src/useCleoWorkspace.ts`
- 测量脚本：`scripts/bench_desktop_latency.py`
