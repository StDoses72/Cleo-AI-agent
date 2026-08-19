# Cleo AI Agent

English version: [README.en.md](README.en.md)

Cleo AI Agent 是一个 local-first 的个人 AI agent runtime，基于 Deep Agents 和
LangChain 构建，通过 API 调用语言模型。Cleo 把配置、会话状态、session event log、
项目记忆、工作区文件和local shell 工具都放在本地管理；模型推理由你在
`config/cleo.json` 中配置的 API provider 提供。

本文只描述当前仓库已经存在的能力，不把未来计划写成已完成能力。

## 当前能力

- one-shot message：通过 `cleo "..."` 或 `python main.py "..."` 发送一次性消息。
- interactive chat：直接运行 `cleo` 或 `python main.py` 进入 Textual 全屏聊天，支持流式输出、
  可点击的记忆项目与会话选择、图片附件和快捷操作。
- productivity TUI：使用 `cleo --productivity` 或聊天中的 `/productivity` 进入 Textual
  全屏工作区，支持流式 agent 输出、可点击折叠 diff、项目选择、点击恢复会话、Git 侧栏和快捷操作。
- API-backed model profile：前台 Cleo 与 DreamAgent 可从 `config/cleo.json` 独立选择 agent profile。
- Pydantic settings：`cleo/config/settings.py` 用 Pydantic 校验 agent、directory、shell、tools 四类 profile。
- image attach：交互中使用 `/attach` 为下一条消息附加图片，支持 JPEG、PNG、WebP 和 GIF。
- session event log：每轮结束后向 `events.jsonl` 增量追加规范事件，并原子更新 `manifest.json`。
- resume：启动时如果存在未结束的 `current_thread_id`，会直接恢复该 thread；也可在会话选择器中点击恢复。
- layered memory：原始 event log 派生出脱敏 compact view、SQLite 历史 chunks 和带 event evidence 的原子长期记忆。
- memory spaces：`non_productivity` 与 `productivity` 分区保存 session、project 和长期记忆。
- DreamAgent memory：交互退出时把整理任务交给独立后台 worker，one-shot 完成后直接运行；
  本地 Sentence Transformer gate 会先筛掉明确只有寒暄或确认的会话；其余内容才交给
  DreamAgent。DreamAgent 只读取 Hash 校验通过的 compact view，并更新项目长期记忆与全局人格倾向。
- global persona：根目录 `PERSONA.md` 在所有 project/space 间共享，只承载带 event evidence 的
  交流、表达、关系连续性和适应倾向，不承载项目事实、权限或规则。
- project-bound retrieval：主 Agent 可分别检索稳定长期记忆和历史讨论细节，不允许通过工具参数跨 project。
- local shell tool：提供 timeout、输出截断、默认工作目录和 audit log。
- skills loading：Deep Agents 从 `skills/` 加载本地 skill；当前包含 `demo-production` 和 `agent-browser`。
- runtime state：`data/runtime.json` 缺失时会自动生成默认状态。

## 项目结构

