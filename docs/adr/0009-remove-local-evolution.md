# 0009. 移除本地进化，保留并改名它与正式更新共用的版本基础设施

- **Status**: Proposed
- **Date**: 2026-11-10

## Context

「本地进化」让用户在对话里提出修改需求，由 coding harness 改写 Cleo 自己的源码，桌面控制器跑完检查漏斗（`npm ci`、`tsc`、Vite、测试、完整打包）后重启进入候选程序，再由用户保存或放弃，并可提交 GitHub PR。围绕它还有验收案例与行为回放、伴随窗口、监视窗口、合并辅助和应用内发布。

决定移除它的事实：

- 体量：v0.12.2 中名字带 evolution 的文件约 12.7k 行，UI 文案约 18% 属于它，`cleo/desktop/service.py` 里有约 25 处 `_is_evolution` 分支。
- 风险：这是唯一让模型修改正在运行的程序的入口。
- 没有人在用：保存与应用前的行为验收门在 v0.6.0 合并（`9a62ea0`）时被静默丢掉，此后 15 个版本无人发现。
- 已有替代：普通开发任务加上 [ADR 0008](0008-single-sidebar-flat-ui-and-review-loop.md) 的审查与 git 闭环（查看 diff、提交、推送、创建 PR）覆盖了它的贡献流程。

移除的难点不在功能本身，而在它寄生的位置。正式版本更新用到的全部基础设施都长在 evolution 名下：程序版本登记与切换（`evolution-store.mjs`、`evolution.mjs` 的一半）、可见的安全重启与启动确认（`evolution-progress.mjs`、`evolution-handoff.mjs`）、自动回退与独立恢复窗口（`evolution-recovery.mjs`）、发行包下载校验后的登记、切换前的数据备份与保留、空间回收。`bootstrap.mjs`、`selectable-updates.mjs`、`launcher-refresh.mjs`、`storage-reclaim.mjs`、`setup-manager.mjs`、`online-runtime.mjs` 都从这些文件导入。直接删除会连更新一起删掉。

另一条约束是已安装的用户：控制目录 `userData/evolution`、`state.json` 的字段、发行清单里的 `evolution_protocol` 都被已发布的程序读写，而且旧程序会作为「保留的版本」继续存在于用户机器上，回退时要能原样运行。

## Decision

分三步，各一个提交：先解耦（不改行为），再删除 `ui/src` 以外的部分，最后删除前端。

**保留并改名的部分（代码改名，数据路径不改名）。**

| 现在的模块 | 职责 | 原来的位置 |
|---|---|---|
| `ui/electron/program-store.mjs`（`ProgramStore`） | 程序登记、备份与保留、切换事务（stage / activate / recover / healthy）、JSON 与路径工具 | `evolution-store.mjs`（`EvolutionStore`） |
| `ui/electron/program-versions.mjs`（`ProgramVersions`） | 保底程序、识别手动安装的新版本、下载并登记正式版本、切换前的拦截、登记切换 | `evolution.mjs`（`EvolutionManager`）中的版本管理部分 |
| `ui/electron/program-recovery.mjs` | 重启控制器、等待启动确认、恢复选择窗口 | `evolution-recovery.mjs` |
| `ui/electron/program-handoff.mjs` | 启动所选程序，失败时依次回到上一个程序与保底程序 | `evolution-handoff.mjs` |
| `ui/electron/restart-window.mjs` | 重启与恢复期间始终可见的进度窗口 | `evolution-progress.mjs` |
| `ui/electron/program-launch.mjs` | 启动面向用户的 Cleo 进程 | `evolution-launch.mjs` |
| `ui/electron/program-bundles.mjs` | 读取发行信息、解包、按物理文件复制程序 | `evolution-tools.mjs` |
| `ui/electron/run-command.mjs` | 不经 shell 的子进程执行 | `evolution-tools.mjs` |

`ProgramUpdates` 的构造参数从 `evolution` 改为 `versions`；启动确认的 IPC 通道改为 `cleo:program:healthy`（预加载的 `confirmHealthy()` 不变）；新增 `cleo:program:recovery`（预加载 `openRecovery()`），把原来藏在进化面板里的「应用内打开版本恢复」保留下来。

**删除的部分。**

