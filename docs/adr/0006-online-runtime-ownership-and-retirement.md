# 0006. 在线运行环境的归属登记与基于证据的退役

- Status: Proposed
- Date: 2026-10-30

## Context

桌面版把 Python / Node 运行环境装在 `%LOCALAPPDATA%\Cleo\runtimes\online\<key>`，`key` 是 `resources/runtime-plan.json` 内容的 SHA-256（`ui/electron/online-runtime.mjs::readRuntimePlan`）。每个发布版本的 plan 不同，于是每次升级都留下一整套约 1.6 GiB 的环境。#141 记录了一台机器上 10 套、15.8 GiB 的积累。

当时 `ui/electron/storage-reclaim.mjs::storageInventory` 对在线环境的判断是 `action: owner || completed ? "keep" : "reclaim"`：只要 `ready.json` 完整，哪怕找不到任何引用者也保留。这不是疏忽而是刻意保守——旧版 `download.ps1 -InstallRoot` 允许自定义安装位置，这类安装既没有 evolution 登记也没有依赖快照，清理器无法证明它们不再使用某套环境。

在本 ADR 之前，PR #144（2026-10-28，Refs #141）已经按用户后来的决定实现了"只留一份"：新版本健康启动后，同一根目录下版本 ≤ 当前的完整环境自动回收，即使有旧安装登记引用。这条规则靠 `compareVersions(entry.version, currentVersion)`，对以下环境无能为力：版本比当前新（已下载未启用的 staged 版本）、`ready.json` 没有版本、或根本不是本程序生成的。它们继续被标为"无法确认无人使用"。

#141 的方案还要求：清单列出每套环境的版本、大小、引用者、证据与原因，区分"确认在用 / 确认退役 / 归属未知"；为安装、升级、启动和卸载补齐可持久化的"安装位置 ↔ runtime key"关系；只回收能证明退役的；归属未知的保持保守。

## Decision

1. **在启动入口登记归属。** `findInstalledRuntime(resources, dataHome)` 选中运行环境后调用新函数 `recordRuntimeOwner(root, resources, plan)`，把当前程序的 `resources` 路径、`plan.key`、`plan.version` 和时间写进该环境根目录的 `installations.json`。数据形状：

   ```json
   {"schema": 1, "installations": {
     "C:\\Users\\u\\AppData\\Local\\Programs\\Cleo\\resources": {
       "key": "beb351bc…", "version": "0.12.1", "updatedAt": "2026-10-30T20:00:00Z",
       "history": [{"key": "9f1c…", "version": "0.12.0", "leftAt": "2026-10-30T19:58:00Z"}]}}}
   ```

   写入是临时文件 + rename 的原子写；任何失败只返回 `false`，绝不阻止启动。写入时顺手删除 `key` 目录已不存在的条目和 history 项。

2. **登记保留 key 历史。** 同一安装路径切换到新 key（原地升级）时，离开的旧 key、版本与 `leftAt` 进入 `history`，而不是被覆盖。这是评审中换掉的方案：最初实现直接覆盖条目，结果清理器再也看不到"此安装已离开旧环境"，对版本无法比较的环境复现仍是 `unknown / keep`。

3. **清单给每套在线环境一个归属判定。** `storageInventory` 为条目新增 `ownership`（`in-use` / `retired` / `unknown`）、`owners: [{label, evidence}]` 与 `evidence: [{kind, detail}]`。引用来源各带证据类型：`current-program`、`registered-build`、`program-directory`、`installed-launcher`、`sibling-channel`、`dependency-snapshot`、`launch-registry`。登记解释规则：
   - 登记的安装仍存在且其 `runtime-plan.json` 仍指向同一 key → owner（`launch-registry`）。
   - 安装仍在但已指向其他 key，或 history 里的 key → `installation-upgraded` 证据。
   - 安装路径不存在 → 它当前 key 与 history 里的 key 都得到 `installation-removed` 证据。
   - 登记缺失、损坏（`parseRuntimeRegistry` 视为空）、或指向别的 key → 不产生任何证据。

