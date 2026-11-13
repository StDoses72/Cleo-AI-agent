# 0010. 加载工作区的开销不随历史规模增长；投影版本只在旧索引出错时提升

- **Status**: Accepted
- **Date**: 2026-11-11

## Context

v0.13.0 发布当天，在一台有 47 个会话、约 700 MB 事件记录的机器上从 v0.12.2 更新失败，随后的每一级回退也都失败。

版本切换由**旧程序**的控制器执行：它启动新程序，最多等 90 秒（v0.12.2 `evolution-recovery.mjs` 的 `waitHealthy`），等渲染进程在 `load_workspace` 返回后调用 `confirmHealthy()`。超时就判定新程序启动失败，按「所选版本 → 上一个版本 → 保底程序」依次重试。这个时限写在已经发出去的程序里，改不了。

`load_workspace` 里有三处开销与历史规模成正比：

1. **时间线索引重建。** 它对列出的每个会话调用 `TimelineIndex.page(limit=1)`。索引里存的 `projection_version` 与代码不一致时，整份 `events.jsonl` 会被重新投影。v0.13.0 把 `PROJECTION_VERSION` 从 13 提到 14（为命令的退出码、耗时和每轮的记忆来源），于是首次启动重建了全部索引。
2. **任务用量。** `_thread` 对每个会话调用 `task_usage`，它读入并解析整份事件记录。这一项从 v0.12.2 就有，每次启动都发生。
3. **harness 切换状态。** `_runtime_profile` 对每个开发会话调用 `handoff_status(store.read_events(...))`，同样读入整份记录，而且在事件循环线程上同步执行。

在那份数据的副本上实测：首次加载 95 秒（超过 90 秒），索引就绪后的每次加载 41 秒。回退到 v0.12.2 时，它又要把索引从 14 重建回 13，加上自己的 41 秒，同样超时；保底程序也失败，最后停在恢复窗口。数据没有丢失，但用户被留在一个三次自动恢复都失败的界面上。

发布前的验证（全量测试、四个平台的打包与启动检查、CI 里用测试写入的切换记录做的交接检查）都在空的或很小的数据目录上运行，测不出这一点。

## Decision

**规则：只有被打开的会话可以为它的历史付出开销；被列出的会话既不重建也不通读。**

- `TimelineIndex.page(..., rebuild=False)`：供「列出很多会话」的调用方使用。索引需要整体重建、且事件记录大于 `DEFER_REBUILD_BYTES`（64 KiB）时，不重建，返回索引现有的行并带 `stale: True`；小记录照常重建，保证摘要和「空对话」的判断准确。索引与代码版本一致时，新追加的事件仍然增量写入。
- `load_workspace` 的会话列表与侧栏行都走这条路径。侧栏行不再计算任务用量、本机 skills 和 harness 切换状态，也不做 steer 恢复；这些在打开会话（`load_thread`）时计算。前端的 `taskUsage`、`skills`、`runtime.handoffStatus` 本来就只在当前会话里使用。
- harness 切换状态改为从索引的 `events` 表读取（`TimelineIndex.handoff_events`，按索引里存的紧凑 JSON 匹配三种切换事件），不再解析整份记录。
- 会话索引的整体重建（`SqliteSessionIndex.replace_all`）在一个事务里完成：原来每个会话一次连接和提交，查找一个不存在的会话 id 就触发一轮。

**`PROJECTION_VERSION` 退回 13，并改变提升它的条件。** 版本号不一致会让**每一个共享数据的程序版本**整体重建索引：v0.13.0 及更早的程序在启动时对所有列出的会话这样做。所以只在旧投影写下的行对新代码**有错**时才提升；只增加可选字段的改动（退出码、耗时、记忆来源）不提升。代价是 v0.12.2 时期的旧回合不显示退出码和耗时，从下一轮起才有。这样 v0.12.2 写的索引对新程序直接可用，回退到 v0.12.2 也不需要重建。

**发布前的检查加一项。** CI 的交接检查（`smoke:computer-managed-upgrade`）在启动前往数据目录里放入几个事件记录很大、没有索引的会话，并断言新程序确认启动时至多只建了被打开那一个会话的索引。