- Electron：`evolution.mjs` 的自修改部分（准备源码、检查漏斗、`protected.json` 校验、保存与放弃、GitHub 登录、提交 PR 与回执、合并正式版本）、`evolution-acceptance`、`evolution-behavior-policy`、`evolution-requests`、`evolution-interactions`、`evolution-editing`、`evolution-actions`、伴随窗口 `evolution-companion`、监视窗口 `evolution-monitor*`、`evolution-merge-assistance`、`evolution-contributions`、`evolution-snapshot`、`acceptance-dream.py`，以及 `main.mjs` 里对应的 IPC（`cleo:evolution:state`、`cleo:evolution:action`、`cleo:companion-thread`）。
- 应用内发布（`github-releases.mjs`、`release-driver.mjs`、`release-jobs.mjs`、`release-packages.mjs`、`release-repair.mjs`、`cleo/desktop/release_repair.py`）。它只能发布「由进化提交、已合并的 PR」：来源要求 `state.json` 里有 PR 回执，授权依赖进化的 GitHub 登录，修复步骤借用进化会话的 harness。回执和登录都随进化删除，它没有输入可用。正式发布继续走 `.github/workflows` 与 `scripts/build-release.*`。
- 托管构建工具（`ManagedTools`：下载 Node、Git、uv、GitHub CLI）与依赖向导里的可选项「自我迭代工具」。检查漏斗是它唯一的使用者。
- `--cleo-import-bundle`（把本机开发包登记为本地版本）与随包的 `evolution-source.tar.gz`（`scripts/bundle-evolution-source.mjs`）。两者只服务于「从某个程序恢复出可编辑源码」。
- Python：`cleo/desktop/evolution_planning.py`、`service.py` 里全部 `_is_evolution` 分支、`EVOLUTION_PROJECT`、`CLEO_EVOLUTION_WORKSPACE`、注入每一轮的自迭代约束提示、`EvolutionPolicy`、固定权限说明，以及 RPC `open_evolution_thread`、`is_evolution_thread`、`analyze_evolution_request`、`release_runtime`。路由评估器用到的只读订阅通道从 `evolution_planning.py` 移到 `cleo/integrations/subscriptions.py`（`subscription_text`）。
- 前端（`ui/src`）：侧栏的「进化」入口、命令面板的「打开进化」、对话菜单的「改进 Cleo」；进化视图及其组件（`EvolutionPanel`、`EvolutionCases`、`EvolutionContribution`、`EvolutionPreparation`、`ContributionMerge`、`GithubLogin`、`ReleasePublisher`、`ReleasePackages`、`evolution.css`）；`useEvolution`、`evolution-types`、`visible-prompt`；`useCleoWorkspace` 里独立于普通导航的进化选择、伴随窗口的线程同步，以及各处对 `productivity:cleo-evolution` 的过滤。预加载里的四个空实现（`getEvolutionState`、`evolutionAction`、`onEvolutionState`、`onCompanionThread`）和 `main.mjs` 的 `retiredMethods` 随之删除。只服务这些组件的 295 条文案键删除；保留组件借用的几条（版本选择、提交中、取消登录）改到各自的前缀。
- 文档：`docs/cleo-evolution*.md`、`docs/architecture/cleo-self-evolving*`、`docs/direct-acceptance*`、`docs/contribution-targets*`、`docs/acceptance-retry-cancellation*`、`docs/evolution-acceptance-preparation*`。保留下来的版本与恢复行为写进 `docs/program-versions.md`。

**前端保留的入口。** 原来藏在进化面板版本菜单里的「版本恢复」移到 设置 →「关于与更新」，在「其他版本」下面（`VersionRecovery`，调用 `openRecovery()`）。选好版本后 Cleo 重启，数据不变；有任务在运行或依赖安装未完成时，主进程拒绝并说明原因。

**数据兼容保证。**

