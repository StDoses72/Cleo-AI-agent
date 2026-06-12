# Cleo AI Agent

English version: [README.en.md](README.en.md)

Cleo AI Agent 是一个 local-first 的个人 AI agent runtime，基于 Deep Agents 和
LangChain 构建，通过 API 调用语言模型。Cleo 把配置、会话状态、thread snapshot、
项目记忆、工作区文件和受限 shell 工具都放在本地管理；模型推理由你在
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
- DreamAgent memory：正常退出或 one-shot 完成后，DreamAgent 可把 thread snapshot 整理为项目长期记忆。
- restricted shell tool：提供 allowlist、denylist、sandbox root、timeout 和 audit log。
- skills loading：Deep Agents 从 `skills/` 加载本地 skill，当前 tracked skill 是 `demo-production`。
- runtime state：`data/runtime.json` 缺失时会自动生成默认状态。

## 项目结构

```text
Cleo-AI-agent/
  main.py                         # CLI entry point
  pyproject.toml                  # Python project metadata and dependencies
  requirements.txt                # Compatibility wrapper that delegates to -e .
  config/
    settings.py                   # Pydantic settings loader and profile models
    cleo.example.json             # Local config template
    cleo.json                     # Local private config, ignored by Git
  core/
    agent.py                      # Cleo / DreamAgent construction
    memory/thread_memory.py       # Thread snapshot serialization
    runtime/model.py              # data/runtime.json read/write model
  tools/
    shell_tools.py                # Restricted shell tool
    dream_agent_tools.py          # DreamAgent memory tools
  skills/
    demo-production/              # Currently available skill
    demo-production/agents/       # Skill-local agent config
  memory/
    AGENT.md                      # Global memory policy
    thread_objects/               # Runtime generated thread message snapshots
    threads.jsonl                 # Runtime generated thread snapshot registry
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
```

`config/cleo.json`、`data/runtime.json`、`data/shell_audit.log`、
`memory/thread_objects/`、`memory/threads.jsonl` 和 `memory/projects/` 都属于本地
配置或运行状态，不应提交到 Git。

## 安装

建议使用 Python 3.12 或更高版本。

```bash
pip install -e .
```

开发依赖：

```bash
pip install -e ".[dev]"
```

`requirements.txt` 只是兼容旧安装说明的入口，推荐优先使用 `pyproject.toml` 管理依赖。

## 本地配置

Cleo 不再使用 `.env` 作为配置来源。当前配置入口是 `config/cleo.json`。

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
				"memory_agent_path": "memory/AGENT.md",
				"memory_projects_dir": "memory/projects",
				"thread_objects_dir": "memory/thread_objects",
				"thread_registry_path": "memory/threads.jsonl",
				"runtime_state_path": "data/runtime.json"
			}
		},
		"shell": {
			"default": {
				"sandbox_root": ".",
				"audit_log_path": "data/shell_audit.log",
				"require_allowlist": true,
				"enforce_sandbox": true,
				"require_approval": false,
				"timeout_seconds": 30,
				"max_output_chars": 12000,
				"allowed_commands": ["python", "python.exe", "py", "py.exe"],
				"denied_patterns": ["&&", "||", ";", "|", ">", "<", "`", "$(", "../", "..\\"]
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
- `/reset`：保存当前 thread snapshot 并开启新 thread。
- `/attach`：为下一条消息附加图片文件。

## 运行时文件

这些文件由代码在运行时维护：

- `data/runtime.json`：当前 project、当前 thread、recent threads。缺失时会自动生成。
- `data/shell_audit.log`：restricted shell tool 调用审计。
- `memory/thread_objects/{thread_id}.json`：thread message snapshot。
- `memory/threads.jsonl`：thread snapshot metadata registry。
- `memory/projects/<project>/AGENT.md`：DreamAgent 生成的项目长期记忆。

`Runtime` 只保存当前状态和索引；真正的对话内容保存在 thread snapshot 中。

## 当前限制

- 目前还没有 `/threads` 或 `/switch <thread_id>` 这种自由切换历史 thread 的交互命令。
- 当前 resume 是 message snapshot replay，不是完整 durable LangGraph checkpoint。
- `SHELL_REQUIRE_APPROVAL=True` 的完整 interrupt/resume 交互还没有在 CLI 中实现。
- `skills/` 当前只包含 `demo-production`。
