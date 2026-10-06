# Cleo v0.7.1 后端 Characterization Tests

本文说明 `tests/characterization/` 这套测试固定了哪些行为、为什么这样划分前端与后端，以及重构时如何使用它们。基线是 `main` 上的 **v0.7.1**（`71de4e6`）。

Characterization test（特征测试 / golden master）记录的是系统**当前实际怎么做**，而不是"应该怎么做"。快照里因此包含若干现有缺陷与怪异行为（见文末），重构期间它们也必须保持不变，修复要作为单独、显式的行为变更来做。

## 1. 测试边界：为什么在进程边界上测

```text
 Electron renderer ── preload IPC ── Electron main ──JSONL stdio──► python -m cleo.desktop.server
                                                     ▲                      │
                                       特征测试驱动这里                       ├─► OpenAI 兼容 HTTP ──► FakeLLM（测试替身）
                                                                            ├─► ACP stdio 子进程 ──► fake_acp_agent.py（测试替身）
                                                                            └─► 磁盘：CLEO_HOME（config / memory / data）
```

- 每个测试会：建一个独立的 `CLEO_HOME` 和 Git 工作区，启动真实的 `python -m cleo.desktop.server` 子进程，再像 `ui/electron/backend.mjs` 一样逐行发 JSON 请求。
- 后端内部**一行都不 patch**。测试替身只放在进程/网络边界：
  - 聊天模型：配置文件里一个普通的 `provider: openai` 连接，`base_url` 指向本地 `FakeLLM`。
  - 开发任务：harnesses.json 里一个普通的 `type: acp` provider，命令指向 `fake_acp_agent.py`。
- 断言对象只有三类外部可观察输出：
  1. 协议回复与流式事件；
  2. 写到磁盘的数据；
  3. 后端发给模型和 harness 的请求。

这样，重构可以任意改模块、类和函数，只要这三类输出不变，测试就继续通过。现有的 `tests/desktop/test_service.py` 等白盒测试大量直接访问私有属性（约 92 处）并替换内部方法，重构时必然要重写，所以不能当安全网。

## 2. 前端还是后端：划分与理由

| 层 | 范围 | 本轮是否新增特征测试 | 理由 |
| --- | --- | --- | --- |
| **后端（Python）** | `cleo/` 全部：协议服务、use case、session/memory 持久化、harness 适配、MCP 服务器、后台记忆整理进程 | **是**，`tests/characterization/` 共 51 个测试 | 这是重构对象。对外契约有：JSONL 协议、磁盘格式、发给 LLM/harness 的请求、子进程入口 |
| **前端·渲染层（React）** | `ui/src/` | 否 | 不在重构范围。它只通过 `CleoClient` 消费协议；协议快照（`golden/`）就是它依赖的契约，后端不变它就不受影响 |
| **前端·Electron 主进程** | `ui/electron/*.mjs` | 否（保留现有 Node 测试作为回归门） | 虽然里面约 75% 是业务逻辑（自我进化、更新、发布、运行时安装），但它跑在另一个运行时，与 Python 只通过协议和少数一次性子进程交互。其中 bootstrap/recovery 必须先于可变代码加载，部分文件还被原样复制进安装包，不适合在本轮后端重构中移动 |

前端回归门沿用现有命令：`npm --prefix ui run typecheck`、`test:backend`、`test:evolution`、`smoke:real`（真实 JSONL IPC）。

> Electron 主进程直接调用的 Python 入口（`cleo.desktop.server` 导入探测、`cleo.memory.worker` 参数校验）属于后端契约，已放进 `test_entrypoints.py`。

## 3. 行为目录

