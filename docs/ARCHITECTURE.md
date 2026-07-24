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

- `cleo/agents/cleo.py`：前台 Cleo Agent；`cleo/agents/dream.py`：后台记忆整理 Agent。
  两者可调用的工具集中在 `cleo/agents/tools/`。
- `cleo/cli/application.py`：只负责参数解析和顶层 dispatch；根目录 `main.py` 只保留
  `python main.py` 兼容入口。
- `cleo/cli/chat.py` 与 `cleo/cli/productivity.py`：分别编排主聊天和 harness 交互流。
- `cleo/cli/lifecycle.py`：session 保存与 DreamAgent consolidation 生命周期。
- `cleo/cli/console.py`：Rich 输出、流式事件、Session Hub 表现层，以及基于
  `prompt_toolkit` 的输入；命令补全和 harness event 渲染分别位于
  `cleo/cli/completion.py` 与 `cleo/cli/productivity_renderer.py`。
- `cleo/images/`：可替换 PNG 的加载与自动裁剪、终端图像选择、动态像素回退和 Sixel 渲染。
- `cleo/sessions/store.py`：session manifest、append-only events 和全局 registry。
- `cleo/sessions/hub.py`：合并 Cleo-managed session 与原生 harness session；不依赖 CLI。
- `cleo/memory/`：compact projection、长期记忆、evidence、路径与 consolidation state。
- `cleo/runtime/state.py`：当前 CLI space/project/thread 和 recent threads；
  `cleo/runtime/usage.py`：共用 context-window usage。
- `cleo/harnesses/`：provider-neutral harness API、控制面和 session adapter。
- `cleo/integrations/harnesses/`：Codex、Claude 和 ACP provider 实现及 composition factory。
- `cleo/integrations/git.py`：只读 Git 状态；`cleo/integrations/codex.py`：兼容 Codex facade。
- `cleo/config/`：配置模型、加载逻辑和打包模板；`cleo/mcp/`：stdio MCP 入口。

依赖方向保持为 `cli → agents / sessions / runtime / integrations`，session persistence
可以依赖 memory projection，但 session 聚合和 Git 集成不反向依赖 CLI。目录重排不改变
运行流：CLI 仍构造相同的 Agent、adapter、SessionStore 和 Runtime，并沿用原有入口、
配置格式与持久化协议。

## 安装与运行目录

源码 checkout 保持现有行为：当 `cleo/config/settings.py` 能在源码根目录看到
`pyproject.toml` 时，相对目录仍以仓库根目录为基准。

Windows 的 `scripts/install.ps1` 使用分离布局：

```text
%LOCALAPPDATA%\Programs\Cleo\   # launcher 与独立 Python runtime
%LOCALAPPDATA%\Cleo\            # config、data、memory、skills、workspace
%USERPROFILE%\.codex\           # Codex 自己管理的认证与 task 历史
```

launcher 通过 `CLEO_HOME` 明确指定数据根目录。其他打包环境未设置
`CLEO_HOME` 时使用 `platformdirs` 的用户数据目录；Docker 显式设置
`CLEO_HOME=/app`，并继续通过 volume 持久化运行数据。升级程序不会覆盖已有配置
或用户数据，卸载默认也保留数据目录。独立安装版优先读取
`%LOCALAPPDATA%\Cleo\assets\startup.png`；缺失时回退到包内默认图片。

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

Cleo 主模式中的 project 是可选的逻辑记忆边界，可表示一个长期话题、计划或工作流，
并不要求存在代码目录；`general` 是默认边界。productivity 中的 project 仍用于 Cleo
侧的记录分区，而 harness 的实际代码边界由 `cwd`/仓库决定。外部 harness 的本地
project 可按规范化 `cwd` 做可选关联，但不与 Cleo project 名称或内部 ID 强制一一对应。

Cleo thread 的标题由首条 `user_message` 确定，也可作为纯 metadata 手动修改。
活跃且尚未 consolidation 的 thread 可以迁移 project：session 目录、manifest、event
绑定、SQLite registry、compact、memory state 与 conversation chunks 会一起转移。
一旦 source 已被 DreamAgent consolidation，迁移会被拒绝，以免旧 project 的长期记忆
无法可靠回收。

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

`manifest.json` 是可变的当前状态投影，记录 title、provider、native session ID、
owner、status、cwd、event sequence、source hash 和更新时间。更新使用临时文件加原子
替换。

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

Codex rich control plane
  → thread/list + thread/read（只读浏览原生历史）
  → model/list + account/read（能力发现）
  → per-turn model / effort / sandbox / approval
  → thread/fork / name/set / compact / archive
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
状态栏；展示值来自 SDK 的 `totalTokens` 与 `modelContextWindow`。第二条状态栏显示当前
reasoning effort、sandbox、approval mode 与 Cleo 只读计算的 Git branch/dirty count。

`AgentAdapter` 的通用数据面仍只负责 create/resume/prompt/cancel/close；Codex 特有的
历史、模型与 thread 生命周期属于可选控制面，不强迫 Claude/ACP 伪造同名能力。

SessionHub 会把 `sessions.sqlite3` 中的 Cleo-managed session 与 Codex `thread/list` 的
实时结果合并。已绑定的 native thread 显示为 `cleo+native`，尚未绑定的显示为 `native`。
`/native` 浏览原生历史时不写入 Cleo event log；只有 `/resume-native` 才创建或复用
Cleo handle ↔ native thread ID 映射。已完成内容只留在 SessionStore；provider 连接关闭后
不会常驻内存。

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

DreamAgent 使用 `active_profiles.dream_agent` 独立选择 `profiles.agents` 中的模型配置。
旧配置未设置该字段时回退到前台 `active_profiles.agent`。

自动 consolidation 不会修改 `AGENTS.md`，也不会创建或更新 skill。

## Runtime State

`data/runtime.json` 只保存交互入口状态：

- `current_space`
- `current_project`
- `current_thread_id`
- 按 space 分区的 projects
- 按 space 分区的 recent threads

它不保存对话正文，也不是 session registry。
