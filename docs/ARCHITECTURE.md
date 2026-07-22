# Cleo 当前架构

本文描述仓库中已经实现的运行时、harness adapter、session storage 和 memory
pipeline，不把未来前端或完整 SessionHub 服务写成已完成能力。

## 组件边界

```text
Cleo CLI / Main Agent
        │
        ├── non_productivity session
        │
        ├── AgentAdapter ── Codex / Claude SDK
        │        │
        │        └───────── ACP harness
        │
        ▼
SessionStore
        ├── manifest.json
        ├── events.jsonl
        ├── compact.json
        └── sessions.sqlite3
                │
                ▼
        DreamAgent / Retrieval
```

- `core/agent.py`：Cleo 主 Agent 与 DreamAgent。
- `core/cli.py`：Rich CLI 的 header、流式事件与 Session Hub 表现层，以及基于
  `prompt_toolkit` 的模式化命令、目录和 session ID 补全。
- `core/usage.py`：Cleo 与 harness 共用的 context-window usage 状态模型。
- `core/integrations/agent_adapter/`：统一 harness 接口和 provider-specific adapter。
- `core/memory/session_store.py`：session manifest、append-only events 和全局 registry。
- `core/memory/compaction.py`：从 event log 生成脱敏 compact projection。
- `core/memory/store.py`：space-bound SQLite 长期记忆与历史 chunks。
- `core/memory/state.py`：source version 与 consolidation 状态。
- `core/runtime/model.py`：当前 CLI space/project/thread 和 recent threads。

## Space 与 Project

每个 session 都必须同时绑定：

```text
space + project + session_id
```

当前 space 为：

- `non_productivity`：Cleo 主聊天、个人上下文、长期偏好和一般计划。
- `productivity`：Codex、Claude、ACP 等 harness 的工程任务与执行记录。

同名 project 在两个 space 中仍然是不同的数据边界。SQLite 查询、compact 校验、
DreamAgent 工具和 evidence 都必须携带 space，避免 productivity 内容自动进入个人记忆。

## Session 存储

```text
memory/
├── MEMORY_POLICY.md
├── sessions.sqlite3
├── non_productivity/
│   ├── memory.sqlite3
│   ├── memory_state.json
│   └── projects/<project>/
│       ├── MEMORY.md
│       └── sessions/<session_id>/
│           ├── manifest.json
│           ├── events.jsonl
│           └── compact.json
└── productivity/
    ├── memory.sqlite3
    ├── memory_state.json
    └── projects/<project>/
        ├── MEMORY.md
        └── sessions/<session_id>/
            ├── manifest.json
            ├── events.jsonl
            └── compact.json
```

### Manifest

`manifest.json` 是可变的当前状态投影，记录 provider、native session ID、owner、
status、cwd、event sequence、source hash 和更新时间。更新使用临时文件加原子替换。

### Event Log

`events.jsonl` 是权威记录，只追加不覆盖。每行包含全局 event ID、严格递增 seq、
space/project/session 绑定、actor、type、时间和 payload。

流式 token 只发送给实时调用者；完成后的语义消息才持久化。工具调用、权限、文件变化、
计划、状态和错误以独立规范事件保存。大型输出应使用 `data/session_artifacts/`，event
只保存引用。

### Compact Projection

`compact.json` 是可重建派生层：

- 从 `events.jsonl` 读取 semantic events。
- 合并 tool call/result。
- 脱敏 secret 与大型参数。
- 省略低价值读取结果和超长终端内容。
- 保存 `source_content_hash`、event range 和 `source_event_ids`。

加载 compact 时必须重新计算 event hash，并校验 space/project/session 和最后 seq。

### SQLite

`memory/sessions.sqlite3` 是所有 session 的全局 metadata registry，可由 manifest 重建。
每个 space 自己的 `memory.sqlite3` 保存 atomic memory、event evidence、consolidation
记录与 lexical conversation chunks。SQLite 不是原始对话事实源。

## Harness 事件适配

不同 harness 的原生输出先在 provider adapter 中翻译：

```text
native provider event
    → provider-specific translator
    → Cleo canonical event
    → SessionStore
```

公共语义包括：

- `assistant_message`
- `tool_call` / `tool_result`
- `permission_request` / `permission_response`
- `file_change`
- `terminal_output`
- `plan_update`
- `status` / `error`

无法稳定归一化的事件保存为 `provider_event`，并在 `data` 中保留 provider、原始事件
类型和清理后的 payload。SessionStore 不依赖任何单个 harness 的 SDK 类型。

## Cleo 主聊天流转

```text
用户消息
  → Agent.stream_text
  → LangGraph state
  → 每轮结束同步新增 LangChain messages
  → SessionStore 追加 events.jsonl
  → 原子更新 manifest
  → 重建 compact.json
  → 更新 space-bound conversation chunks
```

`--resume` 与主聊天内的 `/resume` 都通过全局 registry 找到 manifest，再从 message
events 重建 LangChain messages。它不是 durable LangGraph checkpoint 恢复。

Cleo 在流式 `AIMessageChunk` 上捕获 provider 返回的 usage metadata；若 provider 不返回，
状态栏只显示配置的窗口上限和 `waiting`。

## Harness 流转

```text
AgentAdapter.create_session
  → provider 创建 native session
  → productivity manifest + session_created

AgentAdapter.prompt
  → user_message + session_running
  → provider prompt
  → provider events 归一化
  → assistant_message + terminal status
  → compact + SQLite index
```

主聊天中的 `/productivity` 是交互式终端入口，退出后会恢复原 Cleo space/project/thread。
`main.py --productivity` 仍作为直接启动和脚本入口。两者都通过 provider factory 读取
独立的 `config/harnesses.json`，注册启用的 Codex SDK、Claude SDK 或 ACP provider，并
选择配置的 default provider。加载后仍以 `settings.productivity` 提供给 runtime。它们
支持新建或通过 Cleo session ID 恢复 native session，并把 SDK
notification 实时输出到终端。productivity 内的 `/resume` 使用相同恢复路径；`/cwd`
查询工作目录，`/cd` 创建绑定到目标目录的新 session。`--cwd` 控制 harness 工作目录，
`--project` 只控制 Cleo 的 memory scope。

Codex 的 `thread/tokenUsage/updated` 会归一化为 `status` event，同时驱动 CLI context
状态栏；展示值来自 SDK 的 `totalTokens` 与 `modelContextWindow`。

`AgentAdapter` 当前承担轻量 SessionHub 的 active route 职责：Cleo session handle 映射到
provider connection 和 native session ID。已完成内容只留在 SessionStore；provider
连接关闭后不会常驻内存。

## DreamAgent 流转

```text
validated compact
  → space/project/session/source hash 校验
  → DreamAgent 读取同 scope 的项目记忆
  → atomic memory + evidence_event_ids
  → 原子写入 MEMORY.md
  → 显式 complete consolidation
```

两个 space 使用不同提取重点：non-productivity 偏向用户事实、偏好、目标与纠正；
productivity 偏向任务目标、技术决策、改动文件、测试结果、错误、产物和未完成事项。

自动 consolidation 不会修改 `AGENTS.md`，也不会创建或更新 skill。

## Runtime State

`data/runtime.json` 只保存交互入口状态：

- `current_space`
- `current_project`
- `current_thread_id`
- 按 space 分区的 projects
- 按 space 分区的 recent threads

它不保存对话正文，也不是 session registry。
