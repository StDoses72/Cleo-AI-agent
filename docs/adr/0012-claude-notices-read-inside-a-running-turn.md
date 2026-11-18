# 0012. Claude 在运行中的回合里读到的完成通知不单独等待回复

- **Status**: Accepted
- **Date**: 2026-11-17

## Context

[ADR 0004](0004-claude-turn-and-background-task-lifecycle.md) 规定 `ClaudeProvider.prompt()` 按「后台任务集合 + 欠账」判定一轮是否结束：每条 `task_notification` 把 `_ClaudeRuntime.owed_wakeups` 加一，每个后续 `ResultMessage` 减一，两者都清零才结束。

这个前提只在会话空闲时成立。#178 的事故里（Windows、Cleo 0.14.0、Claude Code 2.1.323），三个后台 PowerShell 任务在回合仍在执行时完成。原生会话记录显示这三条通知都以 `queued_command` 送入当前回合，移除原因为 `absorbed_mid_turn`；Claude 在这一轮里直接读了它们，没有再发独立的 result。Cleo 的计数停在大于零，`claude/stage_completed` 之后一直等待，直到用户在 7 分 56 秒后取消。

决策时已知的事实：

- Agent SDK 文档说明，后台任务完成会注入一个带 `origin.kind == "task-notification"` 的后续回合；多个完成排在一起时各自产生一个 result，前面的为 `num_turns: 0` 的空 result。文档没有说明回合运行期间到达的通知是否产生 result。
- 对于回合运行期间发送的普通消息，文档写明：Claude 在工具调用结束后于同一回合读取；回合先结束时，该消息开启下一回合，并且「循环立即开始下一个排队的回合」。
- `claude_agent_sdk` 自己的 `_track_task_lifecycle` 注释承认，仅凭任务记账无法区分「任务已结束但后续回合待开始」与「没有工作」，需要 CLI 给出回合边界信号。
- `session_state_changed`（需 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`）能报告 `idle`，但文档写明它与 result 的先后顺序不固定，默认也不等待后台工作。

## Decision

**按通知到达时会话是否空闲分两类记账。**

- `runtime.waiting` 为真（上一阶段的 result 已到，会话空闲）时到达的通知，记入 `owed_wakeups`，语义不变：它一定开启一个后续回合。
- 回合运行期间到达的通知，记入 `_ClaudeRuntime.absorbable_wakeups`：它可能已被当前回合读取，也可能在回合结束时仍在排队。

回合的 result 到达后，如果后台任务集合为空、`owed_wakeups` 为零、只剩 `absorbable_wakeups`，`prompt()` 进入一个 `ABSORBED_SETTLE_SECONDS`（3 秒）的等待窗口：

- 窗口内出现新的 `init`、`AssistantMessage` 或 `StreamEvent`，按后续回合继续接收，其 result 先冲抵 `owed_wakeups`，再冲抵 `absorbable_wakeups`。
- 窗口内没有后续回合，以刚才的 result 结束本轮。不写 `claude/stage_completed`，不断开流，不置 `needs_reconnect`。
- 窗口内 `cancel()` 返回已完成的回复，而不是 `cancelled`。
- 该 result 为错误或取消、或等待被 `CLEO_CLAUDE_BACKGROUND_WAIT_SECONDS=0` 关闭时，不进入窗口，直接结束。

不做的事：不改变仍有后台任务在运行时的等待规则；不依赖 `session_state_changed`。

## Alternatives considered

- **用 `session_state_changed` 的 `idle` 作为结束信号。** 这是语义上最直接的信号，但文档写明 `idle` 与 result 的顺序不固定，也没有保证排队的通知回合开始前不会报告 `idle`。没有在真实 CLI 上核对过这些顺序，误判会截断真正的回复，因此没有采用。
- **在普通 result 到达时把回合内到达的通知全部视为已读。** 实现最简单，但回合先于通知读取结束时，后续回合的回复会落到下一次用户提问里。
- **只统计已登记后台任务的通知。** 事故中 8 个余额里只有 3 个能对上已登记任务，其余 5 个来源不明；这个方案对那 3 个仍然会卡住。
- **缩短 `CLEO_CLAUDE_BACKGROUND_WAIT_SECONDS`。** 只是把卡住的时间从 10 分钟缩短，仍然把一轮完成的回复报告为超时失败。

## Consequences

- 回合内读完通知的 Claude 任务在回复完成后最多多显示 3 秒「运行中」，然后正常结束。
- 排队的通知如果在回合结束 3 秒之后才开启后续回合，这一轮会先结束，后续回合的输出留在流上，可能被下一次提问读到。文档说后续回合立即开始，这种情况预期不出现，但没有实测排除。
- 事故中另外 5 个计数余额的来源仍未确认。它们如果在回合运行期间到达，现在同样走等待窗口；如果在会话空闲时到达，仍会让这一轮等待到超时。
- 这次修复没有对真实的 Claude CLI 复现验证，回归用例按 issue 记录的帧顺序编写：`test_notice_absorbed_by_the_running_turn_ends_with_that_turn`、`test_notice_left_queued_when_the_turn_ends_still_gets_its_follow_up_reply`、`test_cancel_inside_the_settle_window_keeps_the_finished_reply`。

## References

- Issue #178、#179；[ADR 0004](0004-claude-turn-and-background-task-lifecycle.md)。
- `cleo/integrations/harnesses/claude.py`：`ABSORBED_SETTLE_SECONDS`、`_ClaudeRuntime.absorbable_wakeups`、`ClaudeProvider.prompt`、`_track_background`。
- `docs/harness/interactive-lifecycle.md` 的 Claude 一节。
- `tests/integrations/test_claude_background_turns.py`。
