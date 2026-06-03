# Cleo AI Agent

English version: [README.en.md](README.en.md)

Cleo 是一个迁移中的本地个人 AI agent 项目。当前仓库保留了原项目的部分
`ai4casting` 包名和 CLI 入口作为兼容层，但项目形态已经转向一个更通用的
Deep Agents 本地运行时：它可以加载本地技能、读写项目工作区、保存会话快照，
并通过 DreamAgent 把短期对话整理成长期项目记忆。

本 README 只描述当前仓库中已经落地的结构，不把迁移前原型或未来规划写成已完成能力。

## 当前状态

已经落地：

- `main.py` 提供一次性消息和交互式聊天入口。
- `core/agent.py` 创建主 Cleo agent 和后台 DreamAgent。
- `config/settings.py` 管理本地路径、shell 工具策略、运行目录和环境变量。
- `core/runtime/model.py` 维护 `data/runtime.json` 里的 CLI 运行状态。
- `core/memory/thread_memory.py` 保存和恢复 thread message snapshot。
- `tools/shell_tools.py` 提供受限 shell 工具，并写入审计日志。
- `tools/dream_agent_tools.py` 提供 DreamAgent 读取短期记忆、写入项目记忆的工具。
- `skills/demo-production/` 是当前仓库实际存在的技能目录。

迁移中或尚未落地：

- README 旧版提到的 casting workflow 技能目录目前不在当前 tracked 文件中。
- thread resume 已有基础实现：启动时可检测未结束的 `current_thread_id` 并加载消息快照，
  但底层 LangGraph checkpointer 仍是进程内存型。
- 初始化流程仍需要手动复制模板文件，尚未实现 `init`/`doctor` 命令。

## 项目结构

```text
Cleo-AI-agent/
  main.py                         # CLI 入口
  pyproject.toml                  # Python 项目元数据和依赖
  requirements.txt                # 兼容旧安装方式，委托到 -e .
  .env.example                    # 本地环境变量模板
  config/
    settings.py                   # 路径、环境变量、shell 策略配置
    cleo.example.json             # 模型 profile 模板
    cleo.json                     # 本地私密 profile，忽略入库
  core/
    agent.py                      # Cleo / DreamAgent 构建逻辑
    memory/thread_memory.py       # 会话快照序列化
    runtime/model.py              # data/runtime.json 读写
  tools/
    shell_tools.py                # 受限 shell tool
    dream_agent_tools.py          # DreamAgent memory tools
  skills/
    demo-production/              # 当前实际存在的技能
  memory/
    AGENT.md                      # 全局记忆策略
    thread_objects/               # 运行生成：thread message snapshots
    threads.jsonl                 # 运行生成：thread snapshot registry
    projects/                     # 运行生成：长期项目记忆
  data/
    runtime_example.json          # runtime 状态模板
    runtime.json                  # 本地运行状态，忽略入库
    shell_audit.log               # 运行生成：shell tool 审计日志
  workspace/
    product.stl                   # 当前工作区输入文件
    双联屏-DieCasting_DFM_EON-2020.9.03.pptx
```

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

当前启动前需要准备三个本地文件：

1. 从 `.env.example` 复制 `.env`，按需调整 shell 工具配置。
2. 从 `config/cleo.example.json` 复制 `config/cleo.json`，填写真实模型 profile 和 API key。
3. 从 `data/runtime_example.json` 复制 `data/runtime.json`，作为首次运行状态。

这些文件中，`.env`、`config/cleo.json` 和 `data/runtime.json` 都是本地文件，不应提交到 Git。

最小 profile 示例：

```json
{
  "active_profiles": "moonshot_openai_compatible",
  "profiles": {
    "moonshot_openai_compatible": {
      "provider": "openai",
      "model": "kimi-k2.6",
      "temperature": 0.7,
      "api_key": "YOUR_API_KEY",
      "base_url": "https://api.moonshot.cn/v1"
    }
  }
}
```

## 运行

一次性消息：

```bash
python main.py "介绍一下当前 Cleo 项目能做什么。"
```

交互式聊天：

```bash
python main.py
```

交互式命令：

- `/quit` 或 `/exit`：保存当前 thread 快照，运行 DreamAgent 记忆整理，然后退出。
- `/reset`：保存当前 thread 快照并开启新 thread。
- `/attach`：为下一条消息附加图片文件，目前支持 JPEG、PNG、WebP 和 GIF。

## 运行时文件

这些文件由代码在运行时维护：

- `data/runtime.json`：当前 project、当前 thread、最近 thread 列表。
- `data/shell_audit.log`：受限 shell 工具调用审计。
- `memory/thread_objects/{thread_id}.json`：thread message snapshot。
- `memory/threads.jsonl`：thread snapshot 元数据 registry。
- `memory/projects/<project>/AGENT.md`：DreamAgent 生成的项目长期记忆。

这些路径大多已被 `.gitignore` 忽略。它们属于本地状态，不是源代码资产。

## 手动配置与可自动化项

当前仍需手动完成：

- 复制 `.env.example` 到 `.env`。
- 复制 `config/cleo.example.json` 到 `config/cleo.json` 并填写密钥。
- 复制 `data/runtime_example.json` 到 `data/runtime.json`。
- 创建或整理工作区输入文件。
- 维护技能目录和技能说明。

建议下一步自动化：

- 增加 `cleo init` 或 `python main.py --init`，自动创建缺失模板文件和目录。
- 增加 `cleo doctor`，检查配置文件、profile、API key 占位符、runtime JSON 和运行目录。
- 在 `Runtime` 初始化中，当 `data/runtime.json` 缺失时自动从默认结构创建，而不是直接失败。
- 在 `Agent` 初始化中，对 `config/cleo.json` 缺失或占位符密钥给出清晰错误。

## 迁移说明

仓库中的包名、console script 和部分历史文档仍保留 `ai4casting` 命名，这是迁移兼容遗留。
当前项目应按 Cleo local agent runtime 理解；casting 相关能力应作为后续技能迁移进入
`skills/`，而不是默认假设已经存在。
