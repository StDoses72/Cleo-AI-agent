# Cleo AI Agent

English version: [README.en.md](README.en.md)

Cleo AI Agent 是一个 local-first 的个人 AI agent runtime，基于 Deep Agents 和
LangChain 构建，通过 API 调用语言模型。Cleo 把配置、会话状态、thread snapshot、
项目记忆、工作区文件和local shell 工具都放在本地管理；模型推理由你在
`config/cleo.json` 中配置的 API provider 提供。

本文只描述当前仓库已经存在的能力，不把未来计划写成已完成能力。

## 当前能力

- one-shot message：通过 `cleo "..."` 或 `python main.py "..."` 发送一次性消息。
- interactive chat：直接运行 `cleo` 或 `python main.py` 进入交互式聊天。
- API-backed model profile：使用 `config/cleo.json` 中的 active agent profile 初始化 LangChain 模型。
- Pydantic settings：`config/settings.py` 用 Pydantic 校验 agent、directory、shell、tools 四类 profile。
- image attach：交互中使用 `/attach` 为下一条消息附加图片，支持 JPEG、PNG、WebP 和 GIF。
- thread snapshot：退出、重置、中断或 one-shot 完成时保存 `memory/thread_objects/{thread_id}.json`。
- resume：启动时如果存在未结束的 `current_thread_id`，会询问是否恢复该 thread。
- layered memory：原始 thread snapshot 派生出脱敏 compact view、SQLite 历史 chunks 和带 message evidence 的原子长期记忆。
- DreamAgent memory：正常退出或 one-shot 完成后，DreamAgent 只读取 Hash 校验通过的 compact view，并更新项目长期记忆。
- project-bound retrieval：主 Agent 可分别检索稳定长期记忆和历史讨论细节，不允许通过工具参数跨 project。
- local shell tool：提供 timeout、输出截断、默认工作目录和 audit log。
- skills loading：Deep Agents 从 `skills/` 加载本地 skill，当前 tracked skill 是 `demo-production`。
- runtime state：`data/runtime.json` 缺失时会自动生成默认状态。

## 项目结构

```text
Cleo-AI-agent/
  AGENTS.md                       # Human-approved repository instructions
  main.py                         # CLI entry point
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Compatibility wrapper that delegates to -e .
  config/
    settings.py                   # Pydantic settings loader and profile models
    cleo.example.json             # Local config template
    cleo.json                     # Local private config, ignored by Git
  core/
    agent.py                      # Cleo / DreamAgent construction
    memory/compaction.py          # Deterministic compact/redacted thread view
    memory/state.py               # Memory source version and completion state
    memory/store.py               # SQLite memory, evidence, and history chunks
    memory/thread_memory.py       # Thread snapshot serialization
    runtime/model.py              # data/runtime.json read/write model
  tools/
    shell_tools.py                # Local shell tool
    dream_agent_tools.py          # DreamAgent memory tools
    memory_tools.py               # Project-bound retrieval tools
  skills/
    demo-production/              # Currently available skill
    demo-production/agents/       # Skill-local agent config
  memory/
    MEMORY_POLICY.md              # Developer-owned memory extraction policy
    thread_objects/               # Runtime generated thread message snapshots
    compact_threads/              # Runtime generated compact/redacted snapshots
    threads.jsonl                 # Runtime generated thread snapshot registry
    memory.sqlite3                # Atomic memory, evidence, and history index
    memory_state.json             # Memory source/consolidation state
    projects/                     # Runtime generated long-term project memory
  data/
    .gitkeep
    runtime_example.json          # Reference runtime state template
    runtime.json                  # Runtime generated local state, ignored by Git
    shell_audit.log               # Runtime generated shell tool audit log
  workspace/                      # Optional local workspace inputs/outputs
  docs/
    ARCHITECTURE.md
    ARCHITECTURE.en.md
    CASTMIND_MEMORY_MIGRATION.md
```

`config/cleo.json`、`data/runtime.json`、`data/shell_audit.log`、
`memory/thread_objects/`、`memory/compact_threads/`、`memory/threads.jsonl`、
`memory/memory.sqlite3`、`memory/memory_state.json` 和 `memory/projects/` 都属于
本地配置或运行状态，不应提交到 Git。

