# Harness 交互式问答、审批与回合生命周期：原生协议、Cleo 适配与架构判断

本文记录 #152（合并自 #135 / #147 / #151）的调查与修复，写给没有参与那次排查的人。三部分内容：

1. 每个 harness 的原生协议长什么样：提问 / elicitation、答案回传、权限审批、回合结束、后台任务与多阶段回复，带真实类型名、字段和载荷。
2. Cleo 怎样把它们适配到内部统一抽象；issue 列出的每个故障分支的根因结论与修法。
3. 是否值得为每个 harness 再做一层"adapter"：证据、利弊和建议路径。

所有标识符、路径与载荷来自仓库当前源码和 2026-10-30 在真实运行时上的探测，不是历史检查记录。

## 0. 版本依据与验证方式

| 对象 | 实际值 | 来源 |
| --- | --- | --- |
| Cleo 已安装 runtime | 0.12.1，`%LOCALAPPDATA%\Cleo\runtimes\online\beb351bc…` | `ready.json` |
| claude-agent-sdk / 内置 Claude Code CLI | 0.2.174 / 2.1.310 | runtime `site-packages`、`_cli_version.py`；与 `requirements.txt` 一致 |
| 开发 `.venv` | claude-agent-sdk 0.2.158 / CLI 2.1.280 | 用于单测；协议帧与 0.2.174 一致 |
| openai-codex（Python SDK）/ openai-codex-cli-bin | 0.163.0 | runtime；`.venv` 为 0.156.0 |
| agent-client-protocol（ACP） | 0.12.1 | runtime |
| Claude 登录目录 | 用户自己的 `~/.claude`（`CLAUDE_CONFIG_DIR` 未设置） | `cleo/integrations/harness_home.py` |

真实运行探测脚本已提交为可选冒烟（需登录，各约两次小模型请求）：

- `tests/integrations/claude_question_smoke.py`：`AskUserQuestion` 经 Cleo 的 `ClaudeProvider` 往返。
- `tests/integrations/claude_background_smoke.py`：`Bash(run_in_background=true)` 的阶段回复与唤醒轮次。

两者在 `acceptEdits` + haiku 下 PASSED。`bypassPermissions`（evolution 会话使用）没有做真实运行：执行环境拒绝带 `--dangerously-skip-permissions` 启动 CLI；该模式只有单测 `tests/integrations/test_questions.py::test_claude_native_callback_round_trip_even_under_permissive_mode` 覆盖 hook + 回调接线。

## 1. 各 harness 的原生协议

### 1.1 Claude Agent SDK（任务入口 `claude`，`cleo/integrations/harnesses/claude.py`）

传输：`ClaudeSDKClient` 启动内置 `claude.exe --output-format stream-json --verbose`，双向 JSONL。消息由 `claude_agent_sdk._internal.message_parser.parse_message` 解析为 dataclass：`SystemMessage`、`AssistantMessage`、`UserMessage`、`ResultMessage`、`StreamEvent`，以及 `SystemMessage` 的子类 `TaskStartedMessage` / `TaskProgressMessage` / `TaskNotificationMessage` / `TaskUpdatedMessage` / `HookEventMessage`。

**提问（AskUserQuestion）。** 不是独立消息，而是一次普通工具调用加一次控制请求：

1. 模型发出 `AssistantMessage.content = [ToolUseBlock(name="AskUserQuestion", input=...)]`，`input` 形如：

   ```json
   {"questions": [{"question": "What is your favourite colour?", "header": "Colour",
                   "multiSelect": false,
                   "options": [{"label": "Red", "description": "Red"}, {"label": "Blue", "description": "Blue"}]}]}
   ```

2. CLI 在执行工具前走权限流程。若宿主注册了 `PreToolUse` hook（`HookMatcher(matcher="AskUserQuestion")`），先收到 `control_request{subtype:"hook_callback"}`，hook 返回
   `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask"}}` 可以强制下一步，即使 permission mode 是 `acceptEdits` / `bypassPermissions`。
