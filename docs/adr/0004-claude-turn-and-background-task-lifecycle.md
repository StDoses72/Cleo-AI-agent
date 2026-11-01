# 0004. Claude 回合与后台任务的生命周期归 provider 所有

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

#152（合并自 #135 / #147 / #151）报告两类现象：Agent 的弹窗提问像是被当成了最终回答；Claude 先给阶段性回复、后台继续工作、之后再回复的任务，Cleo 只拿到第一段。

调查前对"单一根因"没有共识，于是先在真实安装的运行时上探测（Cleo 0.12.1，claude-agent-sdk 0.2.174，内置 Claude Code CLI 2.1.310，`acceptEdits`）。结论见 `docs/harness/interactive-lifecycle.md` 第 2.2 节，摘要如下：

- 问答链路在任务入口是通的。`ClaudeProvider._connect` 用 `HookMatcher(matcher="AskUserQuestion")` 返回 `permissionDecision: "ask"` 强制走 `can_use_tool`，再经 `QuestionBroker.ask` → `resolve_question` → `PermissionResultAllow(updated_input={"answers": …})` 回传；CLI 把答案作为 `ToolResultBlock` 回灌，模型继续。被降级成纯文本只发生在没有问答回调的入口（聊天入口不调用 `enable_questions`），那是设计内的回退。
- 后台场景确有缺陷。Claude Code 的一个 `ResultMessage` 只结束一个前台轮次；`Bash(run_in_background=true)` 或后台 agent 完成时，CLI 在同一条流上自行唤醒模型再跑一轮（`task_notification` → 第二个 `init` → 回复 → 带 `origin.kind == "task-notification"` 的 result），不回显任何 user 消息。旧的 `ClaudeProvider.prompt` 用 `ClaudeSDKClient.receive_response()`，第一个 result 即返回、置 `active=False`、取消 broker：聊天入口随后 `close()` 断开连接杀掉任务；任务入口把唤醒轮次留在流上，被下一次用户 prompt 的 `receive_response()` 当作那一轮的回复（归属错误），没有后续 prompt 时则永不消费。

评审期间又用真实 CLI 发现：多个后台任务一起完成时，每个 `task_notification` 仍各产生一个 result，但前面的是 `num_turns: 0`、`result: ""` 的空 result，只有最后一个带回复——与官方 `SDKResultMessage.origin` 文档一致。此外 `task_started` / `task_notification` / `background_tasks_changed` 条目可能带 `ambient: true`（会话级 watcher，不属于本轮工作）。

既有抽象：`cleo/harnesses/provider.py` 的 `AgentProvider` / `ProviderTurn`，`cleo/harnesses/models.py` 的 `AgentEvent{type: str, data: dict}`，`cleo/harnesses/capabilities.py` 的 `Capability`，`cleo/harnesses/questions.py` 的 `QuestionBroker`，`cleo/harnesses/service.py::AgentService.prompt` 的 relay / 持久化，`cleo/desktop/projection.py` 的两份投影。

## Decision

1. **生命周期留在 provider 内部，用现有事件词汇表达，不新增独立的 adapter 层。** 现有的 `ClaudeProvider` / `CodexProvider` / `AcpProvider` 已经是"统一内部模型 + 每个 harness 一个适配器"的结构；缺的是契约强度（自由字符串事件类型、各 provider 各自解释回合结束、三个 broker 两种模型、两份投影、没有真实帧契约测试），而不是再多一层转写。本次修复只改 `cleo/integrations/harnesses/claude.py` 与文案：阶段回复仍是 `agent_message`，后台任务投影为 `tool_call` / `tool_result` 条目，阶段边界写 `status` 事件 `claude/stage_completed`，终态仍是一个 `session_<status>`。service、projection 与 UI 不需要知道 Claude 的后台语义。

2. **消费整条流，按"任务集合 + 欠账"判定完成。** `prompt()` 改用 `receive_messages()`；`_ClaudeRuntime.background` 以 `background_tasks_changed.tasks` 为权威快照，`task_started{is_backgrounded}` 登记，`task_notification` 结束条目并把 `_ClaudeRuntime.owed_wakeups` 加一，终态 `task_updated` 只记状态；带 `ambient: true` 的帧一律忽略。`ResultMessage` 到来时，若发生在阶段之后或 `origin.kind == "task-notification"`，`owed_wakeups` 减一；**只有 `background` 为空且 `owed_wakeups == 0` 才结束**。`num_turns: 0` 的空 result 只做记账，不发阶段事件。

