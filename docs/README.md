# Cleo 文档中心

这里是 Cleo 面向用户、部署者、集成方和贡献者的产品文档。根目录 [README](../README.md) 负责快速介绍；本目录按任务提供可执行的专题说明。

## 我想使用 Cleo

1. [快速开始](GETTING_STARTED.md)：选择桌面版或源码运行，完成首次模型配置并执行第一条任务。
2. [配置与安全边界](CONFIGURATION.md)：理解 `cleo.json`、`harnesses.json`、本地数据路径和权限边界。
3. [运行时与数据维护指南](Cleo_Runtime_State_Maintenance_Guide.docx)：备份、迁移、恢复和排查本地状态。

## 我想理解系统

- [架构说明](ARCHITECTURE.md)：产品边界、组件关系、会话模型、harness 与记忆数据流。
- [Architecture (English)](ARCHITECTURE.en.md)：英文架构说明。
- [记忆系统设计记录](CASTMIND_MEMORY_MIGRATION.md)：为什么采用 event log、compact、SQLite evidence 与分区记忆。

## 我想参与开发

1. [开发与发布](DEVELOPMENT.md)：环境、测试、依赖锁定、Docker 与 Windows 桌面发布。
2. [后端代码导读](BACKEND_CODE_REVIEW.md)：从入口到 session、harness、memory 和 desktop 的阅读路线。
3. [Desktop 子系统说明](../ui/README.md)：Electron/React 边界、IPC、构建和 smoke test。
4. [仓库贡献规则](../AGENTS.md)：代码修改和 review 的长期约束。

## 文档维护约定

- 文档只描述仓库中已实现的能力；规划中的能力必须明确标记为规划。
- 用户可见的命令、配置字段、数据路径或安全默认值发生变化时，应同步更新相关专题文档。
- `events.jsonl` 是会话事实源；任何运行时或记忆文档都不得把派生的 SQLite/Markdown 投影描述为权威原文。
- 示例不得包含真实 API Key、私有目录、个人运行数据或一次性工作树状态。
- 中英文 README 与架构文档应保持关键能力、边界和版本信息一致。
