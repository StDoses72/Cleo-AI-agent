# 0008. 桌面 UI 改为单侧栏信息架构、平铺视觉，并在界面里补齐审查与 git 闭环

- **Status**: Proposed
- **Date**: 2026-11-08

## Context

v0.12.2 的桌面 UI（`ui/src`）按“空间”组织：左侧图标栏 `WorkspaceRail` 有 对话 / 开发 / 进化 / 记忆 四个空间，每个空间有自己的侧栏和线程树；标题栏中间重复显示“项目 — 模式”；右侧检查器 `Inspector` 有 变更 / 上下文 / 运行 / 文件 / 电脑 五个标签，标签选择跨线程保持；设置弹窗有 11 个页面，其中“运行设置”展示的是当前会话的模型与权限。时间线 `groupTimelineItems` 把一个回合的思考放进“思考过程”卡、工具调用放进“工具过程”卡，两者顺序被拆开。

我们按同一份评分标准（11 个维度、加权，`docs/UI_UX_REFACTOR_v2.md` 附录）请 GPT-6-Astra（xhigh）与 Fable 5.1（xhigh）对 Cleo 与 Claude Code、Codex、OpenCode、T3 Code 的官方材料打分。基线加权总分：Cleo 5.61 / 5.42，竞品中位数约 7.2–7.4。两位评审一致认为差距集中在：

- 改动审查与控制（D3，Cleo 4.2/4.0 对最佳 8.5）：diff 行号是补丁行序号而不是文件行号，没有逐文件撤销、行内评论、提交/推送/PR。
- 多任务并行（D6，4.8/4.5 对最佳 8.6/8.0）：没有“需要处理/运行中”的总览、没有 worktree 隔离、没有系统通知。
- 信息架构（D1，5.0）：四个空间、三层身份信息（标题栏、图标栏、侧栏标题），新任务会打开在空的“电脑”标签上。
- 两位评审都明确：只有界面、没有真实能力的按钮不得分。

另外，维护者认为原视觉“太有气泡感”（大圆角浮起面板、药丸按钮、灰底卡片），希望靠近竞品的平铺风格。

约束：后端 `CleoClient` 协议（`ui/src/types.ts`）与 Python 服务只做向后兼容的增量（新增可选字段，不改已有字段与方法）；聊天（`chat`）与开发（`productivity`）在后端仍是两种空间，线程、记忆空间和运行时都不同；现有 Electron 预加载是 sandbox 模式，只能经 IPC 调主进程。

## Decision

**信息架构：一条侧栏，空间变成线程属性。**

- 删除 `WorkspaceRail`。`ThreadSidebar` 顶部是 新任务（Ctrl+N）、搜索（打开命令面板，Ctrl+K）、记忆、进化 四个入口；下面一条列表依次是“进行中”（运行中或等待用户的线程，仅在非空时出现）、“开发”（按项目分组）、“对话”；底部是设置。
- 后端的 `activeSpace` 保留为内部状态：点哪个线程就切到它的空间；“新任务”在当前是对话时新建对话，否则新建开发任务；“对话”分组的“+”总是新建对话（Ctrl+Shift+N）。
- 记忆的三个子视图（全部 / 项目 / 整理队列）从侧栏移到 `MemoryView` 标题下的标签；进化视图也保留共享侧栏。
- 标题栏只保留拖动区和品牌；会话位置只在对话标题栏显示一次。

**时间线：一个回合一条工作摘要。**

- `groupTimelineItems` 产出 `work-group`：同一回合段（被消息切开）里的思考和工具调用按到达顺序放在一起，标题行是语义摘要（“已处理 · 运行 2 条命令 · 编辑 3 处 · 1 段思考”），只有正在进行的回合自动展开，答案到达后折叠。
- 全部完成的计划卡折叠成一行，可再展开。
- 回合结束后在时间线末尾显示改动卡（文件、+/−、查看改动、撤销上一轮）。

**右侧详情面板：变更 / 文件 / 概况 / 电脑。**

- “上下文”和“运行”合并为“概况”；“电脑”只在桌面版可用时出现；标签用 `role=tab`；每个线程默认打开“变更”（有改动时）或“概况”；未发送的草稿默认收起面板，开合偏好按开发/对话分别记在本机。
- “最近更新”的记忆如实标注为最近条目，不冒充“本回合使用的记忆”（后端尚未记录归因）。

**审查与 git 闭环（新增真实能力）。**