```text
Cleo-AI-agent/
  AGENTS.md                       # Human-approved repository instructions
  PERSONA.md                      # Global descriptive persona projection
  main.py                         # Backward-compatible CLI launcher
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Python 3.12/Linux container dependency lock
  scripts/
    build-release.ps1             # Clean cross-stack Windows release builder
    download.ps1                  # Verified Windows desktop downloader/updater
    uninstall.ps1                 # Remove desktop program files
  release/                        # Generated Windows app, ZIP, checksum, and manifest
  ui/                             # Standalone Electron/React desktop client
  cleo/                           # Python backend application package
    agents/
      cleo.py                     # Foreground Cleo agent
      dream.py                    # Memory-consolidation DreamAgent
      tools/                      # Agent-owned shell, memory, and Codex tools
    cli/
      application.py              # Argument parsing and top-level dispatch
      chat.py                     # Interactive Cleo chat flow
      chat_tui.py                 # Full-screen Textual Cleo chat workspace
      productivity.py             # Harness startup and backend lifecycle bridge
      productivity_tui.py         # Full-screen Textual productivity workspace
      dream_worker.py             # Detached sequential DreamAgent consolidation worker
      lifecycle.py                # Session persistence and consolidation lifecycle
      console.py                  # Compact Rich one-shot presentation
      productivity_renderer.py    # Shared harness event and usage projection
      context.py                  # Shared terminal context
      workspace.py                # Explicit workspace reset operation
    config/
      settings.py                 # Pydantic settings loader and profile models
      templates/                  # Packaged Cleo and harness config templates
    desktop/
      server.py                   # Electron JSONL stdio protocol boundary
      service.py                  # Desktop use cases backed by core services
      projection.py               # Canonical backend events to UI data
      configuration.py            # Local model profile reads and atomic writes
    images/
      startup.py                  # Terminal startup image selection
      portrait.py                 # Rich pixel-art fallback
      sixel_encoder.py            # Transparent Sixel encoder
      assets/                     # Packaged startup image
    harnesses/                    # Provider-neutral harness API and adapter
    integrations/
      git.py                      # Read-only Git integration
      codex.py                    # Backward-compatible Codex facade
      harnesses/                  # Codex, Claude, and ACP provider implementations
    mcp/codex_server.py           # Stdio MCP process entry point
    memory/                       # Compaction, durable memory, evidence, and paths
    sessions/
      hub.py                      # Managed/native session aggregation
      store.py                    # Manifests, JSONL events, and session registry
    runtime/
      state.py                    # data/runtime.json read/write model
      usage.py                    # Shared context-window usage state
  config/                         # Local private configs, ignored by Git
  tests/                          # Tests mirror cleo/ responsibility domains
  skills/
    demo-production/              # Currently available skill
    demo-production/agents/       # Skill-local agent config
  memory/
    MEMORY_POLICY.md              # Developer-owned memory extraction policy
    persona.sqlite3               # Global persona traits and private evidence
    sessions.sqlite3              # Global rebuildable session metadata index
    non_productivity/projects/    # Personal/general sessions and memory
    productivity/projects/        # Harness sessions and project memory
  data/
    .gitkeep
    runtime_example.json          # Reference runtime state template
    runtime.json                  # Runtime generated local state, ignored by Git
    shell_audit.log               # Runtime generated shell tool audit log
  workspace/                      # Optional local workspace inputs/outputs
  docs/
    README.md                     # Documentation index
    ARCHITECTURE.md
    ARCHITECTURE.en.md
    BACKEND_CODE_REVIEW.md        # Offline backend review route
    CASTMIND_MEMORY_MIGRATION.md
```

`config/cleo.json`、`data/runtime.json`、`data/shell_audit.log`、
`memory/sessions.sqlite3`、`memory/persona.sqlite3`、`memory/non_productivity/` 和
`memory/productivity/` 都属于
本地配置或运行状态，不应提交到 Git。

`AGENTS.md` 是由用户或团队明确维护、自动载入前台 Cleo 的长期规范；根目录
`PERSONA.md` 是 DreamAgent 维护的全局描述性人格投影；`memory/MEMORY_POLICY.md`
是开发者拥有的记忆提取策略；
`memory/<space>/projects/<project>/MEMORY.md` 是 project-bound 派生记忆。自动记忆不会修改
`AGENTS.md`，人格也不能授予权限、定义工具规则或自动创建/更新 skill。
`PERSONA.md` 是由 `memory/persona.sqlite3` 重建的投影，启动和人格整理时会重新渲染，
不应把只存在于手工编辑中的内容放进该文件。

准备熟悉后端时，直接从
[`docs/BACKEND_CODE_REVIEW.md`](docs/BACKEND_CODE_REVIEW.md) 开始；它提供无需网络的
90 分钟快速路线、完整阅读顺序、核心数据流、测试映射和 finding 记录模板。

## 启动立绘