3. CLI 发 `control_request{subtype:"can_use_tool", tool_name, input, tool_use_id, permission_suggestions, blocked_path}`；SDK 在独立 task 里调用 `ClaudeAgentOptions.can_use_tool(tool_name, input_data, context)`（`_internal/query.py::_handle_control_request`），**流继续读取**，所以回调可以等待任意久。
4. 宿主返回 `PermissionResultAllow(updated_input={**input, "answers": {"<question 文本>": "<答案>"}})` 即"代替用户回答"；返回 `PermissionResultDeny(message, interrupt)` 则工具失败，模型会改用文本提问。
5. CLI 把答案作为工具结果回灌：`UserMessage.content = [ToolResultBlock(tool_use_id, content='The user answered: "What is your favourite colour?"="blue". Read the answers carefully …')]`，模型继续，本轮以一个 `ResultMessage` 结束。

**权限审批。** 同一条 `can_use_tool` 通道；`ResultMessage.permission_denials` 列出被策略拒绝的工具（`tool_name`、`tool_input`、`tool_use_id`）。

**回合结束。** `ResultMessage{subtype:"success"|"error_*", is_error, stop_reason ("end_turn"|"cancelled"|…), result, errors, permission_denials, uuid, session_id, terminal_reason, origin}`。`ClaudeSDKClient.receive_response()` 在第一个 `ResultMessage` 后停止；`receive_messages()` 不停。

**后台任务与多阶段回复。** 这是 #152 第二个场景的协议事实，来自 2026-10-30 的真实帧序列（`Bash(run_in_background=true)`）：

```text
assistant  tool_use Bash {"command":"sleep 6 && echo BG_DONE","run_in_background":true}
system     background_tasks_changed {"tasks":[{"task_id":"bce5a1xk0","run_id":"0mvvee2kg-d8b1579d","task_type":"local_bash","description":"Sleep 6 seconds then echo BG_DONE"}]}
system     task_started {"task_id":"bce5a1xk0","tool_use_id":"toolu_01TND…","is_backgrounded":true,"task_type":"local_bash",…}
user       tool_result "Command running in background with ID: bce5a1xk0. Output is being written to: …"
assistant  text "STAGE1: started"
result     {"subtype":"success","stop_reason":"end_turn","result":"STAGE1: started","terminal_reason":"completed",…}
   ← 旧实现在这里返回；以下帧仍在同一条流上
system     task_updated {"task_id":"bce5a1xk0","patch":{"status":"completed","end_time":…}}
system     task_notification {"task_id":"bce5a1xk0","status":"completed","output_file":"…/tasks/bce5a1xk0.output","summary":"Background command \"Sleep 6 seconds then echo BG_DONE\" completed"}
system     background_tasks_changed {"tasks":[]}
system     init {…}                       ← 第二个 init：CLI 自己开启了后续轮次
assistant  text "STAGE2: BG_DONE"
result     {"subtype":"success","result":"STAGE2: BG_DONE","origin":{"kind":"task-notification","producer":"session-task","runId":"0mvvee2kg-d8b1579d"},…}
```

要点：CLI 不回显任何新的 user 消息，而是在后台任务完成时自行唤醒模型再跑一轮；唤醒轮次的 `ResultMessage.origin.kind == "task-notification"` 可用于归属；`background_tasks_changed.tasks` 是当前后台任务的完整快照。SDK 的 `Query._track_task_lifecycle` 只为子 agent 类任务做类似跟踪（`DEFERRING_TASK_TYPES`），不把后台 shell 计入，这是 SDK 自己 stdin 关闭策略的权衡，不是宿主应复用的语义。

取消：`ClaudeSDKClient.interrupt()` 只对进行中的轮次有效，产生 `stop_reason:"cancelled"` 的 result；空闲等待期间没有东西可中断。`stop_task(task_id)` 可停止后台任务（会再产生 `task_notification{status:"stopped"}`）。

### 1.2 Claude Code 官方 CLI（聊天入口 `claude_code`，`cleo/integrations/claude_cli.py`）

`ClaudeCliProvider.prompt` 以 `claude -p --output-format stream-json` 单次运行，逐行读取 `{"type":"assistant"|"user"|"result",…}`，不注册 `can_use_tool`，没有 hooks。因此：