3. **等待有界，终态按真实情况报告。** `CLEO_CLAUDE_BACKGROUND_WAIT_SECONDS`（默认 600 秒，按帧间静默计时）。超时返回 `status="failed"` 并以超时原因为 `error`——阶段回复仍在时间线里，但最终回复没有到，不能说完成；等待期间 `cancel()` / `close()` 返回 `cancelled`；`0` 是明确的不等待，返回阶段回复为 `completed`。这三种情况都把剩余任务条目标为失败、写 `claude/background_abandoned`、断开流并置 `needs_reconnect`，下一次 prompt 以原生 session 重连，迟到的唤醒轮次不可能串入后续用户轮次。等待阶段的 `cancel()` 不对空闲流发 `interrupt()`（没有可中断的轮次），而是直接丢弃流，循环立即结束。

4. **流提前结束是错误。** 唤醒轮次一开始（第二个 `init` 或 `AssistantMessage`）就丢弃上一阶段 `ResultMessage` 的引用；流在该轮次 result 之前结束、或在仍欠 result 时结束，`prompt()` 抛 `RuntimeError` 并置 `needs_reconnect`，不沿用上一阶段的结果。

5. **问答与审批跨阶段保持可答。** broker 只在 `finally` 取消，`can_use_tool` 在唤醒轮次里照常工作。

## Alternatives considered

- **新增一层按 harness 的格式转写 adapter（统一事件模型 + 每 harness 一个 adapter）。** 否决：这正是 provider 现在的角色，再加一层只是把 `_block_event` / `_event_from_notification` / `session_update` 搬个位置；缺的是类型化事件、共享的回合状态机和用真实帧驱动的契约测试，这些都能在现有边界内完成。建议路径见 `docs/harness/interactive-lifecycle.md` 第 3 节。
- **保持 `receive_response()`，在 prompt 返回后由后台 watcher 继续消费并作为新 turn 持久化。** 否决：需要 service 增加会话级订阅、desktop 增加 run 之外的推送通道、UI 增加展示；用户新 prompt 与进行中的唤醒轮次在同一条流上交错时的归属问题仍然存在。收益（等待期间输入框不显示 running）不抵复杂度；现有 UI 本来就会把运行期间的新消息排队而非丢弃。
- **以后台任务集合为空作为结束条件（评审前的实现）。** 否决：两个任务一起完成时，第一个空 result 到来时集合已为空，会漏掉带回复的最后一个 result。改为"集合为空且欠账为零"。
- **复用 SDK 自己的 `Query._track_task_lifecycle`。** 否决：它只跟踪子 agent 类任务（`DEFERRING_TASK_TYPES`），刻意不计后台 shell，服务于 SDK 的 stdin 关闭策略，不是宿主需要的"本轮工作是否结束"。
- **无限等待后台任务。** 否决：dev server 等永不结束的后台 shell 会让 turn 永远 running；issue 明确要求不能用永久 loading 代替后台支持。
- **超时后仍以阶段回复返回 `completed`（评审前的实现）。** 否决：把部分回答当作整体完成，评审 P2。改为 `failed` + 原因；只有用户显式设 `0` 时才接受阶段回复为完成。
- **把 `ambient` 任务也计入等待集合（评审前的实现）。** 否决：普通回答会因会话 watcher 等到超时并断开。

## Consequences

- 正面：阶段回复与最终回复归属同一 turn、按顺序落盘且不重复；后台任务在时间线里可见（running → done）；问答跨阶段可答；超时 / 取消 / 流断开都有明确终态且不会串轮；修复范围限于一个 provider 文件。
- 负面 / 限制：等待后台任务期间 turn 仍为 running，UI 会排队而不是立即处理新输入；长期后台 shell 在 600 秒静默后随本轮结束并被断开（不是原生 Claude Code 的"服务器继续跑"语义）；退出 / 重启后不承诺后台任务继续；`bypassPermissions` 下的问答只有单测覆盖，未做真实运行；Codex / ACP 没有后台语义，不受影响。
- 后续工作：`Capability.BACKGROUND_TASKS` 与类型化的 `turn_stage_completed` / `background_task` 事件；统一 `QuestionBroker` / `PermissionBroker` / `CodexApprovalBroker`；用录制的真实帧做契约测试；聊天入口的 Claude 问答需要 `ChatRuntime` 与聊天 UI 支持。

## References

- PR #155（实现与评审修复），issue #152 及其前身 #135 / #147 / #151。
- `docs/harness/interactive-lifecycle.md`：原生协议、真实帧、逐分支根因与 adapter 层判断的完整记录。
- `cleo/integrations/harnesses/claude.py`（`ClaudeProvider.prompt`、`_track_background`、`_abandon_background`、`BACKGROUND_WAIT_ENV`）。
- 测试：`tests/integrations/test_claude_background_turns.py`，真实 CLI 冒烟 `tests/integrations/claude_background_smoke.py`、`claude_question_smoke.py`。
- 官方参考：Claude Agent SDK TypeScript reference 的 `SDKResultMessage.origin`、`SDKTaskStartedMessage.ambient`、`SDKBackgroundTasksChangedMessage`。