## Alternatives considered

- **让渲染进程更早确认启动成功（后端一连上就确认）。** 否决：确认之后旧程序就不再回退。工作区加载失败的版本会被当作可用版本留下，用户只能靠独立恢复入口。保留「加载完工作区才算启动成功」的含义，把加载做快。
- **保留版本 14，只把重建改成按需。** 否决：更新能通过，但用户打开过的会话会被改写成 14，回退到 v0.12.2 时这些会话要重建。v0.12.2 自己每次启动还要 41 秒，余量不够，回退仍可能超时并掉到保底程序。
- **新格式的索引写到另一个文件（`.desktop-timeline-v2.sqlite3`），不动旧程序的索引。** 否决：回退安全，但索引体积约为事件记录的 1.2 倍，这台机器要多占约 800 MB，还需要另做旧文件的回收。
- **启动后在后台把过期索引全部重建。** 暂不做：这次没有过期索引需要处理；将来提升版本号时，后台改写会重新带来「回退要重建」的问题，应当在那时连同回退策略一起决定。
- **缓存任务用量的计算结果。** 暂不做：侧栏不需要它，去掉即可。打开大会话时它仍然解析整份记录，这是下一步该做的增量化。
- **延迟加载各 harness 的 SDK。** 暂不做：后端进程启动的约 5 秒几乎都花在导入 `claude_agent_sdk`、`mcp`、`openai_codex`、`acp` 上，但这些导入分散在 `cleo/integrations` 的多个模块顶部，改动面超出这次修复。

## Consequences

- 正面：在同一份数据副本上，从进程启动到 `load_workspace` 返回是 7.3 秒，其中约 5.4 秒是 Python 导入，工作区加载本身约 2 秒；之前首次 95 秒、平时 41 秒。更新和回退都不再重建索引。
- 用打好的 Windows 安装包在这份副本上按切换协议启动（旧程序轮询的同一个条件），从启动进程到确认成功：35 个大会话的索引都需要重建时 10.1 秒，索引全部就绪时约 8 秒；时限是 90 秒。
- 负面与限制：
  - 侧栏行的摘要来自索引现有的行。索引过期且记录很大的会话，摘要可能是旧的，打开后更新；索引缺失的大会话在打开前没有摘要。
  - 打开一个很大的会话仍然要解析它的整份记录来计算任务用量；这次没有改。
  - 旧回合缺少退出码和耗时（见上）。
  - 撤回的 v0.13.0 写过版本 14 的索引。运行过它的安装会在打开会话时按需重建，记录小的会话在列出时重建。
  - 将来提升 `PROJECTION_VERSION` 时，新程序不受影响，但回退到当时的旧程序仍会让旧程序在启动时重建被改写过的索引。提升前要先决定回退策略。
- 测试：`tests/desktop/test_startup_cost.py` 固定这条规则：加载工作区只重建并通读被打开的会话；打开会话时才重建并补齐省略的字段；索引缺失的会话照常列出；从未使用的空对话保持隐藏；从索引读出的切换状态与通读记录一致。`tests/desktop/test_projection_version.py` 记录版本 14 被撤回的原因。CI 的交接检查覆盖带历史数据的真实安装包启动。

## References

- 关键代码：`cleo/desktop/timeline.py`（`PROJECTION_VERSION`、`DEFER_REBUILD_BYTES`、`page`、`handoff_events`）、`cleo/desktop/service.py`（`load_workspace`、`_thread`、`_runtime_profile`、`_handoff_status`）、`cleo/sessions/index.py`（`replace_all`）
- 测试：`tests/desktop/test_startup_cost.py`、`tests/desktop/test_projection_version.py`、`ui/tests/computer-managed-upgrade.smoke.mjs`
- 版本切换与 90 秒确认：`docs/program-versions.md`、`ui/electron/program-recovery.mjs`
- 相关决策：[ADR 0009](0009-remove-local-evolution.md)（保留并改名的版本基础设施）、[ADR 0008](0008-single-sidebar-flat-ui-and-review-loop.md)（引入版本 14 的界面改动）