启动画面只依赖一张 PNG。源码运行时直接替换
`cleo/images/assets/cleo-startup.png` 即可；独立安装版替换
`%LOCALAPPDATA%\Cleo\assets\startup.png`。安装包只会在该文件缺失时复制默认图片，
不会覆盖已经替换的立绘。

图片尺寸和宽高比不限，渲染时会保持比例并适配终端。推荐使用带透明背景的 RGBA PNG；
程序会自动裁掉透明留白与相对主体极小的孤立标记。完全不透明的 PNG 会显示整个画布。
也可以使用 `CLEO_STARTUP_IMAGE_PATH` 指向任意 PNG：

```powershell
$env:CLEO_STARTUP_IMAGE_PATH = "D:\portraits\cleo.png"
cleo
```

Compose 默认把源码 PNG 挂载到容器中；可用 `CLEO_STARTUP_IMAGE_FILE` 指定另一张宿主机
图片。Sixel、Kitty graphics 和字符画 fallback 都读取同一张 PNG，因此不需要重新生成
Python 文件。

## 安装

Windows 用户只需下载预构建桌面包，不需要在目标机器安装 Python、Node.js 或 npm。
下载器会获取 ZIP 与 SHA256，校验通过后再原子替换程序目录：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\download.ps1 -Launch
```

下载过程中会自动重试临时网络错误，并在同一次运行中续传未完成的 ZIP。安装完成后窗口会显示
实际版本与安装位置，并等待按 Enter 关闭；脚本化调用可传入 `-NoPause`。

安装当前仓库刚构建的完整桌面包：

```powershell
.\scripts\download.ps1 -PackagePath .\release\Cleo-windows-x64.zip -Launch
```

安装后的桌面应用会在启动时自动检查 GitHub Release；有新版本时可在提示条或“设置 → 更新”
中下载，SHA-256 校验通过后重启安装。也可以重复运行同一命令手动更新。程序文件位于
`%LOCALAPPDATA%\Programs\Cleo`；配置、会话、
记忆、模型缓存和工作状态位于 `%LOCALAPPDATA%\Cleo`，程序替换不会覆盖这些数据。首次启动
会从旧的 `%APPDATA%\Cleo` 复制并合并已有配置，程序替换不会覆盖这些数据。Codex 登录和
task 历史仍由 `%USERPROFILE%\.codex` 管理。下载器安装的是包含 UI 与内置 Python 后端的完整
桌面应用；`Cleo.exe` 安装到程序目录，不会留在 Windows“下载”文件夹。

桌面应用的“设置 → 模型”可以新增或更新模型 Profile：填写 provider、模型名称、API Key、
可选 Base URL 和上下文长度，并分别指定为 Cleo 或 DreamAgent 的当前模型。API Key 只写入
本机 Cleo 配置，后端读取接口只返回 `hasApiKey`，不会把密钥回传到界面。

卸载默认保留用户数据：

```powershell
.\scripts\uninstall.ps1
```

只有明确需要永久删除所有本地配置、会话和记忆时才使用：

```powershell
.\scripts\uninstall.ps1 -PurgeData
```

发布构建使用 `scripts/build-release.ps1`。该流程在仓库顶层隔离临时目录执行全新 `npm ci`，
通过 `uv` 下载独立 Python runtime 并从零安装 Cleo 依赖，然后生成可下载 ZIP、校验文件和
自动更新清单：

```powershell
cd ui
npm run package:portable
```

最终产物统一位于仓库顶层 `release/`；`ui/` 只保存桌面客户端源码和 renderer 测试，不承载
Python 后端或发布包。

源码开发建议使用 Python 3.12 或更高版本：

```bash
pip install -e .
```

开发依赖：

```bash
pip install -e ".[dev]"
```

源码运行时还需安装浏览器 runtime：

```bash
npm install -g agent-browser@0.33.1
```

使用 OpenCode harness 前，需要由用户单独安装 OpenCode CLI，并确保 `harnesses.json` 中配置的
`opencode` 命令位于 PATH。Cleo 桌面端会在选择该 harness 时检测 ACP 连接，但不会下载 CLI。

`agent-browser` 会优先使用本机 Chrome/Edge；桌面发布包已经携带 Node runtime 与固定版本的
`agent-browser`。Sentence Transformer 模型按配置下载到用户数据目录中的模型缓存；模型暂时
不可用时 gate 会 fail-open 到 DreamAgent。

`pyproject.toml` 是直接依赖的唯一手工维护入口。`requirements.txt` 是为 Linux
容器生成的精确版本锁文件，不应手工修改。

## 依赖更新与 Docker

Docker 不会取代依赖清单：`pyproject.toml` 描述项目依赖，`requirements.txt`
锁定实际安装版本，Docker 使用锁文件构建可重复的运行环境，并在 image build 阶段缓存
默认 Sentence Transformer。可用 `--build-arg CLEO_MEMORY_GATE_MODEL=<model>` 覆盖模型，
或用 `--build-arg CLEO_SKIP_MEMORY_MODEL_DOWNLOAD=1` 明确跳过。

一条命令重新解析依赖、更新 `requirements.txt` 并构建镜像：

```bash
python scripts/update_project.py
```

如果官方 PyPI 在当前网络下较慢，可以使用国内镜像，并保留官方源作为缺失的
Codex 预发布包回退：

```bash
python scripts/update_project.py --index-url https://pypi.tuna.tsinghua.edu.cn/simple --extra-index-url https://pypi.org/simple
```

只更新锁文件、不构建应用镜像：

```bash
python scripts/update_project.py --skip-build
```

Docker Desktop 暂时不可用但本机已安装 `uv` 时，可以仍按 Python 3.12/Linux
目标生成锁文件：

```bash
python scripts/update_project.py --local-resolver --skip-build
```

本地构建完成后，Compose 直接挂载现有的 `config/cleo.json`，不需要另一份
Docker 专用配置：

```bash
docker compose run --rm cleo
docker compose run --rm cleo "介绍一下当前项目"
```

同一个 `cleo.json` 可用于 Windows 本地运行和 Linux Docker。Cleo 会根据当前平台
自动加入合适的 shell 命令；需要完全自定义 allowlist 时，可设置
`include_platform_defaults: false`。

发布到 Docker Hub 或 GHCR 后，用户不需要克隆 GitHub。可以直接从 image 输出
配置模板（将 `<image>` 替换成真实镜像名）：

```powershell
cmd /c "docker run --rm <image> --print-config-template > cleo.json"
cmd /c "docker run --rm <image> --print-harnesses-template > harnesses.json"
notepad cleo.json
```

填写模型信息和 API key 后运行：

```powershell
docker run --rm -it `
  --mount "type=bind,source=$($PWD.Path)\cleo.json,target=/config/cleo.json,readonly" `
  --mount "type=bind,source=$($PWD.Path)\harnesses.json,target=/config/harnesses.json,readonly" `
  --mount "type=volume,source=cleo-data,target=/app/data" `
  --mount "type=volume,source=cleo-memory,target=/app/memory" `
  --mount "type=volume,source=cleo-workspace,target=/app/workspace" `
  --mount "type=volume,source=cleo-codex-home,target=/home/cleo/.codex" `
  <image>
```