- 没有原生问答通道：`AskUserQuestion` 在该模式下不会向宿主请求答案，模型只能用文本提问。
- 回合结束只看 `type:"result"`，进程随即退出，后台任务随进程终止。

这是能力限制，不是缺陷；`Capability` 上它也没有声明 `QUESTIONS`。

### 1.3 Codex app-server（任务入口 `codex`，`cleo/integrations/harnesses/codex.py`、`codex_approvals.py`）

传输：`openai_codex.AsyncCodex` 通过 app-server JSON-RPC 与 `codex` CLI 通信；一次 `turn_start` 后 `AsyncTurnHandle.stream()` 产出 notification（`method`, `params`）。宿主请求通过同步回调 `sync_client._approval_handler(method, params)`（`CodexProvider._client_with_approvals`）进入，运行在 SDK 的工作线程，必须返回响应字典。

**提问。** `item/tool/requestUserInput`，params：

```json
{"itemId": "call_01", "threadId": "…", "turnId": "…",
 "questions": [{"id": "q1", "question": "Deploy where?", "header": "Target",
                "options": [{"label": "staging", "description": "…"}], "isSecret": false}]}
```

响应：`{"answers": {"q1": {"answers": ["staging"]}}}`。Codex 当前是单选 / 文本协议；空 `answers` 表示未回答。

**权限审批。** `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`（响应 `{"decision": "accept"|"acceptForSession"|"decline"|"cancel"}`）、`item/permissions/requestApproval`（响应 `{"permissions", "scope": "turn"|"session"}`）、MCP elicitation `mcpServer/elicitation/request`（`mode: "url"|"form"`，响应 `{"action", "content"}`；Cleo 只支持确认和链接授权，表单返回不支持并提示取消）、以及旧版 `execCommandApproval` / `applyPatchApproval`。

**回合结束。** `turn/completed{turn:{status:"completed"|"interrupted"|"failed"|"inProgress", error}}`，`CodexProvider._turn_status` 映射为 `completed` / `cancelled` / `failed` / `running`。流在 `turn/completed` 后结束；没有后台任务的概念，长命令由 `item/commandExecution/outputDelta` 持续输出直到 item 完成。

### 1.4 ACP（`opencode` 等，`cleo/integrations/harnesses/acp.py`，agent-client-protocol 0.12.1）

- 回合：`connection.prompt(session_id, [text_block])` 返回 `PromptResponse.stop_reason`（`"end_turn"`、`"cancelled"`、`"max_tokens"`、`"refusal"` …）。
- 流式：`session/update` 通知，`sessionUpdate` 取 `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan`。
- 审批：`session/request_permission(sessionId, toolCall{toolCallId,title,rawInput}, options[{optionId,name,kind: allow_once|allow_always|reject_once|reject_always}])`，响应 `RequestPermissionResponse(outcome=AllowedOutcome(outcome="selected", option_id=…))` 或 `DeniedOutcome(outcome="cancelled")`。
- **没有问答接口**：`AcpProvider.capabilities = {USER_APPROVALS}`。把 `request_permission` 当作问答是错误的：它的选项由 agent 给定，不是自由文本。

### 1.5 能力矩阵（当前源码）

| 入口 / harness | 原生问答 | 用户审批 | 回合结束信号 | 后台 / 多阶段 | Cleo `Capability` |
| --- | --- | --- | --- | --- | --- |
| 任务 `claude`（Agent SDK 0.2.174） | `AskUserQuestion` 经 hook + `can_use_tool` | `can_use_tool` | `ResultMessage` | 有：后台任务完成后 CLI 自行唤醒新轮次 | `REWIND, QUESTIONS, USER_APPROVALS` |
| 聊天 `claude_code`（CLI stream-json） | 无（文本回退） | 无 | `type:"result"`，进程退出 | 无 | 无 |
| 任务 `codex`（openai-codex 0.163.0） | `item/tool/requestUserInput` | `*/requestApproval`、elicitation | `turn/completed` | 无 | `QUESTIONS, USER_APPROVALS, NATIVE_STEER, FORK, …` |
| ACP（0.12.1） | 无 | `session/request_permission` | `stop_reason` | 无 | `USER_APPROVALS` |