- 新增 `ui/electron/source-control.mjs`，经 `cleo:git` IPC 暴露 `status / root / revertFile / revertHunk / commit / push / createPullRequest / pullRequest / listFiles / createWorktree / removeWorktree`（`revertHunk` 用 `git apply --reverse`，先 `--check`，视图过期时拒绝）。全部用 `execFile` 参数列表执行 `git` / `gh`，不经过 shell；路径校验必须位于仓库内；被 git 忽略的未跟踪文件拒绝删除。`revertFile` 只有在 git 明确回答“不在 HEAD、不在索引、未被忽略”时才删除文件：HEAD 能解析就必须能读到提交，“尚无提交”只在 HEAD 指向一个尚不存在的分支时成立，任何一步读取失败都拒绝撤销。`pullRequest` 只把“没有找到 PR”、未安装 `gh`、远端不在 GitHub 视为没有 PR，其他失败作为错误返回。
- `CleoClient.sourceControl` 在桌面版走 IPC，在 mock 客户端模拟同样的结果；`useCleoWorkspace.runSourceControl` 执行后刷新工作区与线程。
- 变更面板：diff 显示旧/新两列文件行号；逐文件撤销（确认后执行）；分支行提供 提交（可选提交后推送）/ 推送 / 创建 PR（需要 `gh`）；diff 行上可加审查评论（鼠标或键盘），评论汇总成一条消息直接发给 agent（运行中则排队），输入框里的草稿不受影响；送达确认之前评论不会被清除。评论在本机保存，绑定任务、仓库、分支和所在 hunk 的指纹（`h1:` 前缀）：改动变化后标注“此后文件有改动”，旧格式标注“版本未核对”，发给 agent 时同样注明；Git 行报告的分支与工作区记录不一致时（在 Cleo 之外切换了分支），评论暂不显示、不发送、不能新增，直到工作区刷新后一致。只有在 Cleo 中删除任务时才丢弃它的评论（任务列表有上限，不能当作完整清单）。PR 状态按分支归属，刷新失败时保留上次结果并注明，切换分支后不沿用旧分支的结果。
- 新建开发任务时可切换“当前目录 / 新 worktree”：选后者时在 `<仓库>/.cleo/worktrees/<slug>` 新建 `cleo/<slug>` 分支的 worktree（通过 `.git/info/exclude` 本地排除，不改动仓库跟踪文件），注册为项目后在其中发送。

**子任务、命令结果与记忆使用（后端增量字段）。**

- 线程新增可选字段 `parentId` / `routingTaskId`（`cleo/desktop/presenters.py`，取自 manifest 的 `parent_session_id` / `routing_task_id`）。子任务路由派生的会话在侧栏缩进到父任务下，父任务对话末尾列出子任务，子任务标题栏可回到父任务。
- 工具条目新增可选字段 `exitCode` / `durationMs`（`cleo/desktop/projection.py`，取自 Codex `commandExecution` 的同名字段；输出缺失时用 `aggregatedOutput`）。时间线显示退出码与耗时，摘要按退出码统计失败。
- 记忆来源：开发任务每一轮注入提示前，harness 服务把这一轮实际提供的偏好（条目 id 与简短摘录）记录为一条 `provider_event`（类型 `cleo/memory_context`，`cleo/memory/provenance.py`）；桌面投影把它挂到这一轮的用户消息上（`memoryContext`），时间线显示“提供了 N 条记忆偏好”，概况页列出最近一轮提供的记忆。记忆整理（Dream 投影与 compaction）跳过这条事件，注入的偏好不会被当成新的证据回流。Cleo 记忆工具的调用另在工作摘要中计为“查阅记忆 N 次”。投影版本升到 14，旧缓存自动重建。
- 子任务的运行状态：路由子任务在父任务的运行中执行，不在桌面运行表里；父任务运行时，会话状态为 running 的子任务显示为运行中（父任务结束后仍为 running 的显示为需要查看）。父任务运行期间界面每隔几秒刷新任务列表，新派生的子任务实时出现。只有带 `routingTaskId` 的会话算子任务，分叉（fork）仍是普通任务。
- git 安全以工作树顶层判断同一检出目录：项目列表变化时为每个开发项目查询一次 `root`，任何 git 写操作（含移除 worktree）之前先确认所有相关项目的顶层；文件操作从仓库根目录解析路径，与后端 diff 一致；git 写操作进行中不允许在同一检出目录启动任务。git 引号路径（空格、非 ASCII）按 git 的 C 字符串规则解析。

**其他。**

