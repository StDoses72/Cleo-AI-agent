# Cleo 快速开始

本指南面向第一次使用 Cleo 的用户。完成后，你将能够配置模型、运行通用聊天、启动一个开发者 harness，并知道数据保存在哪里。

## 选择运行方式

| 方式 | 适合场景 | 前置条件 |
| --- | --- | --- |
| Windows 桌面版 | 日常使用、最少环境配置 | Windows x64；一个可用的模型 API |
| Python 源码 | 开发、调试、Linux/macOS 使用 | Python 3.12+；可选 Node.js |
| Docker | 隔离运行、复现环境 | Docker；宿主机配置文件和持久化 volume |

## Windows 桌面版

### 1. 下载与安装

从 [GitHub Releases](https://github.com/StDoses72/Cleo-AI-agent/releases) 下载 `Cleo-windows-x64.zip`。如果已经克隆仓库，也可以运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\download.ps1 -Launch
```

下载器会验证 SHA-256 后再替换程序目录，并保留现有用户数据。默认位置：

```text
%LOCALAPPDATA%\Programs\Cleo\   程序与内置 Python/Node runtime
%LOCALAPPDATA%\Cleo\            配置、会话、记忆、模型、skills、workspace
%USERPROFILE%\.codex\           Codex 登录和原生 task 历史
```

### 2. 配置模型

打开“设置 → 模型”，新建或更新一个 profile：

- `provider`：当前通用聊天使用的 chat-model provider 标识；默认模板使用 `openai`。
- `model`：provider 可识别的模型名称。
- `api_key`：该 provider 的 API Key。
- `base_url`：OpenAI-compatible 服务的可选 endpoint。
- `max_tokens`：Cleo 用于展示 context window 的配置上限。

把 profile 分配给 Cleo 与 DreamAgent。两者可以使用同一个 profile，也可以分别选择成本或能力不同的模型。

### 3. 创建第一个会话

在 Chat 中发送一条消息，例如：

```text
请把我接下来提供的产品需求整理成目标、非目标和验收标准。
```

使用项目选择器把长期主题分到不同 project。默认 project 为 `general`；项目是记忆边界，不要求对应代码目录。

### 4. 启动 Productivity

切换到 Productivity，选择一个已有代码目录，再选择已启用的 harness provider。默认配置注册 Codex；Claude SDK 或 ACP agent 需要在本地配置并满足各自的认证/命令要求。

Productivity 中的工作目录是真实代码边界。开始任务前确认界面显示的 cwd、Git branch、sandbox 和 approval 模式符合预期。

## 从源码运行

### 1. 创建环境

PowerShell：

```powershell
git clone https://github.com/StDoses72/Cleo-AI-agent.git
Set-Location Cleo-AI-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

Bash：

```bash
git clone https://github.com/StDoses72/Cleo-AI-agent.git
cd Cleo-AI-agent
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

浏览器工具还需要：

```bash
npm install -g agent-browser@0.33.1
```

### 2. 创建配置

PowerShell：

```powershell
Copy-Item cleo\config\templates\cleo.example.json config\cleo.json
Copy-Item cleo\config\templates\harnesses.example.json config\harnesses.json
```

Bash：

```bash
cp cleo/config/templates/cleo.example.json config/cleo.json
cp cleo/config/templates/harnesses.example.json config/harnesses.json
```

编辑 `config/cleo.json`，替换模板中的 API Key 和模型信息。配置文件缺失时，Cleo 也会生成默认模板并终止启动，提示用户补全配置。

### 3. 验证入口

```bash
cleo --help
cleo "用三句话介绍 Cleo"
cleo
cleo --productivity --cwd .
```

根目录 `python main.py` 与 `cleo` 等价，保留用于兼容旧脚本。

## 用 Docker 运行

仓库内 Compose 复用同一套 JSON 配置：

```bash
docker compose build
docker compose run --rm cleo
docker compose run --rm cleo "总结当前工作区"
```

默认挂载 `config/cleo.json`、`config/harnesses.json` 和 `workspace/`，并用 named volume 持久化 `data/`、`memory/` 与 Codex home。Cleo 当前没有 HTTP 服务，因此 Compose 不开放端口。

## 常用 CLI 选项

| 选项 | 用途 |
| --- | --- |
| `cleo [message]` | 无 message 进入交互聊天；有 message 执行一次性任务 |
| `--project NAME` | 绑定通用聊天的逻辑 memory project |
| `--resume ID` | 恢复 Cleo 管理的聊天或 Productivity session |
| `--productivity` | 进入开发者 harness 模式 |
| `--provider NAME` | 选择 `harnesses.json` 中已启用的 provider |
| `--cwd PATH` | 指定 Productivity 的真实工作目录 |
| `--model NAME` | 临时覆盖 Productivity 模型 |
| `--print-config-template` | 向 stdout 输出便携的 `cleo.json` 模板 |
| `--print-harnesses-template` | 向 stdout 输出 `harnesses.json` 模板 |

`--provider`、`--cwd` 和 `--model` 只能与 `--productivity` 一起使用。`--thread-id` 只为 Cleo chat 指定新的 thread key，不会读取保存的 session；恢复已有会话应使用 `--resume`。

## 第一次使用后的检查

- 新建会话后，可以在 session 列表中看到标题、项目与更新时间。
- 正常结束后，session 目录应包含 `manifest.json`、`events.jsonl` 和 `compact.json`。
- 关键长期信息经过 DreamAgent 后，可以在 Memory 视图或对应项目的 `MEMORY.md` 中查看 evidence-backed 投影。
- 如果启用了 shell/browser 工具，确认它们的目录、命令和网络权限符合预期。
- 不要提交 `config/cleo.json`、runtime 数据库、event log、API Key 或用户附件。

## 常见启动问题

### 配置文件刚被创建，程序立即退出

这是预期行为。打开错误信息中的 `cleo.json` 路径，填写真实模型与 API Key 后重新启动。

### 通用聊天可用，但 Productivity 不能启动

检查 `config/harnesses.json` 的 `default_provider` 是否存在且启用，并确认对应 SDK 的认证状态或 ACP 命令可用。OpenCode 作为 ACP provider 时需要单独安装 OpenCode CLI。

### 浏览器工具不可用

源码运行需要可执行的 `agent-browser` 命令，以及本机 Chrome 或 Edge。桌面发布包已包含 Node runtime 和固定版本的 `agent-browser`。

### 首次记忆整理较慢

DreamAgent 会直接读取经过校验的 compact 投影并调用所选模型。较长 session 的首次整理可能需要数分钟；Memory 页面会显示运行状态，完成或失败后写入持久状态。

下一步：阅读[配置与安全边界](CONFIGURATION.md)或[架构说明](ARCHITECTURE.md)。