## 2. Cleo 的内部抽象与本次适配

### 2.1 现有层次

| 层 | 位置 | 作用 |
| --- | --- | --- |
| `AgentProvider` 协议、`ProviderSession` / `ProviderTurn` | `cleo/harnesses/provider.py` | 每个 harness 一个实现：`create_session` / `resume_session` / `prompt` / `cancel` / `close`；可选方法由 `Capability` 声明 |
| `Capability` + `REQUIRED_METHODS` + `capabilities_of` | `cleo/harnesses/capabilities.py` | 桌面端由此派生 `supportsQuestions`、`steerMode` 等，而不是比较 harness 名 |
| `AgentEvent{provider, type: str, text, data: dict}` | `cleo/harnesses/models.py` | 唯一的内部事件模型；`data.provider_event_type` / `data.payload` 透传原生载荷 |
| `QuestionBroker` + `normalize_questions` | `cleo/harnesses/questions.py` | provider 无关的"必须显式回答"的问答：`ask()` 发 `question_request`、等待 future；`resolve()` 先持久化 `question_response` 再释放等待；`cancel_all()`；Codex 走 `ask_sync` |
| `PermissionBroker` | `cleo/harnesses/approvals.py` | Claude / ACP 的异步审批：`permission_request` / `permission_response`，`record()` 记录策略决定 |
| `CodexApprovalBroker` | `cleo/integrations/harnesses/codex_approvals.py` | 把 app-server 的同步回调桥接到异步 UI；内含一个 `QuestionBroker` |
| `AgentService.prompt` → `_prompt` → `relay` / `deliver` / `finalize` | `cleo/harnesses/service.py` | 给每个事件打 `turn_id` / `timeline_id`，单消费者按到达顺序落盘（`_stored_provider_event`），结束时写 `session_<status>` 与最终 `assistant_message` |
| `stream_event_item` / `timeline_from_events` | `cleo/desktop/projection.py` | 实时与重载两条投影；`question_request` → `question-request`，`tool_call` / `tool_result` → tool 条目 |
| `DesktopService` | `cleo/desktop/service.py` | `_enable_desktop_approvals` 调 `enable_questions` / `enable_user_approvals`；`get_pending_questions`、`resolve_question` RPC；`RunSupervisor` 管运行与取消 |
| 渲染端 | `ui/src/useQuestions.ts`、`ui/src/components/QuestionDialog.tsx` | 弹窗、草稿、重试；运行结束时 `finish()` 把仍 pending 的问题标为 unavailable |

### 2.2 逐分支的根因结论（#152 列出的排查分支）