这个直接运行示例通过 named volumes 持久化 `data/`、`memory/`、`workspace/`
和 Codex 登录状态；使用项目内的 Compose 时，`workspace/` 默认绑定到宿主机目录。
镜像不开放网络端口，因为 Cleo 和 MCP 当前都是 CLI/stdio 进程。

## 本地配置

Cleo 不再使用 `.env` 作为配置来源。本地默认读取 `config/cleo.json`；容器通过
`CLEO_CONFIG_PATH=/config/cleo.json` 读取用户挂载的同一格式配置。Productivity harness
独立读取 `config/harnesses.json`，容器路径可通过 `CLEO_HARNESSES_CONFIG_PATH` 指定。

首次运行前可以手动复制模板：

```bash
copy cleo\config\templates\cleo.example.json config\cleo.json
copy cleo\config\templates\harnesses.example.json config\harnesses.json
```

也可以直接运行 Cleo。如果 `config/cleo.json` 缺失，Cleo 会自动创建默认模板并提示你填写真实配置。

`config/cleo.json` 使用一个 JSON 文件管理多个 profile registry：

```json
{
	"active_profiles": {
		"agent": "moonshot_openai_compatible",
		"dream_agent": "moonshot_openai_compatible",
		"directory": "default",
		"shell": "default",
		"tools": "default"
	},
	"profiles": {
		"agents": {
			"moonshot_openai_compatible": {
				"provider": "openai",
				"model": "kimi-k2.6",
				"temperature": 0.7,
				"max_tokens": 100000,
				"api_key": "YOUR_API_KEY",
				"base_url": "https://api.moonshot.cn/v1"
			}
		},
		"directories": {
			"default": {
				"root_dir": ".",
				"data_dir": "data",
				"skills_dir": "skills",
				"workspace_dir": "workspace",
				"memory_dir": "memory",
				"memory_policy_path": "memory/MEMORY_POLICY.md",
				"persona_path": "PERSONA.md",
				"session_index_path": "memory/sessions.sqlite3",
				"session_artifacts_dir": "data/session_artifacts",
				"runtime_state_path": "data/runtime.json"
			}
		},
		"shell": {
			"default": {
				"sandbox_root": ".",
				"audit_log_path": "data/shell_audit.log",
				"require_allowlist": false,
				"enforce_sandbox": false,
				"require_approval": false,
				"timeout_seconds": 30,
				"max_output_chars": 12000,
				"allowed_commands": ["python", "git"],
				"include_platform_defaults": true,
				"denied_patterns": []
			}
		},
		"tools": {
			"default": {
				"tavily_api_key": null,
				"codex_model": "gpt-5.5",
				"browser": {
					"enabled": true,
					"command": "agent-browser",
					"headless": true,
					"allow_private_network": false,
					"allowed_domains": [],
					"timeout_seconds": 45,
					"operation_timeout_ms": 25000,
					"idle_timeout_seconds": 900,
					"max_output_chars": 12000
				}
			}
		}
	}
}
```