`AGENTS.md` 是由用户或团队明确维护的仓库规范；`memory/MEMORY_POLICY.md` 是
开发者拥有的记忆提取策略；`memory/projects/<project>/MEMORY.md` 是 DreamAgent
生成的派生记忆。自动记忆不会修改 `AGENTS.md`，也不会自动创建或更新 skill。

## 安装

建议使用 Python 3.12 或更高版本。

```bash
pip install -e .
```

开发依赖：

```bash
pip install -e ".[dev]"
```

`pyproject.toml` 是直接依赖的唯一手工维护入口。`requirements.txt` 是为 Linux
容器生成的精确版本锁文件，不应手工修改。

## 依赖更新与 Docker

Docker 不会取代依赖清单：`pyproject.toml` 描述项目依赖，`requirements.txt`
锁定实际安装版本，Docker 使用锁文件构建可重复的运行环境。

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
notepad cleo.json
```

填写模型信息和 API key 后运行：

```powershell
docker run --rm -it `
  --mount "type=bind,source=$($PWD.Path)\cleo.json,target=/config/cleo.json,readonly" `
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
`CLEO_CONFIG_PATH=/config/cleo.json` 读取用户挂载的同一格式配置。

首次运行前可以手动复制模板：

```bash
copy config\cleo.example.json config\cleo.json
```

也可以直接运行 Cleo。如果 `config/cleo.json` 缺失，Cleo 会自动创建默认模板并提示你填写真实配置。

`config/cleo.json` 使用一个 JSON 文件管理多个 profile registry：

```json
{
	"active_profiles": {
		"agent": "moonshot_openai_compatible",
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
				"memory_projects_dir": "memory/projects",
				"thread_objects_dir": "memory/thread_objects",
				"compact_threads_dir": "memory/compact_threads",
				"thread_registry_path": "memory/threads.jsonl",
				"memory_database_path": "memory/memory.sqlite3",
				"memory_state_path": "memory/memory_state.json",
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
				"tavily_api_key": null
			}
		}
	}
}
```

`active_profiles` 只保存当前选择的 profile 名称；`profiles` 保存所有候选 profile。
代码通过 Pydantic 校验配置，再通过 `settings.active_agent_profile`、
`settings.active_directory_profile`、`settings.active_shell_profile` 和
`settings.active_tools_profile` 取得当前生效配置。

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

- `/quit` 或 `/exit`：保存当前 thread snapshot，运行 DreamAgent 记忆整理，然后退出。
- `/new`：保存当前 thread snapshot 并开启新 thread。
- `/attach`：为下一条消息附加图片文件。

交互模式同样可用 `cleo --project <name>` 启动。`/new` 会在同一 project 内创建新
thread；`--resume` 会恢复 snapshot 中保存的 project 绑定，并拒绝冲突的
`--project` 参数。

## 运行时文件

这些文件由代码在运行时维护：

- `data/runtime.json`：当前 project、当前 thread、recent threads。缺失时会自动生成。
- `data/shell_audit.log`：local shell tool 调用审计。
- `memory/thread_objects/{thread_id}.json`：thread message snapshot。
- `memory/compact_threads/{thread_id}.json`：确定性压缩、脱敏并带 source Hash 的记忆输入。
- `memory/threads.jsonl`：thread snapshot metadata registry。
- `memory/memory.sqlite3`：原子长期记忆、message evidence 和历史 conversation chunks。
- `memory/memory_state.json`：source version、Hash、Dream 完成状态和失败信息。
- `memory/projects/<project>/MEMORY.md`：DreamAgent 生成的项目长期记忆。

`Runtime` 只保存当前 CLI 状态。原始 thread snapshot 是对话的权威记录；compact、
SQLite 索引和项目 `MEMORY.md` 都是可重建的派生层。迁移复盘与取舍见
[`docs/CASTMIND_MEMORY_MIGRATION.md`](docs/CASTMIND_MEMORY_MIGRATION.md)。

## 当前限制

- 目前还没有 `/threads` 或 `/switch <thread_id>` 这种自由切换历史 thread 的交互命令。
- 当前 resume 是 message snapshot replay，不是完整 durable LangGraph checkpoint。
- 历史检索当前使用本地词法排序；尚未启用需要校准和额外服务的向量检索。
- `skills/` 当前只包含 `demo-production`。
