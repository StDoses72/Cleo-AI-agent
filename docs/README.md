# Cleo 文档中心

[English](README.en.md)

这里是 Cleo 面向用户、部署者、集成方和贡献者的产品文档。根目录 [README](../README.zh-CN.md) 负责快速介绍；本目录按任务提供可执行的专题说明。

## 我想使用 Cleo

1. [快速开始](GETTING_STARTED.md)：选择桌面版或源码运行，完成首次模型配置并执行第一条任务。
2. [平台与安装](PLATFORMS.md)：各平台安装包、数据位置、更新、签名边界与发布附件。
3. [配置与安全边界](CONFIGURATION.md)：理解 `cleo.json`、`harnesses.json`、本地数据路径和权限边界。
4. [订阅登录与 DreamAgent](SUBSCRIPTION_CHAT.md)：用官方 CLI 登录的订阅连接。
5. [运行时与数据维护指南](Cleo_Runtime_State_Maintenance_Guide.docx)：备份、迁移、恢复和排查本地状态。
6. [程序版本与恢复](program-versions.md)：更新、切换版本、启动失败回退与保底入口。
7. [本地 skills](local-skills.md)：在开发会话中发现和调用本机技能。
8. [子任务路由](benchmark-routing.md)：连接候选、Artificial Analysis 数据、评估器、受约束委派与任务用量；执行权限见[子任务路由的统一权限](routing-permissions.md)。
9. [电脑使用](computer-use.md)：AI 按任务选择的三种目标——按会话隔离的内置浏览器、经 Cleo 扩展在后台操作的你的浏览器、本机电脑控制；本机桌面的前后实测见[电脑操作对比](benchmark-computer-use.md)。
10. 各版本的变化见 `release-notes-v*.md`，最新为 [v0.14.2](release-notes-v0.14.2.md)。

## 我想理解系统

- [架构说明](ARCHITECTURE.md)：产品边界、组件关系、会话模型、harness 与记忆数据流。
- [Architecture (English)](ARCHITECTURE.en.md)：英文架构说明。
- [记忆系统设计记录](CASTMIND_MEMORY_MIGRATION.md)：为什么采用 event log、compact、SQLite evidence 与分区记忆。
- [Markdown 记忆与迁移](MEMORY_MARKDOWN_GIT.md)：项目偏好以 Markdown 保存、由内嵌 Git 记录历史。
- [双向记忆读取](MEMORY_READING.md)：跨空间检索、会话续读和仅限 SDK 子进程的 MCP 接入。
- [任务用量台账](task-token-ledger.md)（英文）：任务边界、token 归属与美元参考。
- [Harness 交互式问答与回合生命周期](harness/interactive-lifecycle.md)：Claude / Codex / ACP 的原生问答、审批、回合结束与后台任务协议，Cleo 的适配方式与 adapter 层架构判断。

## 我想参与开发

1. [开发与发布](DEVELOPMENT.md)：环境、测试、依赖锁定与桌面发布。
2. [后端代码导读](BACKEND_CODE_REVIEW.md)：从入口到 session、harness、memory 和 desktop 的阅读路线。
3. [后端架构 v2](refactor/BACKEND_ARCHITECTURE_V2.md)与[行为基线测试](refactor/CHARACTERIZATION_TESTS.md)：重构的设计过程与 golden 测试。
4. [Desktop 子系统说明](../ui/README.md)：Electron/React 边界、IPC、构建和 smoke test。
5. [仓库贡献规则](../AGENTS.md)：代码修改和 review 的长期约束。

## ADR（架构决策记录）

- [ADR 索引与写作约定](adr/README.md)：影响架构、数据模型或用户可见行为边界的决策，按编号记录在 `docs/adr/`，重点是为什么这样选、否决了什么、留下了什么限制。
- [ADR 0001 失败的记忆源可自动重试（有界退避）并可从队列手动重试](adr/0001-retry-failed-memory-sources.md)
- [ADR 0002 已有会话加入同一空间的项目](adr/0002-move-conversation-into-project.md)
- [ADR 0003 内置浏览器按会话隔离、按需创建、闲置 10 分钟回收](adr/0003-per-conversation-built-in-browser.md)
- [ADR 0004 Claude 回合与后台任务的生命周期归 provider 所有](adr/0004-claude-turn-and-background-task-lifecycle.md)
- [ADR 0005 Codex CLI 只随 Python 运行时分发一次](adr/0005-single-codex-cli-distribution.md)
- [ADR 0006 在线运行环境的归属登记与基于证据的退役](adr/0006-online-runtime-ownership-and-retirement.md)
- [ADR 0008 桌面 UI 改为单侧栏信息架构、平铺视觉，并补齐审查与 git 闭环](adr/0008-single-sidebar-flat-ui-and-review-loop.md)（设计说明见 [UI/UX 重构 v2](UI_UX_REFACTOR_v2.md)）
- [ADR 0009 移除本地进化，保留并改名它与正式更新共用的版本基础设施](adr/0009-remove-local-evolution.md)（保留行为见[程序版本与恢复](program-versions.md)）
- [ADR 0010 加载工作区的开销不随历史规模增长；投影版本只在旧索引出错时提升](adr/0010-startup-cost-independent-of-history.md)
- [ADR 0011 上下文占用对所有 harness 用同一口径；账号用量在打开面板时按需读取](adr/0011-one-context-measure-and-on-demand-account-usage.md)
- [ADR 0012 Claude 在运行中的回合里读到的完成通知不单独等待回复](adr/0012-claude-notices-read-inside-a-running-turn.md)
- [ADR 0013 流式回复期间阅读位置归读者；「视口跟随」与「接收本轮输出」分开](adr/0013-reading-position-is-the-readers.md)
- [ADR 0014 Codex 速度档位按模型目录提供；模型不提供已保存的档位时以标准速度运行并保留选择](adr/0014-codex-speed-from-the-model-catalog.md)
- [ADR 0015 首屏与发送不等待 harness SDK 的导入；开始写消息时提前打开 harness 会话](adr/0015-start-and-send-without-waiting-on-harness-imports.md)
- [ADR 0016 Gemini 开发会话分两条路径接入：订阅额度走 Antigravity CLI，API Key / Google Cloud 走 Antigravity SDK](adr/0016-antigravity-sdk-and-cli-harnesses.md)
- [ADR 0017 电脑操作分三种目标并由 agent 选择；电脑页只显示正在使用的那一种；用户的浏览器经 Cleo 扩展在后台标签页中操作](adr/0017-agent-chosen-computer-modes.md)

## 历史文档

以下文档记录当时的调研、草案或某个版本的状态，不随实现更新：`DREAM_*.md`、`MEMORY_REDESIGN_PROPOSAL.md`、`MEMORY_SYSTEMS_RESEARCH.md`、`UI_UX_AUDIT_v0.4.8.md`、`UI_UX_IMPLEMENTATION.md`、`UI_UX_REFACTOR_v2.md`、`routing-v0.10.2.md`、`subtask-routing-*.md`、`harness-contribution-investigation.md`、`non-codex-harness-investigation.md`，以及各版本的发布说明。

## 文档维护约定

- 文档只描述仓库中已实现的能力；规划中的能力必须明确标记为规划。
- 用户可见的命令、配置字段、数据路径或安全默认值发生变化时，应同步更新相关专题文档。
- `events.jsonl` 是会话事实源；任何运行时或记忆文档都不得把派生的 SQLite/Markdown 投影描述为权威原文。
- 示例不得包含真实 API Key、私有目录、个人运行数据或一次性工作树状态。
- 中英文 README 与架构文档应保持关键能力、边界和版本信息一致。