`active_profiles` 只保存当前选择的 profile 名称；`profiles` 保存所有候选 profile。
`agent` 服务前台 Cleo，`dream_agent` 为后台记忆整理独立选择 `profiles.agents` 中的
profile。旧配置省略 `dream_agent` 时会回退到 `agent`。代码通过 Pydantic 校验配置，
再通过 `settings.active_agent_profile`、`settings.active_dream_agent_profile`、
`settings.active_directory_profile`、`settings.active_shell_profile` 和
`settings.active_tools_profile` 取得当前生效配置。

`profiles.tools.<name>.browser` 控制 Cleo 的专用浏览器适配器。每个 Cleo thread 使用独立
的 `agent-browser` session；截图和被截断的完整结果写入
`data/session_artifacts/browser/`。显式打开或新建 tab 的目标默认只允许公网 HTTP(S)
地址，并拒绝 localhost、局域网、链路本地和云 metadata 地址。只有测试受信任的本地
站点时才应设置 `allow_private_network: true`；生产环境还可以用 `allowed_domains`
收紧域名范围。

`memory_gate` 在启动 DreamAgent 前懒加载本地 Sentence Transformer。只有所有用户消息都
明显更接近 transient prototypes 时才跳过；判断模糊、模型缺失或下载失败时会 fail-open，
继续运行 DreamAgent。正式安装与 Docker build 会预下载模型；仅跳过预下载或直接源码运行时，
首次使用才会下载到 Hugging Face 用户缓存。跳过的 source 记录为
`processed_hash`，不会伪装成已经写入项目记忆的 `consolidated_hash`。完整参数见
`cleo/config/templates/cleo.example.json`。