| 分支 | 结论 | 依据 |
| --- | --- | --- |
| 未产生原生问答请求 | 任务入口：否。模型发出 `AskUserQuestion`，hook 与 `can_use_tool` 都被调用 | 真实运行日志：`HOOK PreToolUse AskUserQuestion` → `CAN_USE_TOOL AskUserQuestion` |
| 请求未传入 Cleo | 否。`ClaudeProvider._connect.can_use_tool` 调 `normalize_questions(..., claude=True)` 后 `questions.ask()`，`question_request` 事件到达 `on_event` | `probe` 事件序列：`tool_call, question_request, question_response, tool_result, thought, agent_message` |
| 被降级为普通最终文本 | **只在没有问答回调的入口发生**：`QuestionBroker.ask()` 在 `callback is None` 时返回 `None` → `PermissionResultDeny("用户未提交答案…")` → 模型文本提问。聊天入口（`cleo/agents/runtime.py`）从不调用 `enable_questions`，`claude_code` 聊天更是没有 `can_use_tool`。任务入口在 `_adopt_productivity_session` / `_enable_desktop_approvals` 中启用，不会降级 | `questions.py::ask`、`claude.py` 的 `PermissionResultDeny` 分支、`desktop/service.py:1515, 2853` |
| 弹窗未显示 | 后端侧：`question_request` 已持久化且 `get_pending_questions` 返回 pending；UI 侧归并行的 UI 会话排查 | `_stored_provider_event` 为 `question_request` 写 `id = "<question id>:question_request"`；`load_timeline` 以 `pending_questions` 校正状态 |
| 答案回传失败 | 否。`resolve_question` → `QuestionBroker.resolve`（先 emit `question_response` 再 `future.set_result`）→ `can_use_tool` 返回 `PermissionResultAllow(updated_input.answers)` → CLI 回灌 `tool_result` | 真实运行：`RESOLVED {...answers: {'0': ['blue']}}` 后出现 `tool_result "The user answered…"`，最终 `FINAL: you chose blue.` |
| 等待用户期间提前结束轮次 / 清理回调 | 否。SDK 把 `can_use_tool` 放在独立 task，流不会因等待而结束；`ClaudeProvider.prompt` 只在 `finally` 清理 broker | `_internal/query.py` `spawn_task(self._handle_control_request(...))`；3 秒人工延迟的探测仍得到单个 result |
| 后续消息未产生 | 否。CLI 会产生唤醒轮次（见 1.1 帧序列） | 真实帧序列 |
| 后续消息未持续消费 / 归属错误 / 未持久化 | **是，这是后台场景的根因。** 旧 `prompt()` 用 `receive_response()`，第一个 `ResultMessage` 即返回、置 `active=False`、`cancel_all()`。聊天入口随后 `provider.close()` 断开连接，后台任务随 CLI 退出；任务入口把唤醒轮次留在流上，下一次用户 prompt 的 `receive_response()` 会先读到它，于是 STAGE2 被当作新一轮的回复（归属错误），没有新 prompt 时则永不消费、永不持久化 | 修复前用 Cleo provider 跑真实 CLI：`TURN status=completed response="STAGE1: started"`，STAGE2 丢失 |
| 已落盘但 UI 未展示 | 不适用：修复前根本没有落盘 | 同上 |
| SDK / CLI 版本或运行模式不支持 | 否。0.2.174 / 2.1.310 支持 `can_use_tool`、hook 与任务帧；`receive_messages()` 可持续读取 | SDK 源码与真实运行 |

### 2.3 修法（PR #155）

只改 `cleo/integrations/harnesses/claude.py` 与文案，不改 service、projection、UI：

1. **消费整条流而不是一个回合。** `prompt()` 改用 `receive_messages()`；跟踪 `_ClaudeRuntime.background`（`task_id → {description, task_type, tool_use_id, status}`）：`background_tasks_changed.tasks` 为权威快照，`task_started{is_backgrounded}` 登记，`task_notification` / 终态 `task_updated` 结束。`ResultMessage` 到来时若仍有后台任务，写入 `status` 事件 `claude/stage_completed`（payload 含 `stage`、`result`、`origin`、任务列表），置 `runtime.waiting = True` 并继续读；直到某个 result 到来时 `background` 为空才返回。阶段回复与最终回复都在同一个 `turn_id` 下按顺序追加；`AgentService.finalize` 原有的"最终答案与最后一条 `agent_message` 相同则复用 timeline id"逻辑保证不重复。
2. **后台任务可见。** 登记时发 `tool_call{id: task_id, name: "后台任务", input: description}`，结束时发 `tool_result{tool_use_id: task_id, output: summary, status}`。现有 `stream_event_item` / `timeline_from_events` 直接把它显示为 running → done 的工具条目，不需要 UI 改动。
3. **有界等待与归属安全。** `CLEO_CLAUDE_BACKGROUND_WAIT_SECONDS`（默认 600 秒，按帧间静默计时，`0` 表示不等待）。超时、等待中 `cancel()` / `close()`、或 result 为错误 / 取消而仍有后台任务时：剩余任务条目标为失败、写 `claude/background_abandoned`、断开流并置 `needs_reconnect`，下一次 prompt 以原生 session 重连——迟到的唤醒轮次不可能串入后续用户轮次。`cancel()` 在等待阶段不再对空闲流发 `interrupt()`（没有可中断的轮次），而是丢弃流；唤醒轮次进行中仍走 `interrupt()`。
4. **问答与审批跨阶段保持可答。** broker 只在 `finally` 取消，`can_use_tool` 在唤醒轮次里照常工作（单测 `test_questions_stay_answerable_in_the_wake_up_turn`）。

