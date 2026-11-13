# 0011. 上下文占用对所有 harness 用同一口径；账号用量在打开面板时按需读取

- **Status**: Proposed
- **Date**: 2026-11-13

## Context

输入区右下角的圆环显示当前会话的上下文占用。改动前它在不同运行方式下含义不同：

- **Codex**：取 `thread/tokenUsage/updated` 的 `last.totalTokens`，也就是最近一次请求的输入加输出，除以 `modelContextWindow`。
- **Claude 与 ACP（OpenCode 等）**：开发任务没有读数，圆环不显示。
- **Chat**：取模型返回的 `total_tokens`，同样是输入加输出。

各 harness 自己的口径是一致的，只是和上面不同。Claude Code 的 `used_percentage` 是最近一次 API 响应的 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，不含输出；实测一次请求后 `/context` 的总数 18,761 正好等于 10 + 18,751。OpenCode 1.18.18 的 `usage_update.used` 是 `tokens.input + tokens.cache.read + tokens.cache.write`，`size` 是 `model.limit.context`。`docs/subtask-routing-feedback-and-token-plan.md` 3.1 节早就提醒过，不能未经核对就把 Codex 的计数当作「当前上下文占用」。

用户还希望在同一个地方看到当前 harness 的账号用量。决策时已知：

- Codex app-server 有 `account/rateLimits/read`，返回 `primary` / `secondary` 两个窗口（`usedPercent`、`windowDurationMins`、`resetsAt`）。
- 随 `claude_agent_sdk` 分发的 Claude CLI 2.1.280 能回答 `get_usage` 控制请求（`rate_limits.limits[]`，每行有 `group`、`percent`、`resets_at` 和可选的模型范围），不发 prompt、不调用模型、不写会话记录。但 Python SDK 0.2.158 没有对应的公开方法。
- OpenCode 和其它 ACP agent 不提供额度数据。

## Decision

**上下文占用只有一个定义，写在 `cleo/harnesses/events.py` 的 `project_context_usage`：占用是最近一次请求放进窗口的输入（新输入、缓存读取、缓存写入），窗口是 harness 上报的值。输出不计，它会成为下一次请求的输入。**

- Codex：`tokenUsage.last.inputTokens` 与 `modelContextWindow`。
- Claude：主线程每次请求的 `AssistantMessage.usage`（`parent_tool_use_id is None`），由 provider 发布为 Cleo 自己的 `cleo/context_usage` 事件。窗口在连接时取 `get_context_usage()["maxTokens"]`，回合结束时以 `ResultMessage.model_usage[model]["contextWindow"]` 为准。子代理的请求填的是它自己的窗口，不计入。同一次请求拆成多条消息时只发布一次。
- ACP：`usage_update` 的 `used` 与 `size` 原样使用。它的事件类型改为 `status`，这样重新打开会话时 `TimelineIndex.recent_events` 会回放它。
- Chat：`input_tokens`；只返回总数的模型退回 `total_tokens`。
- 上下文事件不算工具效果（`cleo/routing/execution.py` 的 `observed_tools`），记忆投影把它当作噪声。

**账号用量在面板打开时读取，不随任务会话常驻。** 桌面端的 `get_harness_usage(provider)` 调用各 provider 的 `account_usage()`，结果统一成 `RateLimitWindowUsage`（百分比、窗口长度、重置时间、可选的模型范围）：

- Codex：临时 app-server client 调 `account/rateLimits/read`。
- Claude：`cleo/integrations/harnesses/claude_usage.py` 开一个不加载设置的临时 client，经 `client._query._send_control_request({"subtype": "get_usage"})` 读取后断开。
- 同一个 harness 的读数复用 60 秒。

**读不到就不显示。** 没有窗口读数时不显示圆环；harness 没有额度数据、读取失败或超时，面板里就没有「用量」一节。不放占位符，也不放解释文字。

圆环点开自己的面板（上下文占用，其下是用量窗口）；详情面板不再重复上下文占用。

## Alternatives considered

- **各 harness 沿用各自的计数，Codex 继续用 `totalTokens`。** 否决：同一个圆环在不同 harness 下含义不同。
- **统一成输入加输出。** 否决：Claude Code 和 OpenCode 自己都不这样算，用户在两边会看到不同的数字；ACP 只给一个 `used`，也补不出输出。
- **Claude 的占用在每次请求后调 `get_context_usage()`。** 否决：每次多一次往返（连接时实测约 0.36 秒），而 `AssistantMessage.usage` 已经随消息带来同一组计数。它只用来在连接时读窗口大小。
- **Claude 的用量走 `/usage` 本地命令。** 否决：结果里的 `usage_report` 被 Python SDK 的类型化 `AssistantMessage` 丢掉了。
- **Claude 的用量用被动的 `rate_limit_event`。** 否决：只在有请求时才到达，其中的 `unifiedWindows` 标为 `@internal`。
- **用 OpenCode 记录的成本推算额度。** 否决：订阅型 provider 记录的成本是 0，没有窗口数据可用。
- **读不到时显示「未知」或一句说明。** 否决：界面只放标签和状态，读不到的项不出现。

## Consequences

- 正面：圆环在三类 harness 和 Chat 下是同一个意思，并且与 Claude Code、OpenCode 自己显示的数字一致。Claude 和 ACP 的开发任务现在有圆环。
- 负面与限制：
  - Codex 的读数比以前略低，因为不再包含最近一次回复的输出。两份 chat 的 characterization golden 因此重录（`used` 150 → 120）。
  - Claude 的用量依赖 SDK 的私有成员 `_query._send_control_request`。SDK 改掉它之后不会报错，只是「用量」一节不再出现；升级 `claude_agent_sdk` 时要看一眼。
  - 首次读取慢：实测 Codex 约 8.5 秒、Claude 约 5 秒，因为各自要启动一个临时进程。面板在 0.4 秒后显示加载指示，重新打开时先显示上一次的读数。
  - 改动前记录的 ACP `usage_update` 不是 `status` 类型，不在回放范围内；这些会话从下一轮起才有读数。
- 未验证：
  - 没有通过桌面端跑过真实的 Claude 或 OpenCode 回合；这两条路径由构造消息的单元测试和探针脚本读到的真实数字覆盖。
  - 决策时两个账号都只有周窗口，5 小时窗口那一行只在测试数据里出现过。
  - Gemini、Copilot、Grok 等 ACP agent 是否发送 `usage_update` 没有核对；不发送时圆环不显示。

## References

- 关键代码：`cleo/harnesses/events.py`（`project_context_usage`、`CONTEXT_USAGE_EVENTS`）、`cleo/integrations/harnesses/claude.py`（`publish_context`、`_context_window`、`account_usage`）、`cleo/integrations/harnesses/claude_usage.py`、`cleo/integrations/harnesses/codex.py`（`account_usage`）、`cleo/integrations/harnesses/acp.py`（事件类型表）、`cleo/desktop/service.py`（`get_harness_usage`）、`ui/src/components/ContextMeter.tsx`
- 测试：`tests/integrations/test_usage_reporting.py`、`tests/desktop/test_service.py`、`tests/routing/test_task_clarity.py`、`ui/tests/task-token-usage.test.mjs`、`ui/tests/uiux-regressions.smoke.mjs`
- 相关文档：`docs/subtask-routing-feedback-and-token-plan.md`（3.1、3.2 节）、`docs/ARCHITECTURE.md`（harness 事件）
- 相关决策：[ADR 0008](0008-single-sidebar-flat-ui-and-review-loop.md)（圆环与详情面板的来历）