Productivity harness 由独立的 `config/harnesses.json` 注册。`default_provider` 决定未传
`--provider` 时使用哪个 harness；`providers` 中的 key 是写入 session metadata 的
provider 名称。所有 provider 共用 `type`、`enabled`、`model` 外壳，原生差异放在
`options` 中。例如：

```json
{
	"default_provider": "codex",
	"providers": {
		"codex": {
			"type": "codex_sdk",
			"enabled": true,
			"model": "gpt-5.5",
			"options": {
				"approval_mode": "deny_all",
				"sandbox": "workspace-write"
			}
		}
	}
}
```

`--model` 仍可覆盖当前 provider 的配置模型。`profiles.tools.codex_model` 单独服务于
Cleo 主聊天中的 `codex` 工具，不再作为所有 productivity provider 的通用默认值。

## 运行

一次性消息：

```bash
cleo "介绍一下当前 Cleo 项目能做什么。"
```

把 thread 和两种记忆检索工具绑定到指定 project：

```bash
cleo --project cleo "回顾我们之前为什么这样设计记忆系统。"
```

或：

```bash
python main.py "介绍一下当前 Cleo 项目能做什么。"
```

交互式聊天：

```bash
cleo
```

或：

```bash
python main.py
```

交互式命令：

- `/quit` 或 `/exit`：立即关闭 Textual、清空界面并把控制权交还命令行；已完成的每轮对话
  已经持久化，只有包含用户消息的 session 才会在界面退出后启动后台 DreamAgent 整理。
- `/new`：完成当前 session 并开启新 thread。
- `/project`：打开 Cleo 记忆项目选择器；点击已有项目，或输入名称创建项目。
- `/project <name>`：创建或切换 Cleo project，并在该记忆边界中开启新 thread。
- `/project move <name>`：把尚未经过 DreamAgent consolidation 的当前 thread 连同上下文迁移到目标 project。
- `/rename <title>`：修改当前 Cleo thread 的标题。
- `/resume <session-id>`：恢复一个已保存的 Cleo thread；也可用 `/sessions` 点击恢复。
- `/productivity`：进入 Codex productivity 页面；在其中用 `/back` 或 `/quit` 返回主聊天。
- `/sessions`：打开 Cleo 会话选择器并点击恢复；Productivity 中的 `/sessions` 单独管理代码会话。
- `/attach`：为下一条消息附加图片文件。

输入 `/` 可使用命令建议；常用操作也可以直接点击右侧快捷按钮。

Thread 会使用第一条用户消息自动生成标题；Cleo thread 可用 `/rename` 修改，
productivity thread 则继续通过 harness 的 `/rename` 能力同步标题。标题只属于 metadata，
修改标题不会触发 compact 或 DreamAgent。

Cleo 状态栏显示当前模型和 context window；它使用 active agent profile 的 `max_tokens`
作为配置上限，并在兼容服务返回 usage metadata 后显示本轮实际占用。Productivity 状态栏
优先显示 Codex 账户的剩余 5 小时与每周用量及重置时间；SDK 尚未返回限额时才回退到
context usage，并显示 `waiting` 而不是估算数据。侧栏显示 reasoning effort、filesystem
access、approval behavior，以及当前 Git branch 和 dirty count。

交互模式同样可用 `cleo --project <name>` 启动。Cleo project 是逻辑记忆边界，不要求
对应一个代码仓库；不需要分类时继续使用默认的 `general` 即可。`/new` 会在同一 project
内创建新 thread；`--resume` 会恢复 manifest 中保存的 space/project 绑定，并拒绝冲突
的 `--project` 参数。

活跃 thread 可通过 `/project move <name>` 保留上下文迁移。已完成 DreamAgent
consolidation 的 thread 不允许直接迁移，因为其长期记忆可能已经写入原 project；此时应
切换 project 并创建新 thread。

主聊天中推荐直接输入 `/productivity`。也可以从命令行直接启动 Codex productivity
模式：

```bash
# 进入连续交互；工作目录就是 Productivity 的项目身份
python main.py --productivity --cwd .

# 单次任务
python main.py --productivity --cwd . "检查当前改动并运行测试"

# 使用 Cleo session id 恢复对应的 Codex native session
python main.py --productivity --resume agent_xxx
```

