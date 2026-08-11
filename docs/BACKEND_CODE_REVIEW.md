# Cleo 后端离线 Code Review 路线

这份路线用于在没有网络的环境中熟悉 Cleo 后端。目标不是逐行读完所有 Python，而是在
review 结束时能够独立回答三个问题：一次普通聊天如何落盘、一次 productivity 请求如何
穿过 provider、一次会话如何变成长期记忆。

前端不在主路线中。Desktop 只读 Python 的协议边界和 service；`ui/` 可以最后再看。

## 起飞前基线

仓库已经保留 `.venv`、`ui/node_modules` 和 `release/Cleo` 打包版 App，因此下面的 Python 检查都不需要
联网。PowerShell 中从仓库根目录执行：

```powershell
Set-Location C:\path\to\Cleo-AI-agent
git status --short
git diff --stat
.\.venv\Scripts\ruff.exe check cleo tests
.\.venv\Scripts\python.exe -m pytest -q --basetemp "$env:TEMP\cleo-review-pytest"
git diff --check
```

当前工作树包含未跟踪的新文件；`git diff` 不显示这些文件。每次 review 都同时看
`git status --short`，不要把“diff 看完”误认为“改动看完”。不要在 review 途中运行
`git reset`、`git clean` 或 `main.py --reset-to-main`。

## 先记住五条架构规则

1. `events.jsonl` 是会话事实源；manifest、compact、SQLite index 和 Markdown 都是投影。
2. 每条 session/memory 数据都属于 `space + project + session_id`；两个 space 不能串数据。
3. `AgentAdapter` 只暴露 provider-neutral 数据面；Codex 特有控制面是可选能力。
4. CLI 和 Desktop 是两个入口，但共享 Agent、SessionStore、Runtime、Adapter 与 memory 流程。
5. DreamAgent 只能从经过校验的 compact 提取持久知识；Sentence Transformer gate 是前置筛选，
   不是真实记忆库。

整体路径：

```text
CLI / Desktop request
        │
        ├── non_productivity ── Agent ── LangGraph / LLM
        │
        └── productivity ───── AgentAdapter ── Codex / Claude / ACP
                                      │
                                      ▼
                  SessionStore: manifest + events.jsonl
                                      │
                       compact + SQLite projections
                                      │
                 Sentence Transformer gate → DreamAgent
                                      │
                       durable memory + evidence
```

## 90 分钟快速路线

如果飞机上的时间有限，严格按下面顺序，不要先钻进 UI 或 SDK 类型。

### 0–10 分钟：建立地图

读：

- `docs/ARCHITECTURE.md`
- `cleo/cli/application.py::amain`
- `cleo/desktop/server.py::ProtocolServer`

确认两个入口最终都构造相同的核心对象。特别检查 Desktop 协议是否只在 stdout 写 JSONL，
诊断信息是否只去 stderr；否则一条普通日志就会破坏 Electron 协议。

### 10–35 分钟：抓住事实源

按顺序读：

- `cleo/memory/paths.py`
- `cleo/sessions/store.py::SessionStore.create_session`
- `SessionStore.append_event` / `append_events`
- `SessionStore.sync_langchain_messages`
- `SessionStore.refresh_compact`
- `SessionStore.load_langchain_messages`
- `tests/sessions/test_store.py`

只追一个 user message：它何时获得 event ID/seq、何时写入 JSONL、manifest 何时更新、
SQLite 失败是否会损坏事实源、resume 如何从事件恢复消息。

### 35–55 分钟：理解 productivity 抽象

按顺序读：

- `cleo/harnesses/provider.py`
- `cleo/harnesses/models.py`
- `cleo/harnesses/adapter.py::AgentAdapter`
- `cleo/integrations/harnesses/factory.py`
- `cleo/integrations/harnesses/codex.py`
- `tests/integrations/test_harnesses.py`

重点不是 Codex SDK 的每个字段，而是 native event 在哪里被翻译成 Cleo canonical event，
`cwd`、native session ID、取消和关闭状态如何穿过 adapter。

### 55–75 分钟：理解记忆

按顺序读：

- `cleo/memory/compaction.py::compact_events`
- `cleo/memory/compaction.py::load_validated_compact`
- `cleo/memory/gate.py::evaluate_memory_gate`
- `cleo/memory/state.py::needs_consolidation`
- `cleo/cli/lifecycle.py::_run_dream_agent`
- `cleo/agents/dream.py`
- `tests/memory/test_pipeline.py` 与 `tests/memory/test_gate.py`

确认 compact 的 source hash、evidence event ID 和 processed/consolidated hash 各自表达什么。
特别区分“gate 已处理但跳过”与“DreamAgent 已写入持久记忆”。

### 75–90 分钟：理解 App 接入

按顺序读：

- `cleo/desktop/service.py::DesktopService.create_thread`
- `DesktopService.stream_turn`
- `DesktopService._stream_chat`
- `DesktopService._stream_productivity`
- `cleo/desktop/projection.py`
- `cleo/desktop/configuration.py`
- `tests/desktop/`

检查 service 是否只是编排核心对象，而不是复制一套业务逻辑。目录选择最终必须成为
productivity session 的真实 `project_path/cwd`；模型 API Key 只能写入本地配置，返回 UI
的对象只能包含 `hasApiKey`，不能包含密钥本身。

## 完整路线

时间充足时，在快速路线之后补下面四组。

### A. 配置与路径边界

读 `cleo/config/settings.py` 和 `tests/config/`。从 `_app_home`、`_config_path`、
`load_settings` 一路追到 `SettingsModel`。

检查：

- 源码运行与打包运行是否使用预期的数据根目录。
- 相对路径是否基于 active directory profile，而不是进程偶然的 cwd。
- agent profile、harness provider 与 active profile 的校验是否在启动时失败得足够明确。
- secret 是否可能进入异常文本、Desktop 响应、event 或日志。