1. 控制目录仍是 `userData/evolution`（Alpha 渠道为 `Cleo Alpha/evolution`）。`builds`、`backups`、`downloads`、`handoffs`、`state.json`、`releases.json` 的位置与格式不变；卸载脚本清理的范围不变。
2. `state.json` 采用读出、合并、写回的方式更新，未知字段原样保留。程序选择、`latestSaved`、`workspaceBase`、`installedReleases`、`lastApplication`、`lastRestartError`、清理队列（`cleanupPending`、`backupCleanupPending`、`storageCleanupPending`）的含义不变。
3. 旧版本写下的字段（`iteration`、`candidate`、`draftDirty`、`prepared`、`threadId`、`baseSourceHash`、`pendingMerge`、`pullRequest(s)`、`pendingPullRequests`、`branchRequests`、`importedBundles`、`saveSequence`）不再由新程序产生，但继续被读取和保留。正式版本切换仍按原事务重置并在回退时恢复其中的选择字段，`source` 仍归档为 `source-history-*`；这是旧程序认识的日志格式，旧程序完成或回退由新程序发起的切换时不会出错。保留策略继续保护这些字段引用的程序。
4. 新程序不读取、不写入、也不删除 `source`、`source-history-*`、`source-recovery-*`、`tools`、`acceptance`、`validation.json`、`protected.json`、`release-jobs`、`submission-snapshots`、`monitor` 等旧内容。
5. 发行清单继续写入并要求 `evolution_protocol`（完整包 2，联网包 3）与 `build_kind`；v0.12.2 及更早带源码归档的程序包照常被识别。
6. 进程间的启动协议不变：`--cleo-recovery`、`--cleo-apply-parent=`、`--cleo-theme=`，环境变量 `CLEO_EVOLUTION_CHILD`、`CLEO_EVOLUTION_TRANSACTION`。启动保留的程序时仍传入 `CLEO_EVOLUTION_WORKSPACE`，因为 v0.12.2 及更早的程序会读取它。
7. `productivity:cleo-evolution` 项目下的历史任务仍可加载，作为普通开发任务对待，manifest 不被改写；侧栏不再隐藏这个项目，用户可以像其他项目一样查看、移动或删除这些任务。旧任务里由桌面注入的自迭代提示和内部标题仍以只读方式折叠显示（`cleo/desktop/projection.py::internal_prompt_display`、`presenters.py::visible_title`），否则旧对话里用户消息会变成几十行内部指令。
8. 依赖向导的 `setup-v1.json` 里旧的 `tools` 记录与待办被忽略而不删除，`tools-v1.json` 原样保留。

**两处有意保留的拦截。**

- 状态里有旧版本留下的未完成本地修改（`iteration`、`draftDirty`、未保存的本地候选）时，正式版本切换和「手动安装的新版本自动接管」仍被拒绝。新程序没有保存或放弃这些修改的界面，所以错误信息改为提示从恢复入口回到那个版本处理。
- 应用内只能切换到正式版本或旧版本已保存的本地版本；从未保存的本地构建没有新程序能核对的检查凭据，登记切换时拒绝。

## Alternatives considered

- **只隐藏入口，保留代码。** 否决：风险和维护成本都在代码里，隐藏入口不减少任何一项；被静默丢掉的验收门说明这块代码已经没有人看。
- **一步删除，不先解耦。** 否决：版本基础设施与自修改流程在同一个类、同一批文件里，一次提交既搬又删无法审查，也无法证明更新路径的行为没有变。先解耦的提交在全部原有测试下通过，再删除的提交才主要是删除。
- **把控制目录、`state.json` 字段、`evolution_protocol`、`CLEO_EVOLUTION_*` 一并改名。** 否决：它们是已发布程序读写的磁盘格式和进程协议。改名需要迁移，而保留的旧程序在回退后仍按旧名读写，迁移反而制造两套状态。
- **遇到旧版本留下的未完成修改时，由新程序自动归档并放行更新。** 否决：切换事务会重置候选引用，随后的保留清理会删除那个未保存的候选程序。新程序无法判断它是否仍被需要，不能替用户丢弃；拒绝并指回原版本不丢任何东西。代价见 Consequences。
- **保留应用内发布。** 否决：它的输入（PR 回执）和授权（GitHub 登录状态）都属于被删除的贡献流程，单独保留需要把那两部分也留下。
- **保留托管工具给依赖向导。** 否决：那一项的标题就是「自我迭代工具」，除检查漏斗外没有调用者。
- **在 Python 里保留一个报错用的 `open_evolution_thread`。** 否决：前端清理前的过渡期由 Electron 拦截（`main.mjs` 的 `retiredMethods`）即可；前端清理后渲染进程与主进程随同一个程序发布，不再有调用者，拦截表也一并删除。
- **继续在侧栏隐藏 `productivity:cleo-evolution` 下的旧任务。** 否决：那是用户自己的对话记录，隐藏后既看不到也删不掉；按普通项目显示不需要任何特判。
- **同时把保留代码引用的文案键（`evolution.*`、`evolution_store.*`、`evolution_recovery.*` 等）改到中性前缀。** 暂不做：改键要同时改 `locales.json`、`recovery-locales.json` 和所有引用处，与本次删除无关，留作单独的重命名。只为措辞必须改变的几条新增了 `program_versions.*`、`program_recovery.*`、`program_handoff.*`。

