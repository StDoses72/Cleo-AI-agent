# Cleo v0.4.8 前端 UI/UX 审查

审查日期：2026-09-16。结论：需要系统性减少重复状态、实现细节和手动检查入口，同时修复焦点、草稿与失败反馈；只改两个截图中的样式不够。

本文保留修改前的审查结论。实现与验收状态见 [修复进度](UI_UX_IMPLEMENTATION.md)；不能将这里的建议当作已完成的修复。

## 发现与优先级

P1：影响操作正确性、内容保留或故障恢复，应先修。P2：影响日常阅读、操作效率与一致性，是这轮 UI 清理的主体。P3：次要整理。
“运行复现”来自隔离的 v0.4.8 renderer + mock；“源码确认”表示实现已核对，但未用真实服务端完成端到端复现。设计建议不等于已发生的功能故障。

| ID / 优先级 | 位置与证据 | 问题与用户影响 | 建议处理 |
| --- | --- | --- | --- |
| U01 · P1 | [ApprovalPrompt.tsx:25](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ApprovalPrompt.tsx#L25)、[Overlays.tsx:364](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L364)、[App.tsx:282](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/App.tsx#L282)。运行复现 | 设置没有隔离焦点；Tab 进入底层任务列表。等待审批时打开设置、将焦点放在“外观”按钮、按 Esc，底层审批被取消，设置仍在。审批监听未判断顶层弹窗；其他模态和全局快捷键也缺少统一协调。 | 统一模态焦点进入、循环、恢复与快捷键归属；只让最上层处理 Esc/Enter；设置打开时屏蔽审批数字键。不能用新增说明文案补救。关联 #37。 |
| U02 · P1 | [Overlays.tsx:408](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L408)、[Overlays.tsx:562](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L562)。运行复现 | Agent 指令编辑后切换到“外观”再返回，草稿消失；条件渲染卸载页面，重新从已保存内容初始化。 | 切页保留草稿；明确显示“未保存”。保存仍需明确操作；真正丢弃内容时才需要确认。连接向导与 DreamAgent 草稿使用同一规则。 |
| U03 · P1 | [ModelSettingsPanel.tsx:33](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/model-settings/ModelSettingsPanel.tsx#L33)、[useCleoWorkspace.ts:919](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/useCleoWorkspace.ts#L919)、[App.tsx:363](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/App.tsx#L363)。源码确认 | 模型配置初次读取失败时没有页面错误状态，settings 仍为空，界面继续显示“正在读取模型配置…”。切换历史和更新运行参数的失败写入 loadingError，但已有 snapshot 时 App 不显示它。 | 区分加载、失败、空数据；失败保留旧内容，显示一句可操作原因和“重试”。不要让用户靠关闭重开或重启恢复。 |
| U04 · P2 | [Conversation.tsx:229](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L229)、[Conversation.tsx:289](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L289)、[Conversation.tsx:308](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L308)。源码确认，与用户截图一致 | 已有接近顶部/底部自动分页，却继续展示“加载更早历史”“加载较新历史”。后者与回到最新箭头同时出现，把内部分页机制交给用户理解。 | 删除正常状态的分页按钮；滚动边缘自动预取，内容不足一屏时也应自动补页；保持阅读锚点。仅失败时显示小型重试入口。“回到最新”箭头保留，因为这是用户选择跳转，不是加载任务。关联 #52。 |
| U05 · P2 | [Conversation.tsx:296](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L296)、[index.css:1727](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/index.css#L1727)。运行观察、源码确认 | 三个工作圆点位于 VirtualTimeline 外，只有 2px 左边距，没有正文的居中和内边距，因此贴在侧栏边界。正在等待审批时仍显示工作动画和“Cleo 正在回复…”。 | 将活动状态纳入正文对齐系统；每轮只保留一个主要状态位置。等待回答/审批时显示对应状态，流式正文已经出现时避免重复加载动画。关联 #58。 |
| U06 · P2 | [Conversation.tsx:720](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L720)、[Conversation.tsx:814](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L814)、[index.css:1422](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/index.css#L1422)。运行观察 | “思考过程”“工具过程”每轮形成大卡片，并附“已有最终回答／尚无最终回答／已完成”等重复叙述；思考组运行时左右各有一个转圈。过程比回答更抢眼。 | 改为轻量可展开行，例如“执行记录 · 3 项”；默认突出当前活动和失败项，完成记录收起。保留原始记录与可访问的展开控件，删除重复结论和装饰背景。 |
| U07 · P2 | [Conversation.tsx:254](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L254)、[Conversation.tsx:317](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L317)。源码确认 | 长正文要点“查看完整正文（N 字符）”，随后在弹窗按“上一段／下一段”每 16384 字符阅读；普通消息也以 pre 形式显示，阅读被截断。 | 首次“展开全文”可保留以避免突然撑长页面；展开后自动续载，普通消息保持 Markdown 排版。字符偏移和分页单位不作为主界面文案。工具日志保留代码格式。 |
| U08 · P2 | [index.css:2](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/index.css#L2)、[index.css:816](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/index.css#L816)、[index.css:1921](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/index.css#L1921)。运行测量与源码确认 | 正文 12.5px、侧栏标题 11.5px、摘要 10px、底部状态 9px；审批说明 8.75px、选项说明 8px、代码差异 8.5px。部分弹窗采用字体变量，其他区域仍各自定字号。 | 统一语义字号、行高、字重；重要内容不再使用 8–10px。沿用现有无衬线风格，补齐明确的中文回退字体；只给代码、路径与终端用等宽字。具体基准见下文。 |
| U09 · P2 | [ThreadSidebar.tsx:88](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ThreadSidebar.tsx#L88)、[Overlays.tsx:403](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L403)、[Overlays.tsx:589](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L589)。运行观察 | “搜索 thread”“Non-productivity 系统指令”“真实 harness session”“每个 turn…sandbox”混入日常流程；WORKSPACE / MEMORY / DURABLE CONTEXT 等装饰标签重复中文标题。 | 主界面统一用“任务／对话、模型、运行方式、访问范围”；删除无导航作用的英文眉题。SDK/ACP、配置文件名、原始模式值移到详情；专业名称在确需辨识服务时保留。 |
| U10 · P2 | [Overlays.tsx:392](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L392)、[Overlays.tsx:428](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L428)。运行观察 | 设置堆叠“选择更适合当前环境的界面亮度”“当前使用…紧凑布局”“直接读取本地 backend…”；信息密度不可调整，却占一整行。Agent 页“默认模型”实际修改当前任务，作用范围不清。 | 删除不影响选择的说明与不可配置展示行；主题名用“深色／浅色”。区分“当前任务模型”和“新对话默认模型”。技术模板、数据位置、重置放到高级区；保留重置的真实后果说明。关联 #34/#38 的入口规划。 |
| U11 · P2 | [ConnectionWizard.tsx:155](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/model-settings/ConnectionWizard.tsx#L155)、[ConnectionDetails.tsx:33](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/model-settings/ConnectionDetails.tsx#L33)。源码确认 | 用户要自己判断点“登录”还是“已登录，验证连接”；连接详情需要另点“验证连接”。缺少客户端时安装链接藏在高级设置。 | 进入连接流程先自动检查客户端和已有登录态，成功后读取模型；缺客户端时直接给安装入口。验证失败时保留重试。已有登录流程本来就会轮询完成状态，不必重做。自动探测只做非生成式检查，不偷偷发收费模型请求。关联 #32。 |
| U12 · P2 | [ModelPicker.tsx:23](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/model-settings/ModelPicker.tsx#L23)、[ConnectionWizard.tsx:176](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/model-settings/ConnectionWizard.tsx#L176)、[ModelSettingsPanel.tsx:65](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/model-settings/ModelSettingsPanel.tsx#L65)。源码确认 | 模型行常重复显示名称和相同 ID；选择后还要点“选择此模型”；连接成功后还要点“返回当前配置”；同一连接同时有“管理”和更多按钮。 | 普通单选模型点行即应用；若涉及运行中交接，则单独保留真实影响提示。连接保存成功直接返回列表并短暂标记新增项；合并管理入口；只在显示名与 ID 有辨识价值时保留两行。 |
| U13 · P2 | [useCleoWorkspace.ts:246](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/useCleoWorkspace.ts#L246)、[useCleoWorkspace.ts:554](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/useCleoWorkspace.ts#L554)。源码确认 | 进入记忆页直接返回；普通回合 done 只更新任务状态，没有刷新记忆概览。用户仍可能看到旧待整理列表。 | 回合结束、进入记忆页及整理完成时自动刷新记忆数据；按需去重请求，旧响应不能覆盖新响应；不重置任务、草稿或滚动位置。关联 #29。 |
| U14 · P2 | [MemoryView.tsx:37](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/MemoryView.tsx#L37)、[MemoryView.tsx:223](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/MemoryView.tsx#L223)、[MemoryView.tsx:338](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/MemoryView.tsx#L338)。运行观察与源码确认 | 记忆页先放大标题、说明和四个指标，再展示内容；DreamAgent 状态在侧栏、底部标题和底部徽标重复。待整理项显示 session ID、版本号和事件数，难以辨识是哪段对话。 | 默认先看记忆与待整理列表；指标压缩为一行或按需展开。待整理项用任务标题、内容摘要和更新时间；原始 ID/事件数放详情，必要时扩展 DTO。保留一次整理操作，不把“刷新列表”变成自动整理用户记忆。 |
| U15 · P2 | [MemoryView.tsx:425](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/MemoryView.tsx#L425)、[Inspector.tsx:173](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Inspector.tsx#L173)、[WorkspaceRail.tsx:42](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/WorkspaceRail.tsx#L42)。源码确认 | 筛选待确认列表无结果也说“队列目前是干净的”；上下文用量未知时标题显示 0%；本地连接绿点固定显示就绪，未绑定连接健康状态。这些简短状态可能误导。 | 区分“没有匹配项／确实为空”“未获取／0%”；连接状态绑定真实健康状态，正常时避免三处重复展示。 |
| U16 · P2 | [Inspector.tsx:198](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Inspector.tsx#L198)、[Conversation.tsx:1168](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L1168)。源码确认 | “已附加记忆”行是带箭头的 button，却没有点击行为；输入框按钮叫“添加上下文”，实际只是打开上下文检查器。 | 无动作的项改成可读列表，或接通真实详情；将现有入口改名“查看上下文”。不能用按钮外观暗示不存在的能力。 |
| U17 · P2 | [App.tsx:464](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/App.tsx#L464)、[EvolutionPanel.tsx:130](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/EvolutionPanel.tsx#L130)、[GithubLogin.tsx:26](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/GithubLogin.tsx#L26)。源码确认 | 普通对话常驻“改进 Cleo／从此对话创建改进案例”；进化页顶部同时放版本、检查状态、应用/保存/放弃、GitHub 连接大块和验收入口。没有相关意图时也占用阅读区。 | “改进 Cleo”放入任务更多菜单；进化顶部收敛为版本 + 当前阶段 + 下一步主要操作。GitHub 连接放入提交/发布流程，异常或待授权时再展开。 |
| U18 · P2 | [EvolutionPreparation.tsx:24](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/EvolutionPreparation.tsx#L24)、[EvolutionCases.tsx:36](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/EvolutionCases.tsx#L36)。源码与现有交互测试确认 | 同一需求在聊天、验收准备和行为验收多次呈现；“已冻结／沿用冻结案例／构建后预期／静态证据”等内部阶段要求用户学习流程，多层卡片和滚动区挤占主任务。 | 保留单一验收清单，默认显示“要达到什么效果 + 当前结果”；证据与历史按需展开。动作统一为“继续修改／确认效果／取消此项”。自动检查随构建运行；人工验收仍由用户判断。 |
| U19 · P2 | [EvolutionContribution.tsx:63](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/EvolutionContribution.tsx#L63)、[ContributionMerge.tsx:33](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ContributionMerge.tsx#L33)。源码确认 | 提交表单在输入前展示 fork、完整源码、submission-base、owner/collaborator 等多段机制说明；还要求用户刷新分支、检查分支存在、检查兼容性。合并状态同时有 PR 行刷新和“帮助合并 / 刷新状态”。 | 选版本/分支后自动预检；从 GitHub 返回时刷新；等待创建期间在页面可见时低频检查。只显示具体阻塞原因和下一步。主表单保留目标、版本、标题、说明；技术证据折叠。创建申请/PR 与修复操作仍明确触发。 |
| U20 · P2 | [UpdateVersionPicker.tsx:17](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/UpdateVersionPicker.tsx#L17)、[Overlays.tsx:495](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L495)、[main.mjs:469](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/electron/main.mjs#L469)。源码确认 | 已有启动及六小时自动检查，更新页又同时提供“刷新版本列表”和“检查更新／重新检查”。当前版本、目标版本、发布类型多处重复，SHA-256 与依赖检查细节占主页面。 | 合并自动检查与列表刷新，进入页面按过期状态刷新；正常只显示当前版本、可用更新和一个主要动作。历史版本放“其他版本”；失败才出现重试。下载和重启安装保持明确动作。 |
| U21 · P2 | [ReleasePublisher.tsx:63](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ReleasePublisher.tsx#L63)、[ReleasePublisher.tsx:89](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ReleasePublisher.tsx#L89)。源码确认 | 发布表单要求点“重新检查发布权限”，来源在下拉和正文重复显示，版本号未输入就出现格式说明。底层发布过程本来会重新核验权限。 | 打开发布表单、切换来源时自动做只读预检；来源仅显示一次；版本格式用示例，错误时给原因。底层发布前核验保留；“发布”仍是明确的最终动作。 |
| U22 · P2 | [Conversation.tsx:1102](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L1102)、[Conversation.tsx:1140](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Conversation.tsx#L1140)、[App.tsx:471](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/App.tsx#L471)。源码确认，v0.4.8 新增 | harnessSwitchStatus 同时传给 sendBlocked 和独立状态区，切换提示会显示两遍；交接完毕后仍有较长机制说明。输入框正在运行时完全禁用，连下一条草稿都不能编辑。 | 合并为一个简短状态，例如“正在切换到 Claude…”；交接异常才展开说明。允许编辑草稿与实时 Steer 是两件事，草稿不应因运行而锁死；发送行为再按后端能力处理。关联 #33/#57。 |
| U23 · P3 | [ThreadSidebar.tsx:91](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ThreadSidebar.tsx#L91)、[ThreadSidebar.tsx:214](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/ThreadSidebar.tsx#L214)、[Overlays.tsx:382](https://github.com/StDoses72/Cleo-AI-agent/blob/020bf1e0b05040a6cd105204ce39646656c60dc2/ui/src/components/Overlays.tsx#L382)。源码与运行观察 | 开发侧栏“更多”可只打开“没有可恢复的历史记录”；搜索框里的 Ctrl K 实际打开命令面板，和过滤任务不是一回事；正式发布代码固定写 Preview。 | 无可用动作时去掉空菜单；搜索与命令快捷键分清；移除固定 Preview。新任务、搜索、任务列表的正常功能保留。 |

## 文案删减样例

判断顺序：删掉后还能判断“在哪里、现在怎样、接下来做什么”，就删；确有作用但不是当前决策所需，移入详情；用户必须据此选择的内容才保留。

| 当前内容 | 建议 |
| --- | --- |
| 加载较新历史 / 加载更早历史 | 删除；边缘自动加载 |
| 正在加载历史… | 正常快速加载不出现大块文字；较慢时在加载边缘显示小型状态 |
| 1 条记录 · 已有最终回答 | 删除“已有最终回答”；用轻量“执行记录”折叠行 |
| 选择更适合当前环境的界面亮度。 | 删除 |
| 当前使用适合桌面工作区的紧凑布局。 | 连同不可调整的信息密度行一起删除 |
| 当前页面直接读取本地 Cleo backend… | 删除 |
| Non-productivity 系统指令 | 对话指令 |
| 不会传给 Codex、Claude 或 OpenCode productivity harness | 简化为“仅用于普通对话”，作用范围有价值，应保留 |
| Session 已更新至第 N 版，共 M 个事件 | 任务标题 + 内容摘要 + 更新时间；原始计数移详情 |
| 检查分支是否已创建 | 自动检查；显示“等待分支创建”或可提交状态 |
| 仅检查客户端连接、登录状态和模型列表；未发送模型请求，额度及 MCP 工具执行尚未验证。 | 简洁显示“已连接 · 未测试调用”；完整检查范围放可展开说明，不能把它改成“全部可用” |
| 修改前：源码分析 · 尚未实测 | 保留“未实测”事实，以小型状态呈现，不能删成“已验证” |
| 永久删除、访问范围、重启安装的影响 | 保留；这是用户作决定所需的信息 |

## 自动化边界与执行方式

正常路径不要求手点“刷新／检查”。进入相关页面、外部登录返回、任务完成、版本或分支变化是优先触发点；等待远端状态时才轮询。

| 流程 | 自动完成 | 保留明确操作 |
| --- | --- | --- |
| 历史消息 | 双向预取、内容补页、保持阅读锚点 | 回到最新；失败重试；首次展开长内容 |
| 记忆页 | 进入、任务结束、整理结束后的状态刷新 | 整理、忽略 |
| 模型连接 | 查客户端/登录态、读取模型列表、回到窗口后复查 | 登录授权、保存密钥与连接、必要的重试 |
| GitHub PR | 读取分支、检查是否已创建、只读兼容性检查、状态同步 | 提交申请、创建 PR、启动修复 |
| 更新 | 已有定时检查、进入页面时按需刷新 | 下载、选择旧版本、重启安装 |
| 发布 | 权限和来源检查、运行中进度同步 | 发布、取消发布、失败后的继续发布 |
| 审批和提问 | 同步真实待处理状态 | 回答、允许、拒绝；不自动替用户作决定 |

自动刷新必须遵守：页面不可见时停止无必要轮询；合并重复请求；失败退避；新请求完成后忽略旧响应；保留旧数据、输入与阅读位置。不对正在编辑的表单偷偷覆盖，也不因刷新启动模型生成、修改文件或发送外部内容。

## 字体与布局基准建议

视觉方向：沿用 Cleo 现有克制的桌面工作区风格，正文优先；靠间距和层级组织，不靠更多框、徽标和解释段落。

Windows 浏览器实测：英文正文为 Segoe UI，中文正文为 Microsoft YaHei；没有证据表明当前混用了衬线正文。问题主要是字号偏小、过多独立规格、中文粗体与英文半粗体观感差异，以及小字承载过多信息。声明 Inter 并不代表运行时已经加载 Inter。

建议以现有界面做最小统一：

- 正文 14px，控件与列表 13px，辅助文字 12px；代码和日志 12–13px。用于阅读或决策的信息不降至 8–10px。
- 页面标题约 24px，面板/弹窗标题约 18px；统一 400/500/600 三档字重。具体值在深浅主题和缩放验收中调整。
- 统一无衬线字体栈，明确 Windows/macOS 中文回退；等宽字只用于代码、终端、路径等确有需要的内容。
- 一个区域只突出一个主要动作；可展开记录用列表行，去掉多层卡片与装饰色块。
- 加载不改变主要布局高度；短状态变化不弹窗；失败信息能复制并能重试。
- 不以减少文字为理由删掉控件名称、键盘提示、可访问名称或真正的权限/数据损失说明。

## 建议落地顺序与验收

1. **操作正确性**：U01–U03。先处理模态、快捷键、草稿、读取失败。验收：Tab 不穿透；Esc 不误取消审批；中文输入不误提交；切页保留草稿；失败不会永久转圈。
2. **聊天主流程**：U04–U07、U22。移除分页按钮，统一活动状态和执行记录。验收：滚轮、拖滚动条、键盘都能连续翻历史；加载前后保持同一段；正在回看时新消息不强制跳底；等待审批不伪装为生成中。
3. **视觉与文案统一**：U08–U10、U14–U16、U23。共享字体尺度，删重复说明、假按钮和装饰标签。验收：只看标题、状态和动作就能完成操作；长中文、URL、错误能完整查看。
4. **连接、更新、贡献与进化流程**：U11–U12、U17–U21，同时接通 U13。验收：正常流程无需手点检查刷新；自动化不产生提交、发布或权限决定；只有错误或明确决策需要操作。

#52 的滚动性能应补真实长对话录制和测量；当前已确认的冗余按钮与状态插入问题不能代替性能根因定位。#33 的 Steer、#57 的并发、#34/#38 的权限策略、#30 的耗时采集需要独立的前后端实现，不应通过解除禁用或补标签冒充完成。

## 审查基线与覆盖清单

- 主基线：v0.4.8，提交 `020bf1e0b05040a6cd105204ce39646656c60dc2`。本文源码链接固定到该提交。
- 对照：本地 main / origin/main 为 `bf7d1fb5fe1c16baaa4958cd68b3b78fb08aeb3f`，版本 0.4.5；未切换分支或合并版本。
- 已检查 `ui/src` 全部 **45 个文件：25 个 TSX、4 个 CSS、16 个 TS/声明文件**。覆盖所有界面组件，不只截图所在的聊天区。
- 忽略行尾差异后，main 与 v0.4.8 的 renderer 有 19 个文件不同；聊天分页、圆点定位、设置焦点、记忆刷新等核心问题在两者中均有对应实现。更新选择器、发布表单、GitHub 常驻区和交接提示以 v0.4.8 为准。
- 本次是全前端界面的 UI/UX 审查，不是整个仓库的全量安全或正确性审计；Python 后端、全部 Electron 模块和所有测试文件不在逐文件审查承诺内。

| 子系统 | 已检查文件（相对 ui/src） |
| --- | --- |
| 入口与全局布局 | App.tsx、main.tsx、index.css、platform.ts、useInspectorResize.ts |
| 导航与任务列表 | components/WorkspaceRail.tsx、components/ThreadSidebar.tsx |
| 对话与历史 | components/Conversation.tsx、components/VirtualTimeline.tsx、components/timeline.css、useTimelineHistory.ts、timeline-cache.ts |
| 提问与审批 | components/ApprovalPrompt.tsx、components/QuestionDialog.tsx、useQuestions.ts |
| 检查器 | components/Inspector.tsx |
| 记忆 | components/MemoryView.tsx、memoryStatus.ts |
| 设置、确认、通知 | components/Overlays.tsx |
| 模型连接 | components/model-settings/ModelSettingsPanel.tsx、ConnectionWizard.tsx、ConnectionDetails.tsx、ModelPicker.tsx、ModelDialog.tsx、catalog.ts、model-settings.css |
| 进化、验收与贡献 | components/EvolutionPanel.tsx、EvolutionPreparation.tsx、EvolutionCases.tsx、EvolutionContribution.tsx、ContributionMerge.tsx、GithubLogin.tsx、evolution.css、useEvolution.ts |
| 发布与更新 | components/ReleasePublisher.tsx、UpdateVersionPicker.tsx、ReleasePackages.tsx |
| 状态、协议与演示数据 | useCleoWorkspace.ts、types.ts、evolution-types.ts、vite-env.d.ts、services/cleoClient.ts、ipcCleoClient.ts、mockCleoClient.ts、mockData.ts |

补充检查：ui/package.json、index.html、tsconfig.json、vite.config.ts、ui/README.md 的相关运行与验证说明；Electron main 的更新定时器与请求入口，以及发布权限、分支刷新和发布轮询的相关调用。测试检查包括 timeline-cache、model-connection-scope、harness-switch-ipc、interaction-ui.smoke 与 fixture；smoke-layout 仅查看相关 fixture 和启动段，不计作完整测试源码审查。

**发现的非活动组件**：ReleasePackages.tsx 在 renderer 中没有导入者；其“查找匹配构建／刷新安装包状态”是遗留设计，不计入当前可见界面的 U01–U23，也不把它错误归因到用户正在使用的发布流程。后续可独立决定删除或重用。

## 验证结果与限制

- v0.4.8 的 TypeScript 检查与 Vite production build 通过；有一个大于 500kB 的 JS chunk 提示，本次不据此认定滚动卡顿原因。
- 14 项相关测试全部通过：时间线缓存、模型连接检查范围、harness IPC。
- 现有 interaction-ui.smoke 通过：命令/技能选择、中文输入事件、反馈、跳过、直接验收、重新载入。
- 隔离浏览器运行观察：1280×720 与 980×680；设置各页、主会话、记忆、浅色/深色、审批。实测焦点穿透、Esc 误取消审批、指令草稿丢失；检查了字号、实际渲染字体及页面截图。
- 进化、贡献和发布以源码与调用关系核查为主，没有登录真实账号、创建 PR、发布版本或安装更新。
- 尚未完成 macOS 字体、真实桌面 125%/150% 缩放、所有错误分支和真实长会话性能的视觉验收；这些保留为实现后的验收要求。
- 当前未配置独立 lint 脚本。本轮未跑全部 Electron/Python 测试，因为没有产品实现变更，也不声称上述通过意味着 UI/UX 已合格。
