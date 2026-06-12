# Cleo 架构文档

English version: [ARCHITECTURE.en.md](ARCHITECTURE.en.md)

本文档描述当前仓库实际存在的 Cleo AI Agent 本地 runtime 架构。Cleo 是一个基于
Deep Agents 和 LangChain 的本地个人 AI agent runtime，重点保留可检查、可迁移的
本地工作区、thread snapshot、DreamAgent memory、restricted shell tool 和 skills
loading。

## 架构目标

- 使用 Deep Agents 作为主 agent 执行环境。
- 使用 LangChain 初始化模型和工具调用路径。
- 使用 Deep Agents filesystem backend 暴露项目文件。
- 使用 `skills/` 作为能力扩展入口。
- 使用 `memory/` 保存可检查、可迁移的长期记忆。
- 使用 `data/runtime.json` 保存 CLI 级别运行状态。
- 使用 restricted shell tool 运行项目内脚本，并保留审计日志。

## 顶层结构

```text
Cleo-AI-agent/
  main.py
  config/
  core/
  tools/
  skills/
  memory/
  data/
  workspace/
  docs/
```

- `main.py`：CLI 入口，负责 one-shot message、interactive chat、thread 生命周期和图片附件输入。
- `config/`：Pydantic settings models 和 profile 模板。真实 `config/cleo.json` 被 Git 忽略。
- `core/`：agent 构建、runtime 状态模型、thread memory 序列化。
- `tools/`：提供给 Cleo 或 DreamAgent 使用的 LangChain tools。
- `skills/`：Deep Agents skills 目录，当前 tracked skill 是 `demo-production`。
- `memory/`：全局记忆策略、thread snapshot 和项目长期记忆。
- `data/`：runtime 状态、审计日志和后续本地数据。
- `workspace/`：用户输入文件、临时 workflow state 和生成结果。
- `docs/`：架构文档和迁移说明。

## Runtime Layers

### 1. CLI Entry Layer

文件：`main.py`

职责：

- 解析命令行参数。
- 创建 `Agent()` 和 `Runtime()`。
- 为会话生成 `local-{12_hex_chars}` 格式的 thread id。
- 在 interactive chat 中处理 `/quit`、`/exit`、`/reset` 和 `/attach`。
- 在退出、重置、中断或 one-shot 结束时保存 thread snapshot。
- 在正常退出和 one-shot 结束时调用 DreamAgent 做记忆整理。

### 2. Agent Runtime Layer

文件：`core/agent.py`

职责：

- 从 `config/cleo.json` 读取经过 Pydantic 验证的 active profiles。
- 使用 `langchain.chat_models.init_chat_model` 初始化模型。
- 使用 `create_deep_agent` 创建 Cleo 主 agent。
- 使用 `FilesystemBackend(root_dir=repo_root, virtual_mode=True)` 暴露项目虚拟文件系统。
- 使用 `InMemorySaver` 作为当前 LangGraph checkpointer。
- 注入 `run_shell_command` tool。
- 加载 `/skills` 和 `/memory/AGENT.md`。

当前行为：

- 如果 `config/cleo.json` 缺失，Cleo 会创建默认模板并提示用户填写。
- `InMemorySaver` 只在当前进程内保存 LangGraph 状态。
- thread resume 依赖 message snapshot replay，而不是完整 durable graph checkpoint。

### 3. DreamAgent Layer

文件：`core/agent.py`、`tools/dream_agent_tools.py`

职责：

- 读取 `memory/thread_objects/{thread_id}.json`。
- 读取已有 `memory/projects/<project>/` 项目记忆。
- 把 durable facts、decisions、preferences、corrections 和 open questions 写入
  `memory/projects/<project>/AGENT.md`。

触发点：

- `/quit` 和 `/exit` 正常退出时触发。
- one-shot message 结束后触发。
- `/reset`、EOF 和 KeyboardInterrupt 当前只保存 thread snapshot。

### 4. Runtime State Layer

文件：`core/runtime/model.py`

状态文件：`data/runtime.json`

字段：

```json
{
  "current_project": null,
  "current_thread_id": null,
  "projects_list": ["general"],
  "recent_threads": []
}
```

