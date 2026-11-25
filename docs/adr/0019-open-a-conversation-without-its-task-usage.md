# 0019. 打开会话不等待任务用量；晚到的会话详情并入，不再丢弃

- **Status**: Accepted
- **Date**: 2026-11-25

## Context

Issue #201：从侧栏点进已有会话，特别是积累了大量消息和工具输出的长会话，希望更快看到最近的对话。issue 要求先测清各阶段耗时。

测量用 `scripts/bench_open_thread.py`：在一个新的数据目录里写入一条短会话（34 条事件）和一条长会话（150 轮、每轮 60 次工具调用，18451 条事件，77.5 MB），再像 Electron 那样通过 JSON-lines 协议驱动真实后端。基线（`v0.14.3` 的 `main`，Linux 容器，两次运行）：

- 短会话的 `load_thread` 为 0.014–0.019 秒。
- 长会话在索引有效时为 0.41–0.50 秒，其中 0.31–0.36 秒是 `task_usage`：`DesktopService._thread` 在返回前调用它，它用 `store.read_events` 读入并解析整份事件日志（以及每个子任务的日志）。同一会话的最近一页（`load_timeline`）只要 0.01–0.02 秒。
- 长会话在索引缺失时首次打开为 3.1–3.2 秒，其中重建索引（`TimelineIndex._sync_projection`）约 2.7–3.0 秒。

对照前端的行为，实际情况与 issue 的推测不同：

- 点击侧栏后，`useCleoWorkspace.selectThread` 发出 `load_thread`；同时，补回已清空时间线的 effect 通过 `history.load("latest")` 发出 `load_timeline`。两者并行，最近一页先到就先显示，所以首屏并不等 `load_thread`。
- 但 `selectThread` 只在「点击之后这个会话没有被改动过」时才采用 `load_thread` 的结果，而先到的那一页正是一次改动。于是只要完整结果比最近一页晚到，它就被整个丢弃。用 mock 把 `load_thread` 延迟到 400 毫秒可以稳定复现：会话打开了，但任务用量、可用技能、改动卡片、可编辑的回合和撤销状态都没有到。长会话总是落在这一边，短会话则看两个请求谁先返回。
- 恢复中的运行每 1.5 秒调用一次 `load_thread`，启动时 `load_workspace` 也会完整打开当前会话，它们每次都付出同一次全量读取。

## Decision

- **会话视图不再包含任务用量。** `_thread` 不调用 `task_usage`；新增 `load_task_usage`，返回值与运行期间 `task-usage` 事件携带的一致。打开会话、加载工作区和轮询都不再读取整份事件日志。
- **窗口在会话显示之后单独读取用量**（`useCleoWorkspace.readTaskUsage`）：点开会话并收到会话视图之后读一次；启动时为当前会话读一次；只是旁观的恢复中运行，在它的历史修订号变化时读。已知的用量在新结果到达之前继续显示：不带用量的会话视图替换本地会话时保留原值。
- **较新的用量不被较旧的读取覆盖。** 每个会话记一个序号，发起读取和收到运行自己报告的 `task-usage` 都会递增；读取返回时序号已经变了就丢弃。结果按会话 id 写回，读者已经切到别的会话也不会写错地方。
- **晚到的会话视图并入本地状态。** 点击之后会话被改动过（通常是最近一页先到），视图仍然带来时间线以外的全部内容，时间线和翻页状态保持此刻的样子。只有读者已经选了别的会话，或这个会话开始了新的运行，才不采用。

## Alternatives considered

- **缓存或增量维护用量。** 结果取决于根会话的日志、全部子任务的清单与日志、`.routing/tasks` 下的评估记录和价格表，要做对失效判断并不小，而且第一次打开仍然是一次全量读取。拆出独立请求之后，这类优化可以在 `load_task_usage` 后面单独做，不影响打开路径。
- **从时间线索引的 `events` 表里取用量相关的事件。** 仍要扫过索引里保存的全部事件正文；想让它真正便宜，需要在索引里另存一份精简记录并为已有索引补写，也就是提升 `PROJECTION_VERSION`（见 ADR 0010）。
- **去掉并行的最近一页请求，只靠变快了的 `load_thread`。** `load_thread` 还要做 git diff、技能发现，索引失效时还要重建。保留最近一页先行，首屏不受这些影响。
- **后端在 `load_thread` 返回后主动推送用量。** 协议里的事件都挂在某个流式请求上，为此新增一类无主事件，不如由窗口自己发一次请求简单，窗口也能决定什么时候读。

## Consequences

- 同一机器、同一数据（两次运行）：长会话在索引有效时的 `load_thread` 从 0.41–0.50 秒降到 0.02–0.03 秒，首次打开和切回都是；短会话不变（0.012–0.019 秒）。`load_task_usage` 对长会话为 0.35–0.42 秒，在会话显示之后进行。
- 比最近一页晚到的会话视图不再丢失：长会话打开后有用量、技能、改动、可编辑回合和撤销状态。
- 索引缺失或失效的会话，首次打开仍由重建索引决定（样本为 2.7–3.2 秒），这次没有改变；重建之后的打开与索引有效时相同。
- 每次点开会话仍会在后台完整求和一次，期间与其他请求共用解释器。运行期间每个用量事件触发的重新求和、`begin_task_turn` 的全量读取不在这次改动之内。
- 协议上 `load_thread`、`load_workspace` 的会话视图少了 `taskUsage` 字段，读取它的客户端要改用 `load_task_usage`。
- 测试：`tests/desktop/test_startup_cost.py` 断言加载工作区和打开会话都不读取整份事件日志，用量由 `load_task_usage` 给出；`ui/tests/uiux-regressions.smoke.mjs` 覆盖晚到的会话视图、用量最后读取、切走之后到达的用量和视图。

## References

- Issue #201（关联 #194、#162、#31）；ADR 0010（加载工作区的开销不随历史规模增长）、ADR 0011（用量按需读取）。
- `cleo/desktop/service.py`：`_thread`、`load_task_usage`；`cleo/desktop/rpc.py`；`ui/electron/main.mjs` 的 `allowedMethods`。
- `ui/src/useCleoWorkspace.ts`：`selectThread`、`readTaskUsage`、`updateThread`、`refreshWorkspace`。
- `scripts/bench_open_thread.py`。