| 编号 | 文件 | 固定的行为 | 为什么重要 |
| --- | --- | --- | --- |
| B1 | `test_protocol.py` | 未知方法、私有方法、缺参与多余参数时的错误封包；畸形行被忽略；非 dict 参数视作空参数；请求并发处理；`cancel_run` 只作用于指定 run；`shutdown` 先回复再退出；stdin 关闭即退出；stdout 只有 JSON；API key 从不越过协议（每个测试 teardown 都检查） | Electron 只认这个封包；重构最容易在这里出错，例如把日志打到 stdout |
| B2 | `test_workspace_config.py` | 空 home 的 workspace 快照；只读目录（runtime catalog、模型设置、订阅目录、harness 同步、本地 skills、ACP 模型列表）；项目登记/移除/恢复与 `runtime.json`；AGENTS.md 读写；模型连接 CRUD、cleo.json 落盘格式、重启后生效 | 设置页和项目栏的全部数据来源；配置文件是用户资产 |
| B2b | `test_hot_reload.py`（S1b 新增） | 不重启后端：协议保存的连接与外部编辑立即进入 catalog 和下一回合；运行中的回合用开始时的配置，同一线程下一回合重建 agent（工具设置更新，模型仍按线程的 `chat_profile`）；无效 JSON / 无效取值保留旧配置并报告错误（不回显输入值）；数据目录变化回报 `restartRequired`，改回后清除；`harnesses.json` 新增 provider 可建任务、禁用后不能再建 | 热加载是 S1b 新增的行为，Electron 依赖 `hotReload` 标记决定是否重启后端 |
| B3 | `test_chat.py` | 首轮流式事件、发给 LLM 的请求（角色、工具列表、system prompt 含 AGENTS.md/MEMORY_POLICY）、manifest/events/compact/索引/memory_state 落盘；进程被杀后恢复历史；模型失败的持久化与重新加载；输入校验错误；**编辑历史消息（rewind，0.7 新增）**；附件；全部聊天 slash 命令；删除；空线程隐藏 | 主聊天的完整生命周期 |
| B4 | `test_productivity.py` | 带计划/工具/写文件的任务轮次、Git checkpoint 与 change history；撤销；默认策略自动拒绝权限；用户审批往返；取消与非 completed 结束原因；重启后恢复原生会话；运行参数（model/effort/approval）及校验；全部开发 slash 命令；boundary steering（运行中追加指令）；ACP 不提供 rewind；创建/删除错误 | 开发任务的完整生命周期，经过真实 ACP provider |
| B5 | `test_memory.py` | 待确认记忆队列、证据详情、跳过；DreamAgent 手动整理（MEMORY.md、memory 仓库 git 提交、状态机）；**优雅关闭时把聊过的线程交给后台 DreamAgent 进程** | 长期记忆的唯一写入路径，有状态机和证据约束 |
| B6 | `test_legacy_home.py` | v0.7.1 写出的冻结数据目录：workspace/线程/时间线分页/长内容读取/记忆加载；继续旧聊天时只回放有效历史（跳过 rewind 部分）；继续旧任务时 `session/load` 原生会话；缺失索引时的行为 | 重构后用户已有数据必须原样可读 |
| B7 | `test_entrypoints.py` | 交给 harness 的 MCP 服务器命令行、工作目录和 prompt 封装；各 MCP 服务器的工具目录（名称/描述/schema）；agent tool server 三种模式；Electron 导入探测、后台记忆整理进程的参数校验、CLI 已移除 | harness 与 Electron 以命令行调用这些入口，不经过协议 |
| B8 | `test_formats.py` | v0.7.1 日志的 `event_content_hash` 必须可复现；compact / timeline 投影；secret 脱敏与工具输出截断；git diff 投影 | `source_hash` 已写进用户的 manifest 和 memory_state，算法一变，所有旧会话都会被当成"已修改"并重新整理 |

## 4. 确定性处理

`support/golden.py` 会把易变值替换成稳定占位符。同一个原值在一份快照里总是映射到同一个占位符，所以"某条事件属于哪个 turn"这类关系仍然会被检查。

- **ID**：`<thread:N>`、`<turn:N>`、`<event:N>`、`<agent:N>`、`<hex:N>`、`<uuid:N>`、`<notice:N>`。
- **时间与耗时**：时间戳 → `<time>`，相对时间 → `<relative-time>`，`HH:MM` → `<clock-time>`，`elapsedMs` 等 → `<number>`。
- **游标与路径**：游标/revision → `<cursor:N>`；机器路径 → `<HOME>`、`<WORKSPACE>`、`<ROOT>`、`<USER>`、`<REPO>`、`<PYTHON>`、`<LLM_URL>`（大小写与分隔符差异都会归一）。

`support/views.py::collapse_stream` 用于消除时序噪声：

- 丢弃按墙钟节流的 `timing running` 进度事件；
- 把同一条目的连续 `upsert-item` 合并为最后一次。

条目最终内容和出现顺序仍被固定。另有断言单独检查流式确实是增量的。

