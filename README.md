# Cleo AI Agent

[English](README.en.md) | [文档中心](docs/README.md) | [架构说明](docs/ARCHITECTURE.md)

Cleo 是一套本地优先的 AI 工作空间：它把通用对话、开发者代理、会话恢复和可追溯记忆统一在一个桌面端与 CLI 中，同时允许团队按自己的模型、工具和数据边界部署。

项目提供 Windows、macOS、Linux 桌面构建支持，以及 Python CLI、Textual TUI 和 stdio MCP 入口。用户数据默认保存在本机；模型推理由用户配置的 API provider 或外部 agent harness 提供。

> 当前版本：`0.2.6`。Cleo 仍处于 pre-1.0 阶段，适合试用、内部工具集成和参与开发；对数据格式或扩展接口有稳定性要求的生产部署应固定版本并先完成验证。

## Cleo 解决什么问题

多数 AI 助手只覆盖一次对话，代码代理又各自维护独立的任务、权限和历史。Cleo 在它们之上提供一层统一的产品体验：

- **一个工作入口**：在桌面端或终端中切换通用聊天与 Productivity 开发工作流。
- **可恢复的会话**：把不同 provider 的输出归一化为本地事件，支持项目、标题、历史与恢复。
- **有边界的长期记忆**：记忆按 `space + project + session` 隔离，长期结论保留事件证据。
- **可替换的模型与 harness**：前台 Cleo、DreamAgent、Codex、Claude SDK 与 ACP agent 可独立配置。
- **本地可审计**：配置、会话、工具日志和记忆留在用户设备，不依赖 Cleo 自建的云端账户系统。

## 产品形态

| 入口 | 面向对象 | 主要用途 |
| --- | --- | --- |
| Cleo Desktop | 日常用户、开发者 | 会话与项目管理、通用聊天、Productivity、记忆查看、模型设置和自动更新 |
| Cleo Chat CLI / TUI | 终端用户 | 一次性提问、连续对话、图片附件、项目记忆与会话恢复 |
| Productivity TUI | 软件开发者 | 通过 Codex、Claude SDK 或 ACP agent 在指定目录中执行开发任务 |
| `cleo-codex-mcp` | 工具集成方 | 通过 stdio MCP 暴露 `codex` 与 `codex-reply` 两个工具 |

## 核心能力

- 流式通用对话与一次性任务，支持 JPEG、PNG、WebP 和 GIF 附件。
- 面向代码工作的统一 harness adapter，包含 provider-neutral 数据面和可选的 Codex 控制面。
- append-only `events.jsonl` 会话事实源、原子 manifest 和可重建 SQLite 索引。
- `non_productivity` 与 `productivity` 两个独立 memory space，避免通用上下文与工程上下文串流。
- 规则压缩、敏感信息清理和带证据引用的 DreamAgent 记忆整理。
- 项目级长期记忆、历史片段检索，以及仅承载交互倾向的全局 persona。
- 带 allowlist、路径边界、超时、输出上限和审计日志的本地 shell 工具。
- 每个 thread 独立的浏览器会话，以及公网/私网和域名访问边界。
- Windows、macOS 与 Linux 原生桌面包，按平台校验更新并保留用户数据。

## 5 分钟开始

### 使用 Windows 桌面版

