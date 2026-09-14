# Cleo 自迭代架构：当前实现与评估依据

[打开交互架构图](D:/study/Carleton/CS/research/Cleo-AI-agent/docs/architecture/cleo-self-evolving.html) · [图表验收记录](D:/study/Carleton/CS/research/Cleo-AI-agent/docs/architecture/cleo-self-evolving.receipt.json)

本图依据 2026-09-10 的本地工作区，包含尚未提交的实现。HEAD 为 `f140500c587fed865fac3228b3a4731dc410ff0a`，但不能以此 commit 代替当前源码。Archify 的 commit 引用功能不支持这些未提交文件，因此源码依据单独记录在本文。

## 如何读图

这是一张逻辑组件图，箭头表示主要控制流或产物流，并非每条函数调用。“检查与打包”是 EvolutionManager 内部流程，单独画出是为了说明检查关口；并非新增常驻服务。“选中版本的 Cleo”表示切换后的整套 UI 和 Python 后端，复用图中同一套组件。“当前迭代源码”“版本状态”“程序副本”都是文件系统持久化，不代表独立数据库服务。

上方三个视角可聚焦修改构建、重启恢复、正式发布。默认无动画，可缩放、切换主题和导出。

## 实际职责与源码

| 组件 | 当前职责 | 本地依据 |
|---|---|---|
| 进化聊天界面 | 直接发送需求，首次准备工作区；监听回合结束后触发构建；展示应用、保存、放弃 | [App.tsx](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/src/App.tsx:42)、[EvolutionPanel.tsx](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/src/components/EvolutionPanel.tsx:38) |
| 编码会话与 Harness | 以受管 source 为工作目录，选择模型并注入数据兼容与保护约束 | [DesktopService](D:/study/Carleton/CS/research/Cleo-AI-agent/cleo/desktop/service.py:544) |
| 迭代管理器 | 根据基准 tag 克隆 Git 源码，再覆盖选中程序内嵌的源码；准备私有工具链 | [prepare](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution.mjs:145) |
| 检查与打包 | 检查保护文件哈希、执行平台打包与相关 JS 测试，再次核验源文件，登记候选 | [build](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution.mjs:214) |
| 状态与程序副本 | 保存 active、candidate、iteration.base、workspaceBase、latestSaved 和切换事务；清理旧程序 | [EvolutionStore](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution-store.mjs:122) |
| 应用与恢复 | stage 后创建独立控制器，显示重启窗口并握手；原程序退出后备份指定数据目录、切换程序 | [applyEvolution](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/main.mjs:60)、[applyFromController](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution-recovery.mjs:81) |
| 启动确认与回退 | 新 UI 获得工作区快照后确认 healthy；失败先停止目标，再尝试上一程序和保底；全失败保留恢复窗口 | [runHandoff](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution-handoff.mjs:5)、[bootstrap](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/bootstrap.mjs:15) |
| 共享用户数据 | 所有版本沿用当前 CLEO_HOME 与 Electron userData；版本切换不恢复旧数据副本 | [activate / recover / healthy](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution-store.mjs:229) |
| GitHub | 用户确认后由管理器通过 gh fork、push、创建或更新 PR；维护者在 GitHub 发布 Release | [submitPullRequest](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution.mjs:368) |
| 正式版下载 | 用户选择，验证清单、SHA-256 和 evolution_protocol: 2；下载不自动应用 | [downloadRelease](D:/study/Carleton/CS/research/Cleo-AI-agent/ui/electron/evolution.mjs:268) |

图中的源码 → GitHub、GitHub → 程序副本都是经管理器执行的简化产物流，不是模型自行发布。管理器与重启控制器共同读写 EvolutionStore；控制器按其中的版本 ID 找到程序副本，图中未铺开重复的存储访问连线。

## 三个操作的精确定义

- **应用**：切换到已检查且源码仍匹配的候选程序。它仍未保存，可以继续修改或放弃。
- **保存**：只接受已经应用、源码仍匹配的本地程序，增加名称/时间并设为 latestSaved，结束本轮迭代；不重启，也不发布 Release。
- **放弃**：丢弃本轮修改并回到 iteration.base。未应用时恢复源码工作区并重启后端；已应用时通过可见重启切回原程序。两种情况都保留当前用户数据。
- **继续迭代**：保存后下一轮以这次保存的 active 作为 iteration.base；workspaceBase 仍可保留最初选择的基础版。新保存成功后旧保存可清理，仍作为基础或恢复目标的除外。

## 建议重点评估的边界

1. **恢复保护不是操作系统隔离。** PROTECTED 列表保护 bootstrap、管理器、状态存储、工具与恢复模块的源码哈希及应用入口；它不包含整个 React 版本选择界面或 main.mjs。模型仍可能改坏主界面，因此独立保底入口很重要。各 Harness 权限模式也不同，不能据此宣称任意代码都无法损坏环境。
2. **保留数据不等于保证兼容。** 切换只变程序，不还原旧数据；兼容要求主要来自模型提示与具体测试。新旧读写器的任意格式变化尚无自动判定机制。备份是事故留存副本，不参与版本回滚。
3. **自动构建编排依赖前端。** 当前由 App.tsx 的运行状态监听触发；切换页面仍会跟踪完成，但并不是独立于窗口生命周期的持久任务队列。若未来要求关闭或异常退出后继续完整迭代，需要进一步设计任务恢复。
4. **程序保留数量不等于磁盘总量上限。** 基础、当前、最近保存可共用一份程序；独立保底必要时多一份。源码历史、下载包、数据备份和工具缓存另计。
5. **已验证的范围有限。** 已有 UI、状态存储、实际打包启动/退出和真实 Electron 故障恢复测试；真实模型从需求到修改、应用、保存再到 PR 的整条路径仍需实际使用验收。图表验证只验证本图，不扩大产品验收范围。

## 图表交付证据

- 类型：architecture；9/9 showcase，0 错误、0 警告。
- 自动浏览器：1440×900、1600×1000、1920×1080、2048×1320 均无水平或垂直溢出。
- 已目视检查 1440×900 浅色和 2048×1320 深色：文字容纳、路线/标签、卡片、对比和纵向布局通过。小屏总览的辅助文字较小，可聚焦或放大读取。
- 搜索、节点详情与导出交互未逐项人工操作验收；自动截图不能代替这类交互测试。
- 规格和 HTML 的 SHA-256、字节数见验收记录；本轮只新增架构文档，不修改 Cleo 功能代码。