为什么不改 service / UI：阶段回复是普通 `agent_message`，后台任务是普通 tool 条目，终态仍是一个 `session_completed`；把"多阶段"压回现有事件词汇，上层无需知道 Claude 的后台语义。代价是等待期间该 turn 仍处于 running：UI 照常排队用户的新消息（现有行为），不会把新输入接到旧任务上，但长期运行的后台 shell（如 dev server）会在 600 秒静默后随本轮结束并被断开，而不是无限 loading。

### 2.4 没有改动、仍需后续决定的点

- 聊天入口的 Claude 问答：要支持，需要 `ChatRuntime` 接 `question_request` 并在聊天 UI 提供弹窗；当前文本回退是刻意的。
- Codex / ACP 没有后台任务语义，不需要同类改动；Codex 的表单型 elicitation 仍不支持。
- 退出 / 重启后不承诺后台任务继续：CLI 进程随 Cleo 退出。

## 3. 是否需要为每个 harness 做一层 adapter

### 3.1 现状评估（证据）

Cleo 已经有"统一内部模型 + 每个 harness 一个适配器"的结构：`AgentProvider` 的三个实现（`ClaudeProvider`、`CodexProvider`、`AcpProvider`，加聊天用的 `ClaudeCliProvider`）就是适配器，`AgentEvent` / `ProviderTurn` 就是内部模型。问题不在"缺一层"，而在这一层的契约太弱：

| 观察 | 证据 | 后果 |
| --- | --- | --- |
| 事件类型是自由字符串 | `AgentEvent.type: str`；`AgentService._stored_provider_event` 维护一个 `known_types` 集合，未知类型落为 `provider_event`；Codex 用 `assistant_message_chunk`，Claude 用 `agent_message`，ACP 用 `assistant_message_chunk` + `phase` | 投影要为每种拼法写分支；新增生命周期事件（如阶段结束）没有地方声明 |
| 生命周期语义由各 provider 各自解释 | Codex 看 `turn/completed`，Claude 看 `ResultMessage`，ACP 看 `stop_reason`；"回合结束 ≠ 工作结束"只有 Claude 有，之前没有任何抽象表达它 | #152 的后台 bug 正是这个缺口 |
| 三个 broker 实现两种模型 | `QuestionBroker`（async future）、`PermissionBroker`（async future）、`CodexApprovalBroker`（threading.Event + `run_coroutine_threadsafe`，内嵌 `QuestionBroker`） | 取消、重试、持久化顺序各写一遍；Codex 的审批事件带 `schema_version: 1` + `method`，Claude 的带 `method: "can_use_tool"`，UI 靠 `_approval_item` 兼容 |
| 投影有两份 | `stream_event_item`（实时）与 `timeline_from_events`（重载），`docs/refactor/BACKEND_ARCHITECTURE_V2.md` P6 已记录过分歧 | 每个新事件要在两处对齐 |
| 没有基于真实帧的契约测试 | 现有单测用手写 `receive_response` 假客户端；没有任何测试回放真实 CLI 的帧序列 | SDK 升级或 CLI 行为变化（如本次的第二个 `init`）不会被发现 |
| 能力矩阵是显式的、可用的 | `Capability` + `REQUIRED_METHODS`，`tests/integrations/test_harness_capabilities.py` 双向校验 | 这是值得延伸的基础，而不是推倒 |

### 3.2 判断

**不建议再加一层独立的"格式转写 adapter"。** 理由：

- 再加一层只会把 `_event_from_notification`（Codex）、`_block_event`（Claude）、`session_update`（ACP）里的映射搬个位置，不解决契约弱的问题，却多一处要同步的代码。
- 真正缺的是三样东西：类型化的内部事件与生命周期词汇、共享的回合生命周期状态机、以及用真实帧驱动的契约测试。它们都可以在现有 provider 边界内完成。