4. **只回收能证明退役的。** 在 #144 同一组门槛下（界面与后端已报告健康、当前环境完整且 key / 版本匹配、无事务、无安装中、无下载中、同一根目录），一个完整、没有任何 owner、且至少有一条退役证据的环境标为 `retired` 并回收；#144 的版本规则保持不变，同样标为 `retired`。完整但既无 owner 也无证据的环境保持 `unknown / keep`，原因照旧显示为"无法确认无人使用"。

5. **不恢复"保留一套回退环境"。** 这是 issue 原文的建议，但 PR #144 明确记录了用户改为"只留一份"的决定。本 ADR 不与那个决定相抵触；若要恢复回退份额，需要单独的决定与 ADR。

## Alternatives considered

- **继续只按版本回收（维持 #144 现状）。** 否决：对 staged 的新版本、无版本和外来环境永远无法判定，清单也说不出"谁在用"。
- **按年龄或最后访问时间清理。** 否决：issue 明确要求不能用"很久没访问"推断无人使用；离线备用安装会被误删。
- **在安装器里登记安装位置。** 否决：Windows bootstrap、`download.ps1`、pkg / deb postinst 调用 `online-runtime.mjs` 时最终安装路径尚未确定（先在临时目录准备再复制）；登记到临时路径只会污染。启动时登记覆盖所有受支持入口，并且每次启动都刷新。
- **在卸载脚本里删除登记。** 否决（暂不做）：`scripts/uninstall.ps1` 现有行为是整体删除 `runtimes` 目录，登记随之消失；而卸载后安装路径不存在本身就是 `installation-removed` 证据，无需脚本配合。
- **覆盖式登记（评审前的实现）。** 否决：见 Decision 2。
- **把登记文件当作删除授权（登记缺失即可删）。** 否决：issue 要求"单一缺失或损坏的登记不能充当删除授权"；旧版环境在本 ADR 之前没有任何登记，必须继续保守。
- **登记写进环境目录内部（`<key>/owners.json`）。** 否决：运行环境目录被当作不可变产物（`ready.json` 标记完成后不再写入），且多个安装共享同一 key 时会互相覆盖。根目录一份按安装路径索引的文件更合适。

## Consequences

- 正面：清单对每套在线环境都能说出"谁在用、凭什么、为什么保留或回收"；原地升级后的旧环境即使版本无法比较也能被证明退役；损坏或缺失的登记只会让环境停留在 `unknown`，不会误删。
- 负面 / 限制：本 ADR 之前安装的环境没有登记，只能靠 #144 的版本规则或继续保留；`installations.json` 以绝对路径为键，Windows 路径大小写差异只在单测中验证；`uninstall.ps1` 仍会删除整个 `runtimes` 目录（跨安装、跨渠道），这是既有行为，未在本 PR 处理。
- 后续工作：UI 可以直接渲染 `ownership` / `owners` / `evidence`（当前只显示 `reason` 文案）；若用户决定恢复回退份额，需要单独 ADR；多环境机器上的清理前后清单对比尚未完成。

## References

- PR #157（本决定的实现），PR #144（"只留一份"策略，Refs #141），issue #141，已关闭的前身 #118。
- `ui/electron/online-runtime.mjs`（`RUNTIME_REGISTRY`、`parseRuntimeRegistry`、`recordRuntimeOwner`、`findInstalledRuntime`）、`ui/electron/storage-reclaim.mjs`（`storageInventory`、`reclaimStorage`）、`ui/src/types.ts::StorageEntry`。
- 测试：`ui/tests/storage-reclaim.test.mjs`、`ui/tests/online-runtime.test.mjs`。
- 文档：`docs/cleo-evolution.md` "在线运行环境" 段落。