职责：

- 读取当前 CLI 状态。
- 更新当前 project。
- 更新当前 thread id。
- 维护 recent threads。
- 从 `memory/projects/` 同步项目名。

当前行为：

- 如果 `data/runtime.json` 缺失，Runtime 会用默认状态自动创建。

### 5. Thread Snapshot Layer

文件：`core/memory/thread_memory.py`

生成文件：

- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`

职责：

- 使用 `messages_to_dict` 序列化 LangChain messages。
- 保存当前 thread 的 message snapshot。
- 追加 thread registry metadata。
- 使用 `messages_from_dict` 重新加载历史 messages。

### 6. Configuration Layer

文件：`config/settings.py`

读取：

- `config/cleo.json`

核心设置：

- `active_profiles.agent` 选择当前 `AgentProfile`。
- `active_profiles.directory` 选择当前 `DirectoryProfile`。
- `active_profiles.shell` 选择当前 `ShellProfile`。
- `active_profiles.tools` 选择当前 `ToolsProfile`。
- Directory profile 路径默认相对项目根目录解析，绝对路径保持绝对路径。

shell tool 相关设置：

- `sandbox_root`
- `audit_log_path`
- `require_allowlist`
- `enforce_sandbox`
- `require_approval`
- `timeout_seconds`
- `max_output_chars`
- `allowed_commands`
- `denied_patterns`

### 7. Restricted Shell Tool Layer

文件：`tools/shell_tools.py`

工具：`run_shell_command`

职责：

- 只运行 allowlist 中的命令。
- 阻止 pipes、redirects、shell chaining、路径穿越和危险命令模式。
- 将 Deep Agents 虚拟路径映射到真实项目路径。
- 将 working directory 限制在 sandbox root 内。
- 把每次尝试写入 `data/shell_audit.log`。

虚拟路径映射：

```text
/workspace -> repo root
/config    -> repo/config
/core      -> repo/core
/data      -> repo/data
/docs      -> repo/docs
/memory    -> repo/memory
/skills    -> repo/skills
/tools     -> repo/tools
```

### 8. Skills Layer

目录：`skills/`

当前实际存在：

```text
skills/
  demo-production/
    SKILL.md
    agents/openai.yaml
```

职责：

- 为 Deep Agents 提供本地 skill instructions 和 agent 配置。
- 后续业务能力应以独立 skill 目录迁移进入。

### 9. Workspace Layer

目录：`workspace/`

职责：

- 存放用户输入文件。
- 存放临时 workflow state。
- 存放 agent 或脚本生成的工作结果。

当前 tracked workspace 文件更像迁移验证输入或用户工作区文件，不是当前核心代码生成的 runtime 状态。

## 文件来源分类

### 源代码与手写资产

- `main.py`
- `config/settings.py`
- `core/**/*.py`
- `tools/**/*.py`
- `skills/demo-production/SKILL.md`
- `skills/demo-production/agents/openai.yaml`
- `memory/AGENT.md`
- `pyproject.toml`
- `requirements.txt`
- `config/cleo.example.json`
- `data/runtime_example.json`
- `README.md`
- `docs/ARCHITECTURE.md`

### 本地私密配置

- `config/cleo.json`

这些文件从模板复制后由本地维护，不应提交。

### 运行生成或运行维护

- `data/runtime.json`
- `data/shell_audit.log`
- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`
- `memory/projects/<project>/AGENT.md`

### 工作区输入或临时产物

- `workspace/*`

workspace 中的 STL 和 PPTX 文件应视为用户工作区文件或迁移验证输入。

## Resume 机制

当前 resume 是 message snapshot resume：

1. 启动时读取 `data/runtime.json`。
2. 如果存在 `current_thread_id`，询问用户是否继续。
3. 用户确认后读取 `memory/thread_objects/{thread_id}.json`。
4. 使用 `messages_from_dict` 恢复 LangChain messages。
5. 下一次用户消息会与恢复的历史 messages 一起传给 Deep Agents。

已知限制：

- tool state、graph internal state 和 checkpoint metadata 不会完整恢复。
- 当前实现保持 Deep Agents / LangChain 主路径不变。