从 [GitHub Releases](https://github.com/StDoses72/Cleo-AI-agent/releases) 下载最新的 `Cleo-windows-x64.zip`。也可以在源码仓库中运行带校验的安装器：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\download.ps1 -Launch
```

程序安装到 `%LOCALAPPDATA%\Programs\Cleo`，配置、会话、记忆和模型缓存保存在 `%LOCALAPPDATA%\Cleo`。升级只替换程序目录，不覆盖用户数据。

首次进入应用后，在“设置 → 模型”中配置 provider、模型、API Key 和可选 Base URL，再分别选择 Cleo 与 DreamAgent 使用的 profile。API Key 只写入本地配置，桌面读取接口不会回传明文。

### 从源码运行

要求 Python 3.12+；使用浏览器工具时还需要 Node.js 和 `agent-browser`。

```powershell
git clone https://github.com/StDoses72/Cleo-AI-agent.git
Set-Location Cleo-AI-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
npm install -g agent-browser@0.33.1
Copy-Item cleo\config\templates\cleo.example.json config\cleo.json
Copy-Item cleo\config\templates\harnesses.example.json config\harnesses.json
```

编辑 `config/cleo.json`，至少填写一个真实可用的 agent profile，然后启动：

```powershell
cleo
cleo "总结这个项目的架构"
cleo --productivity --cwd .
```

Linux/macOS 使用相同的 Python 包和 JSON 配置。原生桌面构建、安装格式与签名边界见[平台支持](docs/PLATFORMS.md)；预构建附件以当前 GitHub Release 为准。

## 常用工作流

```powershell
# 在 general 项目中打开连续对话
cleo

# 把通用对话与记忆绑定到逻辑项目
cleo --project product-planning

# 执行一次性任务
cleo "把下面的需求整理成验收标准"

# 在当前代码目录启动默认开发 harness
cleo --productivity --cwd .

# 选择已注册的 provider 和模型
cleo --productivity --provider codex --model gpt-5.5 --cwd .

# 恢复 Cleo 管理的会话
cleo --resume <session-id>
cleo --productivity --resume <session-id>
```

交互界面支持 `/help`、`/new`、`/project`、`/sessions`、`/resume`、`/rename`、`/attach` 和 `/productivity`。Productivity 还提供 `/cwd`、`/cd`、`/git`、`/diff`、`/model`、`/effort`、`/access`、`/approval`、`/native` 与 `/resume-native`；可用命令会随 provider 能力变化。

## 系统如何工作

```text
Desktop / CLI / TUI / MCP
            │
            ├── Cleo Chat ─────── Deep Agents + configured LLM
            │
            └── Productivity ──── AgentAdapter ─── Codex / Claude / ACP
                                      │
                                      ▼
                SessionStore: manifest + append-only event log
                                      │
                       compact projection + local indexes
                                      │
                         DreamAgent consolidation
                                      │
                    project memory + evidence + persona
```

最重要的边界是：

1. `events.jsonl` 是会话事实源；manifest、compact、SQLite 和 Markdown 都是投影。
2. 每条 session 与 memory 数据都属于 `space + project + session_id`。
3. provider 原生事件先转换成 Cleo canonical event，存储层不依赖特定 SDK。
4. 自动记忆不会修改 `AGENTS.md`、授予权限或创建 skill。

完整说明见[架构文档](docs/ARCHITECTURE.md)。

## 数据、隐私与安全边界

Cleo 是 local-first，不等于完全离线：

- 配置、会话、记忆、runtime state 和工具审计默认在本地保存。
- prompt、附件和工具上下文会发送给你选择的模型或 harness provider；应遵守该服务的隐私政策。
- 浏览器工具可能访问网络；默认拒绝 localhost、局域网、链路本地和云 metadata 地址。
- shell 与 coding harness 能修改文件或运行命令；权限取决于 `cleo.json`、`harnesses.json` 和 provider 自身的 sandbox/approval 设置。
- `config/cleo.json` 包含 API Key，不应提交到 Git 或共享给其他用户。

部署前请阅读[配置与安全边界](docs/CONFIGURATION.md)，并按使用场景收紧命令、目录、域名和 provider 权限。

## 仓库结构

```text
Cleo-AI-agent/
├── cleo/                 # Python 产品核心：agent、CLI、desktop service、session、memory、harness
├── ui/                   # Electron + React 桌面客户端
├── config/               # 本地配置（默认忽略提交）
├── docs/                 # 用户、架构、开发与设计决策文档
├── memory/               # 记忆策略和本地运行数据
├── scripts/              # 依赖、发布、下载、卸载与清理脚本
├── skills/               # Cleo 可加载的本地 skills
├── tests/                # 按生产模块映射的测试
├── compose.yaml          # 本地容器运行入口
├── pyproject.toml        # Python 项目元数据和直接依赖
└── README.md
```

## 文档导航

- [快速开始](docs/GETTING_STARTED.md)：安装、首次配置和第一条任务。
- [配置与安全边界](docs/CONFIGURATION.md)：模型、目录、工具、harness 与数据路径。
- [架构说明](docs/ARCHITECTURE.md) / [English](docs/ARCHITECTURE.en.md)：组件、数据流和持久化模型。
- [开发与发布](docs/DEVELOPMENT.md)：本地环境、测试、依赖锁定、Docker 和 Windows 发布。
- [后端代码导读](docs/BACKEND_CODE_REVIEW.md)：面向贡献者的阅读顺序与 review 清单。
- [运行时与数据维护指南](docs/Cleo_Runtime_State_Maintenance_Guide.docx)：变更 runtime、session 或 memory 时的操作手册。
- [记忆系统设计记录](docs/CASTMIND_MEMORY_MIGRATION.md)：分层记忆方案的来源与取舍。
- [双向记忆读取](docs/MEMORY_READING.md)：跨空间检索、会话续读和仅限 SDK 子进程的 MCP 接入。

## 开发与验证

```powershell
pip install -e ".[dev]"
ruff check cleo tests
pytest -q

Set-Location ui
npm install
npm run typecheck
npm run test:backend
npm run smoke
```

在目标操作系统和架构的 `ui/` 目录运行 `npm run package:portable`，产物生成到仓库根目录 `release/`。参见[开发与发布](docs/DEVELOPMENT.md)和 [Desktop 子系统说明](ui/README.md)。

## 当前边界

- 桌面目标为 Windows x64、macOS ARM64/x64、Linux x64。macOS 默认构建为开发签名包，正式分发还需签名和公证；详见[平台支持](docs/PLATFORMS.md)。
- Cleo 当前是本地单用户应用与 stdio 工具，不是多租户 Web 服务，也不开放 HTTP API。
- 通用聊天的模型接入以 OpenAI-compatible chat model 为主；provider 兼容性取决于其 API 行为。
- Productivity provider 的能力不完全对等；Codex 专属历史和控制面不会由 Claude/ACP 伪造。
- 长期记忆来自自动提取，仍应通过 evidence 与原始 event log 复核关键事实。

## 参与项目

欢迎提交 issue 和 pull request。开始改动前请先阅读 [AGENTS.md](AGENTS.md)、[开发文档](docs/DEVELOPMENT.md)和相关测试；变更 session、memory 或 provider 协议时，应同时更新对应文档与回归测试。

本项目采用 [MIT License](LICENSE)。