可用 `--model` 覆盖 harness 配置的模型。productivity 交互支持：

- `/project`：像 Codex 一样把项目视为工作目录；点击最近目录，或输入任意现有目录。
  Cleo 的记忆项目不会混入这里；`/cwd`、`/git` 查看当前目录与 Git 状态。
- `/cd <directory>`：切换目录并创建新的 harness session；相对路径以当前 `cwd` 为准。
- `/resume <agent-id>`：恢复已保存的 productivity session、原生 harness 上下文与历史 transcript。
- `/sessions`：在弹窗中合并展示 Cleo-managed session 与 Codex native thread；点击后读取原生
  Codex turns（不可用时回退到 Cleo event log），恢复历史内容，并连接同一个 native thread
  继续对话。纯 Codex native thread 会在首次恢复时自动建立 Cleo-managed session 映射。
- `/native <native-id>`：只读查看 Codex 原生历史，不导入 Cleo 记忆。
- `/resume-native <native-id>`：恢复原生历史，把该 thread 接入 Cleo，并从原上下文继续对话。
- `/model`、`/effort`、`/access`、`/approval`：查看或修改下一轮 Codex 的运行参数。
- `/fork`、`/rename <name>`、`/compact`、`/archive`：管理 Codex 原生 thread 生命周期。
- `/account`：查看当前 Codex 登录状态。
- `/new`、`/back`、`/quit` 和 `/exit`：管理 session 或离开页面。

Codex SDK 的消息、工具、终端、计划和文件变更事件会流式显示，并统一写入
`productivity` space。两种交互界面分别位于 `cleo/cli/chat_tui.py` 与
`cleo/cli/productivity_tui.py`，一次性输出保留在 `cleo/cli/console.py`；它们与 runtime、
memory、session 聚合和 provider 实现保持独立。
Codex 专属控制能力留在 Codex provider；通用 adapter
仍维持 create/resume/prompt/cancel/close 数据面。

## 运行时文件

这些文件由代码在运行时维护：

- `data/runtime.json`：当前 space/project/thread，以及按 space 分区的 recent threads。
- `data/shell_audit.log`：local shell tool 调用审计。
- `memory/sessions.sqlite3`：全局可重建 session metadata registry。
- `memory/persona.sqlite3`：跨 project/space 的人格 trait 与私有 event evidence。
- `memory/<space>/projects/<project>/sessions/<session>/manifest.json`：当前 session 投影。
- `memory/<space>/projects/<project>/sessions/<session>/events.jsonl`：append-only 原始证据。
- `memory/<space>/projects/<project>/sessions/<session>/compact.json`：脱敏 compact 投影。
- `memory/<space>/memory.sqlite3`：原子长期记忆、event evidence 和 conversation chunks。
- `memory/<space>/memory_state.json`：source version、processed/consolidated Hash、gate 结果与 Dream 状态。
- `memory/<space>/projects/<project>/MEMORY.md`：DreamAgent 生成的长期记忆。
- `PERSONA.md`：由全局 persona evidence 渲染、自动载入前台 Cleo 的描述性人格。

`Runtime` 只保存当前 CLI 状态。append-only event log 是权威交互记录，manifest 是
当前 metadata；compact、SQLite 索引和项目 `MEMORY.md` 都是可重建的派生层。迁移复盘与取舍见
[`docs/CASTMIND_MEMORY_MIGRATION.md`](docs/CASTMIND_MEMORY_MIGRATION.md)。

## 当前限制

- 原生历史目前按页读取最近 50 条；尚未在 CLI 中暴露继续翻页与复杂筛选。
- 当前 resume 是 session message event replay，不是完整 durable LangGraph checkpoint。
- 历史检索当前使用本地词法排序；尚未启用需要校准和额外服务的向量检索。
- `skills/` 当前包含 `demo-production` 和 `agent-browser`。