**短路径**：每个测试的 home 与工作区放在系统临时目录下的 `cleo-char-xxxxxxxx`（约 50 字符），不使用很深的 pytest 临时目录。原因是 Q12：在长路径下，v0.7.1 的撤销记录会因 Windows 路径上限而失败，快照就会随机器和目录深度变化。这是在验证阶段换用更长的临时目录后发现并复现的。Q12 已在 S9 修复，并由 `test_long_workspace_paths_keep_the_undo_record` 单独覆盖；短路径仍保留，让其余快照不受机器目录深度影响。可以用 `CLEO_CHAR_TMP` 指定其他父目录。

**ACP 通知节奏**：`fake_acp_agent.py` 每发一条 `session/update` 后等待 0.25 秒（`CHAR_ACP_PACE`），工具开始后等待 1 秒（`CHAR_ACP_TOOL_PACE`），模拟真实的模型驱动 agent，同时避开 Q11 的竞态窗口。

工具开始后要多等一会，是因为 Cleo 在推送每个新条目之前，会先在线程里查一次时间线索引（SQLite）来计算位置。"开始"和"完成"两条通知由不同任务处理，查询慢时"完成"会先于"开始"到达界面。只用 0.25 秒间隔时，曾在 6 次整模块运行中出现过 1 次 `productivity/tool_turn` 的顺序差异，这就是 Q11 本身。节奏只改变替身的时序，不改变后端代码。

**验证方式**：快照录制后，在三个不同的 pytest 临时目录下连续运行三次全量验证，结果一致才算确定。compact 的字符统计包含路径长度，因此 `raw_characters` / `compact_characters` 记为 `<path-dependent>`。

## 5. 运行与更新

```bash
.venv/Scripts/python.exe -m pytest tests/characterization -q
```

行为变更是有意为之时，重新录制快照，并在 code review 里逐个审阅 `golden/` 的 diff：

```bash
CLEO_UPDATE_GOLDEN=1 .venv/Scripts/python.exe -m pytest tests/characterization -q
```

`fixtures/legacy_home_v0_7_1/` 只能用 v0.7.1 代码生成（`python -m tests.characterization.fixtures.build_legacy_home`）。**重构后不要再重新生成**，否则"旧数据可读"的保证就失效了。

整套 51 个测试在开发机上约 4 分钟（每个测试启动一个独立后端进程）。

## 6. 快照中固定下来的现有缺陷与怪异行为

以下行为被如实固定。重构期间**保持不变**；要修复时作为单独的行为变更提交，并同步更新对应快照。