## Consequences

- 正面：模型修改运行中程序的入口不复存在；Electron 主进程不再有伴随窗口、监视进程、托管工具链和 GitHub 设备登录；`main.mjs` 与 `service.py` 里按「是否进化任务」分叉的权限、提示和审批逻辑消失；更新、重启、回退、恢复的代码有了与职责相符的名字，并且不再与被删除的功能共用一个类。
- 负面与限制：
  - 没有应用内的版本发布，也没有从 Cleo 内提交「完整源码快照 PR」的流程；贡献改走普通开发任务与 git 闭环。
  - 手里有未完成进化修改的用户必须在旧版本里保存或放弃后才能更新。极少数情况下新程序已是当前程序而状态里仍有这类记录（例如从恢复入口选到新程序），此时新程序里更新被拒绝，需要从恢复入口回到那个版本处理。
  - 已保存的本地版本仍在磁盘上并受保留策略保护，只能从「关于与更新」里的「版本恢复」或独立恢复入口选择，没有专门的列表界面。
  - 用过进化的用户会在侧栏看到一个新的项目，里面是旧的进化对话（标题折叠为「进化会话」）。
  - 从旧版本切换到新版本时，若旧版本为进化任务打开了伴随窗口，而切换不是正式版本事务（例如在旧版本的应用内恢复里直接选了新程序），旧版本的伴随窗口不会收到新程序的心跳，需要手动关闭。
  - 保留代码仍引用带 evolution 前缀的文案键和数据字段名，读代码时需要知道它们是历史名称。
- 测试：登记、保留、切换、回退、安装识别的测试随模块改名保留；涉及迭代与保存的用例改由 `ui/tests/fixtures/registry-writer-v0.12.2.mjs`（v0.12.2 的登记写入器原件）驱动，验证旧程序写下的状态在新登记下继续成立，登记往返测试也以它为对照而不再读取 `git show HEAD`。新增 `version-guards-ipc.test.mjs`（任务与版本操作的互斥、应用内恢复、已删除的方法不会到达后端），以及 Python 侧「旧进化任务按普通任务加载」的测试。前端的进化冒烟（`smoke:evolution-workspace`、`smoke:evolution-ui`，其中包括一直失败的 `behavior-review`）、`test:evolution` 与发布选择冒烟随组件删除；原 `interaction-ui` 里的斜杠菜单检查（技能搜索、输入法回车、键盘与鼠标选择、切换 harness）独立为 `smoke:composer-slash`；预加载测试改为确认四个进化方法已不存在；`smoke:program-updates` 去掉进化拦截，改为检查就绪状态下两个安装入口。

## References

- 保留行为的说明：`docs/program-versions.md`
- 关键代码：`ui/electron/program-versions.mjs`、`ui/electron/program-store.mjs`、`ui/electron/program-recovery.mjs`、`ui/electron/program-handoff.mjs`、`ui/electron/bootstrap.mjs`、`ui/electron/main.mjs`、`ui/electron/preload.cjs`、`cleo/desktop/service.py`、`cleo/desktop/rpc.py`、`cleo/integrations/subscriptions.py`
- 兼容性测试：`ui/tests/program-store.test.mjs`、`ui/tests/program-retention.test.mjs`、`ui/tests/official-switch.test.mjs`、`ui/tests/installed-release.test.mjs`、`ui/tests/selectable-updates.test.mjs`、`tests/desktop/test_legacy_evolution_threads.py`
- 相关决策：[ADR 0006](0006-online-runtime-ownership-and-retirement.md)（在线运行环境回收，沿用同一登记）、[ADR 0008](0008-single-sidebar-flat-ui-and-review-loop.md)（审查与 git 闭环）