**建议：收紧现有边界，而不是新增边界。**

### 3.3 建议的接口形状

```python
# cleo/harnesses/lifecycle.py（建议）
class TurnPhase(StrEnum):
    RUNNING = "running"              # 前台轮次进行中
    WAITING_USER = "waiting_user"    # 等待问答 / 审批
    WAITING_BACKGROUND = "waiting_background"  # 前台轮次结束，后台任务仍活动
    FINISHED = "finished"

@dataclass(frozen=True)
class StageCompleted:      # AgentEvent.type == "turn_stage_completed"
    stage: int
    result: str | None
    origin: dict | None    # Claude: ResultMessage.origin
    pending_tasks: tuple[BackgroundTask, ...]

@dataclass(frozen=True)
class BackgroundTask:      # tool_call / tool_result 之外的显式类型，供 UI 选择性展示
    id: str
    description: str
    task_type: str
    status: Literal["running", "completed", "failed", "stopped"]
```

配套：

- `Capability.BACKGROUND_TASKS`：声明 provider 会在 result 之后继续产出同一 turn 的事件；桌面端据此决定是否显示"等待后台任务"文案与是否允许排队输入。
- `AgentEvent.type` 收敛为 `Literal[...]`（或 `EventType` StrEnum），`provider_event_type` 继续透传原生名；`_stored_provider_event.known_types` 由枚举生成。
- `InteractionBroker`：把 `QuestionBroker` 与 `PermissionBroker` 的"发请求 → 持久化 → 等待 → 释放 / 取消"抽成一个泛型，`CodexApprovalBroker` 只保留线程桥接。
- 契约测试：`tests/integrations/fixtures/frames/<harness>/<scenario>.jsonl` 存真实帧（本次已有 Claude 的问答与后台两段），测试把帧回放进 provider，断言产出的 `AgentEvent` 序列与 `ProviderTurn`；SDK 升级时先跑它们。

### 3.4 分阶段路径

1. **固化证据（低风险）**：把 1.1 的真实帧与 Codex 的 `requestUserInput` / `requestApproval` 样例存成 fixture，补回放式契约测试；为 `ClaudeProvider` 的新逻辑已有 8 个单测可直接迁移。
2. **类型化事件（中）**：引入 `EventType` 枚举与 `turn_stage_completed` / `background_task` 类型，让 `stream_event_item` 与 `timeline_from_events` 共用一个 `event → item` 函数（顺带解决 P6）。
3. **统一 broker（中）**：抽 `InteractionBroker`，三个 harness 的问答 / 审批共用取消、重试、持久化顺序；UI 的 `_approval_item` 只认一种载荷。
4. **能力驱动的 UI（低）**：`Capability.BACKGROUND_TASKS` 进入 runtime profile，UI 在 `claude/stage_completed` 上显示"等待后台任务"，在 `background_abandoned` 上显示终止原因。
5. **再评估 adapter 层**：以上做完后，如果仍有第四个 harness 需要接入且映射代码重复明显，再考虑把 `_event_from_notification` 类函数提升为独立模块；在那之前，provider 就是 adapter。

## 4. 相关文件索引

- 适配器：`cleo/integrations/harnesses/claude.py`、`codex.py`、`codex_approvals.py`、`acp.py`、`cleo/integrations/claude_cli.py`
- 共享抽象：`cleo/harnesses/provider.py`、`models.py`、`capabilities.py`、`questions.py`、`approvals.py`、`service.py`
- 桌面与投影：`cleo/desktop/service.py`、`cleo/desktop/projection.py`、`ui/src/useQuestions.ts`
- 测试：`tests/integrations/test_claude_background_turns.py`、`test_questions.py`、`tests/desktop/test_task_questions.py`、`claude_question_smoke.py`、`claude_background_smoke.py`
- 相关 issue / PR：#152（跟踪）、#155（本修复）；历史 #135 / #147 / #151；能力矩阵见 `docs/DEVELOPMENT.md` "桌面历史与交互提问"。
