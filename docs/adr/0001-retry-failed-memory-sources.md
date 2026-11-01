# 0001. 失败的记忆源可自动重试（有界退避）并可从队列手动重试

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

Dream Agent 把每个会话的事件日志当作一个"记忆源"（`cleo/memory/state.py` 中的 source 条目，以 `space/project/session_id` 标识，带 `source_hash`、`source_version`、`status`、`failure_count`）。后台调度器 `cleo/desktop/background_memory.py` 的 `BackgroundMemory` 周期性挑选源交给 `DesktopService._review_background_memory_source` 整理。

PR #146 简化了记忆队列 UI，去掉了每个源的手动整理按钮。随后 issue #148 指出一个缺口：一次普通的 provider/网络异常会把源持久化为 `failed`，而

- `DesktopService._background_memory_sources` 和 `BackgroundMemory._pending` 都只接受 `pending`/`running`，`failed` 源永远不会再进自动批次；
- `BackgroundMemory._attempted` 以 `(key → source_hash)` 记录"本进程已尝试过的修订"，即使放宽状态过滤，同一 hash 也会被永久压制；
- UI 只显示失败文本，`reviewMemorySource` 客户端方法存在但没有调用方；
- 只有两条现成的恢复路径：会话产生新事件（hash 变化 → `touch_session_source` 重置为 pending），以及被显式识别为"取消"的失败会被改回 pending。

约束：不能绕过完整性错误、不能丢弃已保存的源数据、要尊重 Dream Agent 开关/前台活动/取消/关闭语义、不能出现紧密重试循环或重复并发工作，并且保留 #146 之后"普通队列只读"的简化形态。

## Decision

同时提供两条受支持的重试途径：

1. **有界的自动重试**（后端）
   - `BackgroundMemory.retryable(source)`：`pending`/`running` 一律合格；`failed` 在 `failure_count < MAX_AUTOMATIC_FAILURES`（= 3）时合格。`DesktopService._background_memory_sources` 与 `BackgroundMemory._pending` 共用这一规则，避免两个选择器不一致。
   - 进程内退避：`_attempted` 记录 `(source_hash, 尝试时刻)`。失败源在同一修订上再次尝试前要等待 `intervalMinutes × 60 × 2^(failure_count − 1)` 秒；仍为 pending 的源沿用原来的"同一 hash 只尝试一次"。
   - 上一个进程留下的失败：重启后 `_attempted` 为空，因此在下一个到期批次就会重试一次。
   - `reset_schedule()`（保存后台整理设置、包括关闭再打开）清空 `_attempted`：用户的显式操作重新武装一次尝试，但持久化的 `failure_count` 仍然封顶。
   - 预算**按来源修订**计：`touch_session_source` 在 hash 变化时把 `failure_count` 归零。
   - 进入 running 之前的失败（模型构造、预检查）也要计数：`_review_background_memory_source` 在尝试前记录 `failure_count`，异常时若 hash 未变且计数未增长（说明 Dream Agent 没有自己记录这次失败），就调用 `mark_consolidation_failed`。

2. **手动重试**（UI）
   - 记忆队列里 `failed` 行显示"重试整理"按钮，调用既有的 `review_memory_source(action="consolidate")` RPC；按钮有进行中状态、防重复点击、行内错误显示；`failure_count ≥ 3` 时提示"自动重试已用尽"。
   - `pending` 行保持只读，与 #146 的简化一致；"重试整理"与加载对话预览的 retry 是两个控件。

## Alternatives considered

- **只恢复手动按钮，不做自动重试。** 被否决：issue 的核心场景是"网络恢复后无人操作也应完成整理"，否则已经结束的会话会一直悬着，直到用户发现。
- **只把 `failed` 加进状态过滤。** 被否决：`_attempted` 的 hash 压制仍会让同一修订永远不再尝试；而若顺手取消压制，又会在阈值触发（pending 数达到 `pendingThreshold`）时形成紧密循环。退避必须挂在"上次尝试时刻"上。
- **固定次数、固定间隔（例如每个周期重试一次直到成功）。** 被否决：持久性故障（没配模型、密钥失效）会无限消耗模型调用；指数退避加 3 次上限把单个修订的额外开销限制在最多 3 次尝试、约 1 + 2 = 3 个间隔内。
- **把计数限制放在 UI 常量而不是后端。** 被否决：调度器必须自己知道何时停止；UI 常量只是镜像用于提示文案（`MemoryView.tsx` 里注明与后端同步）。
- **累计 `failure_count` 不随修订重置**（最初的实现）。评审复现：旧修订失败 3 次 → 新消息 → 新修订第一次失败即计为 4，自动重试立即停止，与"同一修订连续三次"的声明不符。改为在 `touch_session_source` 的修订分支清零。
- **异常时仅当 `status != failed` 才计数**（最初的实现）。评审复现：模型初始化持续失败时，源始终处于 `failed`，计数停在 1，上限和退避都失效。改为按"本次尝试是否已被记录"（计数是否增长）判断。
- **保存设置不重新武装 `_attempted`。** 被否决：用户关掉再打开自动整理是最自然的"再试一次"手势；清空只是重新给一次机会，持久化计数仍然封顶。

## Consequences

- 正面：恢复网络后，未变化的失败源会在下一个到期批次被重新整理；用户也可以立即手动重试；持久失败最多消耗 3 次自动尝试，并在 UI 上可见"已用尽"。
- 负面/限制：
  - `failure_count` 的含义从"历史累计"变为"当前修订内的次数"，`cleo/memory/overview.py` 向 UI 暴露的也是这个值。
  - 阈值（3 次、间隔 × 2^(n−1)）是经验值，没有生产数据支撑；若需调整，改 `MAX_AUTOMATIC_FAILURES` 与 `_retry_delay`，并同步 `MemoryView.tsx` 的镜像常量。
  - 退避状态只在进程内（`_attempted`），重启会让每个可重试源立刻再得一次尝试；这是有意为之（重启也是用户动作），但意味着频繁重启的机器上失败源会被更快耗尽预算。
- 后续工作：如果 issue #132 推进更广的后台记忆工作，可以考虑把退避时间戳持久化到状态文件，并把"已用尽"作为独立状态暴露而不是靠 UI 比较计数。

## References

- PR [#153](https://github.com/StDoses72/Cleo-AI-agent/pull/153)；issue [#148](https://github.com/StDoses72/Cleo-AI-agent/issues/148)；前置变更 PR #146；相关 issue #132。
- 代码：`cleo/desktop/background_memory.py`（`retryable`、`_retry_delay`、`_suppressed`、`reset_schedule`），`cleo/desktop/service.py`（`_background_memory_sources`、`_review_background_memory_source`），`cleo/memory/state.py`（`touch_session_source`、`mark_consolidation_failed`），`ui/src/components/MemoryView.tsx`，`ui/src/useCleoWorkspace.ts`（`retryMemorySource`）。
- 测试：`tests/desktop/test_background_memory.py`（退避至耗尽、阈值触发不循环、保存设置重新武装、重启后重试持久化失败、running 前失败计数、修订重置预算），`ui/tests/uiux-regressions.smoke.mjs`（"recovery: failed memory sources offer a consolidation retry…"）。
- 相关文档：`docs/MEMORY_READING.md`、`docs/CASTMIND_MEMORY_MIGRATION.md`。
