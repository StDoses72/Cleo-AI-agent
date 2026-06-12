# Cleo AI Agent

English version: [README.en.md](README.en.md)

Cleo AI Agent 是一个本地个人 AI agent runtime，基于 Deep Agents 和 LangChain
构建。它面向本地项目工作流：可以通过 one-shot message 或 interactive chat 使用，
加载本地 skills，读取和写入项目工作区，保存 thread snapshot，并通过 DreamAgent
把短期对话整理为长期项目记忆。

本文只描述当前仓库已经存在的能力，不把未来计划写成已完成能力。

## 当前能力

- `main.py` 提供 one-shot message 和 interactive chat 两种入口。
- 主路径使用 Deep Agents runtime、LangChain 模型初始化和 Deep Agents filesystem backend。
- `/attach` 支持为下一条消息附加图片文件，支持 JPEG、PNG、WebP 和 GIF。
- 退出、重置、中断或 one-shot 完成时会保存 thread snapshot。
- DreamAgent 可以读取 thread snapshot，并把长期项目信息写入 `memory/projects/<project>/`。
- `tools/shell_tools.py` 提供 restricted shell tool，并写入 shell audit log。
- `skills/` 是 Deep Agents skills loading 目录，当前 tracked skill 是 `demo-production`。

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
  memory/
    AGENT.md                      # Global memory policy
    thread_objects/               # Runtime generated thread message snapshots
    threads.jsonl                 # Runtime generated thread snapshot registry
    projects/                     # Runtime generated long-term project memory
  data/
    runtime_example.json          # Runtime state template
    runtime.json                  # Local runtime state, ignored by Git
    shell_audit.log               # Runtime generated shell tool audit log
  workspace/                      # Workspace input files
```

`workspace/` 下的文件按用户输入或迁移验证文件处理，不代表 Cleo 当前项目身份。

## 安装

建议使用 Python 3.12 或更高版本。

```bash
pip install -e .
```

开发依赖：

```bash
pip install -e ".[dev]"
```

`requirements.txt` 只是兼容入口，推荐优先使用 `pyproject.toml` 管理依赖。

## 本地配置

首次运行前需要准备本地配置文件：

1. 从 `config/cleo.example.json` 复制 `config/cleo.json`，填入真实模型 profile、API key、active profile、shell profile 和 directory profile。

`config/cleo.json` 是本地私密文件，不应提交。`data/runtime.json` 会在首次初始化 Runtime 时自动生成。

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
		}
	}
}
```

如果 `config/cleo.json` 缺失，Cleo 会自动创建默认模板并提示你填写。

## 运行

安装后推荐使用 `cleo`：

```bash
cleo "介绍一下当前 Cleo 项目能做什么。"
```

也可以直接运行：

```bash
python main.py "介绍一下当前 Cleo 项目能做什么。"
```

进入 interactive chat：

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

- `data/runtime.json`：当前 project、当前 thread、recent threads。
- `data/shell_audit.log`：restricted shell tool 调用审计。
- `memory/thread_objects/{thread_id}.json`：thread message snapshot。
- `memory/threads.jsonl`：thread snapshot metadata registry。
- `memory/projects/<project>/AGENT.md`：DreamAgent 生成的项目长期记忆。

这些路径大多已被 `.gitignore` 忽略。它们属于本地状态，不是源代码资产。