### B. 普通聊天生命周期

读 `cleo/agents/cleo.py`、`cleo/cli/chat.py`、`cleo/cli/lifecycle.py`，再读对应的
`tests/agents/` 与 `tests/cli/`。

完整追踪：

```text
user input
  → Agent.stream_text
  → streamed chunks / usage
  → _sync_session_events
  → SessionStore
  → compact + conversation chunks
  → detached DreamAgent worker
```

检查异常、取消、空回复与恢复后的去重。流式 chunk 不应直接成为持久化事实；完成后的语义
消息才应写入 event log。

### C. 记忆一致性

读 `cleo/memory/store.py`、`state.py`、`persona.py` 和
`cleo/agents/tools/dream_agent_tools.py`。

检查：

- atomic memory 是否有稳定 fingerprint，重复 consolidation 是否幂等。
- 每条持久记忆是否引用同 scope 的真实 evidence event ID。
- session 移动、conversation chunk 替换和删除是否同时更新旧/新 project。
- `PERSONA.md` 是否只从 persona SQLite 渲染，是否避免泄露 project/session 来源。
- 文件原子替换和 SQLite transaction 失败后，状态是否可重试。

### D. 真实故障边界

最后读：

- `cleo/agents/tools/shell_tools.py`
- `cleo/agents/tools/browser_tools.py`
- `cleo/integrations/harnesses/claude.py`
- `cleo/integrations/harnesses/acp.py`
- `cleo/cli/productivity.py`

这里重点找外部边界问题：路径逃逸、subprocess 生命周期、timeout、取消、输出上限、网络地址
校验、provider 断连和 best-effort cleanup。不要把 provider 的偶发故障静默解释成成功。

## 三条必须能手画的数据流

### 普通聊天

```text
application/chat or DesktopService
  → Agent.stream_text
  → LangChain messages
  → SessionStore.sync_langchain_messages
  → events.jsonl
  → compact.json + conversation chunks
```

### Productivity

```text
productivity CLI or DesktopService
  → AgentAdapter.create/resume_session
  → provider.prompt
  → AgentEvent
  → SessionStore.append_event(s)
  → manifest + compact + index
```

### Memory consolidation

```text
validated compact
  → memory gate
  → skipped state OR DreamAgent
  → atomic memories + evidence
  → MEMORY.md / PERSONA.md
  → completed consolidation state
```

如果无法指出每个箭头对应的具体函数，就回到上一个模块，不要继续向下读。

## 测试映射

| 生产模块 | 先读的测试 | 主要风险 |
| --- | --- | --- |
| `cleo/config/` | `tests/config/` | 路径、默认值、secret、配置兼容 |
| `cleo/sessions/` | `tests/sessions/` | 数据丢失、seq、恢复、索引重建 |
| `cleo/agents/` | `tests/agents/` | 流式消息、usage、工具装配 |
| `cleo/harnesses/`、provider integrations | `tests/integrations/` | 事件归一化、取消、native session |
| `cleo/memory/` | `tests/memory/` | evidence、幂等、scope、失败恢复 |
| `cleo/desktop/` | `tests/desktop/` | JSONL 协议、cwd、UI 投影、密钥隐藏 |
| `cleo/cli/` | `tests/cli/` | dispatch、resume、生命周期、交互命令 |
| 全局依赖边界 | `tests/test_boundaries.py` | 反向依赖与入口耦合 |

推荐使用“先生产代码、后测试、再回生产代码”的顺序。测试通过只证明已覆盖的契约，不等于
异常、取消、并发和恢复路径完整。

## 本轮改动的后端 review 清单

当前最值得先看的新增/修改文件：

- `cleo/desktop/server.py`：JSONL 并发请求与 shutdown。
- `cleo/desktop/service.py`：CLI 能力到 App use case 的映射。
- `cleo/desktop/configuration.py`：模型/API profile 的原子写入与 secret 输出边界。
- `cleo/desktop/projection.py`：canonical event 到 UI timeline 的无副作用投影。
- `cleo/memory/overview.py`：记忆 UI 的只读汇总。
- `cleo/memory/store.py`、`state.py`：overview 与 consolidation 状态支持。
- `cleo/config/settings.py`：源码/打包数据根目录边界。
- `cleo/integrations/git.py`：工作目录的只读 Git 状态。
- `tests/desktop/` 与 `tests/memory/test_overview.py`：新增契约的回归覆盖。

前端可以只确认 `ui/electron/backend.mjs` 如何启动 Python；React 组件不影响后端 review。

## Finding 记录格式

每个问题用下面五行，避免只写“这里看起来不对”：

```text
[P0–P3] 简短标题
位置：path:line / symbol
触发：最小输入或状态
影响：错误行为、数据损失或回归范围
证据：调用链、现有测试，以及建议补的最小测试
```

优先级顺序：数据丢失与 scope 泄漏、生命周期/并发、取消与恢复、外部边界、安全、普通
correctness，最后才是命名和风格。不要在 review 过程中顺手重构；先把 finding 和可复现测试
写清楚。

## Review 完成条件

- 能从入口手画三条数据流，并为每个箭头指出函数。
- 能解释 event log、manifest、compact、session SQLite、memory SQLite、persona SQLite 的权威级别。
- 能解释 non-productivity 与 productivity 为什么不能自动共享项目记忆。
- 能指出 provider-neutral API 与 Codex 专属控制面的边界。
- 已检查本轮所有新增后端文件；没有只看 tracked diff。
- 已运行 Ruff、完整 pytest 和 `git diff --check`，或明确记录未运行原因。
- finding 包含触发条件和证据，而不只是个人偏好。