- 命令面板同时搜索命令与所有任务/对话；新增快捷键 Ctrl+B（侧栏）、Ctrl+Shift+D（详情面板）、Ctrl+,（设置）、Ctrl+Tab / Ctrl+Shift+Tab（按最近顺序切换线程）。
- 运行结束或开始等待批准/回答时，若用户没在看这个线程，发系统通知（可在命令面板关闭）。
- agent 提问从全屏模态改为贴在输入框上方的非模态卡片；权限说明不再截断；`/` 无匹配时给出说明。
- 设置去掉“运行设置”（单会话状态已在输入框的模型与权限控件里），导航分为 通用 / 模型与 Agent / 记忆与数据 三组；Dream Agent 模型选择与后台整理合并为“记忆整理”页，存储与维护单独一页。
- 视觉：令牌层改为平铺中性色、细分隔线、小圆角（控件 6px、容器 8–12px），面板不再浮起；`theme.css` 重写为平铺皮肤。弹出层与独立窗口同一套语言：审批卡、确认/重命名/移动/设置/快捷键/进化/首次安装等对话框统一 10px 圆角、细边框与较轻的 `--shadow-popup`，去掉着色图标底板与背景模糊；进化伴随窗口（`electron/evolution-monitor.css`）与重启、恢复窗口改用同一套令牌，并跟随主窗口选择的明暗（主窗口经 `cleo:window-theme` 设置 `nativeTheme.themeSource`；独立进程的伴随窗口与重启控制进程在启动参数 `--cleo-theme` 中收到同一选择；从外部直接冷启动的恢复入口仍跟随系统）；电脑控制条保留警示红但改为平铺。

## Alternatives considered

- **保留四个空间，只做视觉翻新。** 否决：两位评审都把空间切换列为 D1 的主要扣分项；聊天与开发线程互相不可见，增加记忆负担。
- **把聊天与开发在后端合并为一种线程。** 否决：两者的运行时、记忆空间与权限模型不同，属于后端架构决策，超出本次 UI 重构范围；在 UI 层统一列表即可获得大部分收益。
- **把进化完全移出导航，只留在命令面板。** 否决：进化是 Cleo 的差异化能力，保留一个侧栏入口但不再占据一级空间，兼顾可发现性与主流程。
- **git 操作走 Python 后端。** 否决：现有后端协议不含这些操作，Electron 主进程已有安全的子进程与路径工具，放在 `ui/electron` 不改变后端协议；后续若需要远程/无桌面场景再下沉到后端。
- **记忆预览按项目名匹配“相关记忆”。** 曾实现，后撤回：来源字段只是文本，按名称匹配会把不相关条目说成相关，违反“如实”原则。

## Consequences

- 正面：一级导航从 4 个空间 + 设置减为 1 条列表；改动的查看、评论、撤销、提交（只含任务文件）、推送、PR 都能在界面完成，同一检出目录有任务在运行时 git 操作会被禁用；任务可隔离到 worktree 并可移除；多任务有“需要你处理 / 运行中”总览和系统通知；子任务路由与评审的参与者在回答下方的“协作”一行可见。
- 负面与限制：
  - worktree 在后端仍注册为普通项目（UI 把它嵌套在来源项目下显示），移除 worktree 会删除目录、保留分支；合并回主分支需走推送与 PR；
  - 创建 PR 依赖本机已登录的 GitHub CLI；
  - 审查意见只保存在本机（localStorage），不随任务同步到其他设备；
  - 对话（chat）在建立 agent 时注入偏好，不是逐轮注入，因此只有开发任务显示逐轮记忆来源；
  - 子任务的产出摘要仍需打开子任务查看（路由记录不保存产出）；只有 Codex 报告命令退出码与耗时，其他 harness 的工具行不显示这两项。
- 测试：`tests/uiux-regressions.smoke.mjs`、`scripts/smoke*.mjs`、`scripts/settings-layout.mjs` 按新结构更新；新增 `electron/source-control.test.mjs`（用真实临时仓库验证撤销、提交、子目录项目、worktree、推送判断与路径越界）；`tests/desktop/test_projection.py`、`test_presenters.py` 覆盖新增字段，characterization golden 只新增了两个空字段。

## References

- 设计说明与评分：`docs/UI_UX_REFACTOR_v2.md`
- 关键代码：`ui/src/components/ThreadSidebar.tsx`、`ui/src/components/Conversation.tsx`（`groupTimelineItems`、`WorkGroupEntry`、`ChangesCard`）、`ui/src/components/Inspector.tsx`、`ui/src/components/ReviewActions.tsx`、`ui/electron/source-control.mjs`、`ui/src/styles/tokens.css`、`ui/src/styles/theme.css`