| # | 行为 | 位置（快照） | 根因线索 |
| --- | --- | --- | --- |
| Q1 | **已修复（S9）**：原先 ACP 任务里不带参数的 `/model` 返回 `TypeError: AcpProvider.list_models() missing 1 required positional argument: 'project_path'`；现在列出该 harness 在任务目录下探测到的模型 | `productivity/slash_commands` | `AgentService.list_models()` 现在把任务目录传给 provider；Codex 接受并忽略这个参数 |
| Q2 | ACP 工具调用：实时流显示"完成"，重新加载后显示"失败：运行已结束，但没有收到该工具的完成记录"，外加一条孤立的结果项 | `productivity/tool_turn` | 实时投影（`stream_event_item`）与持久化投影（`timeline_from_events`）对 `tool_call_update` 的关联规则不一致 |
| Q3 | ACP `plan` 更新已持久化，但实时和重新加载时都不显示 | `productivity/tool_turn` | 投影只认 Codex 的计划 payload 格式 |
| Q4 | **已修复（S9）**：原先 ACP 工具名一律显示为 `tool`，命令为空；现在名称取 `title`（如 “Read README.md”），命令取 `rawInput` 中的 command / path 等字段，没有时显示紧凑 JSON。实时与重新加载两种投影一致，旧会话重新加载时同样生效 | `productivity/tool_turn`、`legacy/workspace`、`legacy/timeline_paging`、`formats/projections_task` | 两种投影共用 `_tool_name` / `_tool_command`；Codex 与 Claude 原有的字段优先级不变 |
| Q5 | **已修复（S9）**：原先缺少 `sessions.sqlite3` 时 `load_workspace` 返回空线程列表，直到某个线程被按 ID 打开才重建索引；现在后端打开存储时发现索引文件不存在就从 manifest 重建，列线程和按原生会话查找前也会检查 | `legacy/missing_index` | `SqliteSessionIndex.ensure()` 报告是否新建了数据库文件，`SessionStore` 据此重建 |
| Q6 | ACP 任务默认审批是 `deny_all`，桌面虽然调用了 `enable_user_approvals`，权限请求仍被自动拒绝，用户要手动改成 `user` | `productivity/permission_denied_by_policy` | approval broker 的 enabled 与 host 的 approval_mode 是两个独立开关 |
| Q7 | **已修复（S9）**：原先通过 ACP `fs/write_text_file` 新建的文件不出现在 `changes`，却出现在 change history；现在未跟踪文件在 `changes` 中显示为新增文件（实时刷新、重新加载和 `/diff` 一致） | `productivity/tool_turn`、`productivity/slash_commands` | `read_git_diff` 为未跟踪文件生成 `git diff --no-index` 的新文件 diff（遵守 .gitignore，最多 50 个、单个不超过 1 MB，其余仍按文件名列出） |
| Q8 | **已修复（S9）**：原先未知 provider 创建任务时，界面收到原始的 `KeyError: 'does-not-exist'`，已禁用的 provider 则是 `KeyError: 'Unknown agent provider: …'`；现在分别提示“未找到开发任务 harness：…。请先在设置中添加。”和“Harness '…' 已禁用或不可用。” | `productivity/create_delete`、`workspace/hot_reload_harnesses` | `_productivity_provider` 对未知名称抛 `ValueError`；`create_thread` 在创建会话前检查 provider 已启用并已注册 |
| Q9 | （已随 CLI 在 v0.8 移除）`python -m cleo.cli.application` 什么都不做 | — | CLI 整体移除后不再适用 |
| Q10 | 模型调用失败不会产生 `error` 流事件，而是协议级错误回复；持久化的错误文本是 SDK 原文 | `chat/model_failure` | `_stream_chat` 只把 `CancelledError` 转成事件 |
| Q11 | **竞态（已观察到）**：ACP `session/update` 通知被并发处理，落盘与实时推送的顺序没有保证。在机器高负载时实际观察到：同一个工具调用"运行中"的更新晚于"完成"到达，实时界面上这个工具一直显示运行中，重新加载后才变化。`prompt` 响应也可能先于最后几条通知处理完 | 无（假 agent 以 0.25 秒间隔发通知规避，见 `fake_acp_agent.PACE`；高负载下仍可能偶发） | `acp/connection.py:158` 为每条通知单独创建任务；`AgentService._prompt` 的 relay 在各任务里 `to_thread` 追加事件 |
| Q12 | **已修复（S9）**：原先 Windows 上工作区路径超过约 170 字符时，开发任务这一轮的撤销与变更历史会被静默丢弃：`canUndo` 为 false，没有 `turn_diff`，也没有任何用户可见的提示 | `productivity` 的 `test_long_workspace_paths_keep_the_undo_record` | undo ref 名使用完整 sha256：`<工作区>/.git/refs/cleo/undo/<64 位 hex>.lock` 超过 260 字符，`git update-ref` 报 `Filename too long`；`_stream_productivity` 只在调试日志里记录 "Git checkpoint unavailable"。修复：git 调用带 `core.longpaths=true`，ref 名改用 16 位 hash；创建回退记录失败时在对话中显示“这一轮无法撤销”警告 |

## 7. 本轮未覆盖的范围

| 范围 | 原因 | 现有保护 |
| --- | --- | --- |
| Codex/Claude SDK 专属能力：原生 steering、快速模式、Codex 审批语义、提问（questions）、productivity rewind、harness 切换 | 需要伪造 Codex app-server JSON-RPC 或 Claude CLI，协议面很大，而且与 SDK 版本强耦合 | `tests/integrations/test_codex_*`、`tests/desktop/test_rewind.py`、`test_steering.py`、`test_harness_switch.py`、`test_task_questions.py` |
| 自我进化（evolution）、computer use、订阅登录、依赖更新、release repair | 依赖 Electron、GitHub、真实桌面或外部 CLI | `ui/tests/evolution-*`、`tests/desktop/test_evolution*.py`、`tests/integrations/test_computer*.py` |

建议的下一步：在 provider 端口（`AgentProvider` 及其能力接口）处加一个脚本化的 Codex 语义 provider，用于覆盖第一行的能力。这个接缝在新架构里会保留（见 `BACKEND_ARCHITECTURE_V2.md`）。
