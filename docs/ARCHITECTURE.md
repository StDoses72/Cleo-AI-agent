# Cleo 架构文档

English version: [ARCHITECTURE.en.md](ARCHITECTURE.en.md)

本文档描述当前仓库实际存在的 Cleo 本地 agent 架构。Cleo 是从原 AI4Casting
项目迁移而来，因此代码中仍有少量 `ai4casting` 命名和历史工作区文件。除非文件已在
当前仓库中存在，否则本文不会把迁移前能力写成当前能力。

## 架构目标

Cleo 当前目标是一个轻量、本地、可迁移的个人 AI agent runtime：

- 用 Deep Agents 提供主 agent 执行环境。
- 用本地 filesystem backend 暴露项目文件。
- 用 `skills/` 作为能力扩展入口。
- 用 `memory/` 保存可检查、可迁移的长期记忆。
- 用 `data/runtime.json` 保存 CLI 级别运行状态。
- 用受限 shell tool 运行项目内脚本，并保留审计日志。

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

各目录职责：

- `main.py`：CLI 入口，负责 one-shot 消息、交互式循环、thread 生命周期和附件输入。
- `config/`：本地设置和 profile 模板。真实 `config/cleo.json` 被忽略入库。
- `core/`：agent 构建、runtime 状态模型、thread memory 序列化。
- `tools/`：提供给 agent 或 DreamAgent 使用的 LangChain tools。
- `skills/`：Deep Agents 技能目录。当前实际存在 `demo-production`。
- `memory/`：全局记忆策略、thread 快照和项目长期记忆。
- `data/`：运行状态、审计日志和后续本地数据。
- `workspace/`：用户输入文件、临时 workflow state、生成结果。
- `docs/`：项目架构和迁移说明。

## 运行层级

### 1. CLI Entry Layer

文件：`main.py`

职责：

- 解析命令行参数。
- 创建 `Agent()` 和 `Runtime()`。
- 为会话生成本地 thread id，格式为 `local-{12_hex_chars}`。
- 在交互式模式中处理 `/quit`、`/exit`、`/reset` 和 `/attach`。
- 在退出、重置、中断或 one-shot 结束时保存 thread snapshot。
- 在正常退出时调用 DreamAgent 做记忆整理。

当前附件能力：

- `/attach` 支持图片文件。
- 支持 MIME 类型：JPEG、PNG、WebP、GIF。
- 图片会被 base64 编码后附加到下一条用户消息。

### 2. Agent Runtime Layer

文件：`core/agent.py`

职责：

- 读取 `config/cleo.json` 中的 active profile。
- 使用 `langchain.chat_models.init_chat_model` 初始化模型。
- 使用 `create_deep_agent` 创建 Cleo 主 agent。
- 使用 `FilesystemBackend(root_dir=repo_root, virtual_mode=True)` 暴露项目虚拟文件系统。
- 使用 `InMemorySaver` 作为当前 LangGraph checkpointer。
- 注入 `run_shell_command` tool。
- 加载 `/skills` 和 `/memory/AGENT.md`。

重要现状：

- `config/cleo.json` 缺失时，当前代码会直接打开失败。
- `InMemorySaver` 只在进程内保存 LangGraph 状态。
- thread resume 依赖 message snapshot 重放，不是完整 durable graph checkpoint。

### 3. DreamAgent Layer

文件：`core/agent.py`、`tools/dream_agent_tools.py`

职责：

- DreamAgent 是后台记忆整理 agent。
- 它读取 `memory/thread_objects/{thread_id}.json`。
- 它读取已有 `memory/projects/<project>/` 项目记忆。
- 它把 durable facts、decisions、preferences、corrections、open questions 等整理到
  `memory/projects/<project>/AGENT.md`。

当前触发点：

- `/quit` 和 `/exit` 正常退出时触发。
- one-shot 消息结束后触发。
- `/reset`、EOF 和 KeyboardInterrupt 目前只保存 thread snapshot，不运行 DreamAgent。

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
- 维护最近 thread 列表。
- 从 `memory/projects/` 同步项目名。

当前限制：

- `data/runtime.json` 必须预先存在。
- 初始化时会立即调用 `sync_projects_from_disk()` 并回写 runtime JSON。

### 5. Thread Snapshot Layer

文件：`core/memory/thread_memory.py`

生成文件：

- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`

职责：

- 用 `messages_to_dict` 序列化 LangChain messages。
- 保存当前 thread 的 message snapshot。
- 追加 thread registry 元数据。
- 用 `messages_from_dict` 重新加载历史 messages。

注意：

- 这不是完整 LangGraph checkpoint。
- 当前 resume 方式是把加载出的 messages 与新用户消息一起传入下一次 deepagent stream。

### 6. Configuration Layer

文件：`config/settings.py`

读取：

- `.env`
- OS environment variables

核心路径：

- `PROFILE_DIR` -> `config/cleo.json`
- `DATA_DIR` -> `data/`
- `SKILLS_DIR` -> `skills/`
- `WORKSPACE_DIR` -> `workspace/`
- `MEMORY_DIR` -> `memory/`
- `THREAD_OBJECTS_DIR` -> `memory/thread_objects/`
- `THREAD_REGISTRY_PATH` -> `memory/threads.jsonl`
- `RUNTIME_STATE_PATH` -> `data/runtime.json`

shell tool 相关设置：

- `SHELL_SANDBOX_ROOT`
- `SHELL_AUDIT_LOG_PATH`
- `SHELL_REQUIRE_ALLOWLIST`
- `SHELL_ENFORCE_SANDBOX`
- `SHELL_REQUIRE_APPROVAL`
- `SHELL_TIMEOUT_SECONDS`
- `SHELL_MAX_OUTPUT_CHARS`
- `SHELL_ALLOWED_COMMANDS`
- `SHELL_DENIED_PATTERNS`

### 7. Restricted Shell Tool Layer

文件：`tools/shell_tools.py`

工具：`run_shell_command`

职责：

- 只运行 allowlist 中的命令。
- 阻止 pipes、redirects、shell chaining、路径穿越和危险命令模式。
- 将 Deep Agents 虚拟路径映射为真实项目路径。
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

说明：

- shell sandbox 限制的是进程工作目录。
- 受信任脚本仍可接收用户提供的 Windows 绝对路径作为输入参数。

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

- 为 Deep Agents 提供本地技能说明和 agent 配置。
- 后续业务能力应以独立 skill 目录迁移进来。

迁移说明：

- 旧文档曾提到 casting 相关技能目录，但当前 tracked 文件中不存在。
- 不应把未迁移的技能写入“当前能力”。

### 9. Workspace Layer

目录：`workspace/`

职责：

- 存放用户输入文件。
- 存放临时 workflow state。
- 存放 agent 或脚本生成的工作结果。

当前存在文件：

- `workspace/product.stl`
- `workspace/双联屏-DieCasting_DFM_EON-2020.9.03.pptx`

这些文件更像迁移或业务验证输入，不是当前核心代码生成的 runtime 状态。

## 文件来源分类

### 源码与手写资产

- `main.py`
- `config/settings.py`
- `core/**/*.py`
- `tools/**/*.py`
- `skills/demo-production/SKILL.md`
- `skills/demo-production/agents/openai.yaml`
- `memory/AGENT.md`
- `pyproject.toml`
- `requirements.txt`
- `.gitignore`
- `.gitattributes`
- `README.md`
- `docs/ARCHITECTURE.md`

### 本地私密配置

- `.env`
- `config/cleo.json`

这些文件从模板复制后由本地维护，不应提交。

### 模板文件

- `.env.example`
- `config/cleo.example.json`
- `data/runtime_example.json`

### 运行生成或运行维护

- `data/runtime.json`
- `data/shell_audit.log`
- `memory/thread_objects/{thread_id}.json`
- `memory/threads.jsonl`
- `memory/projects/<project>/AGENT.md`

### 工作区输入或临时产物

- `workspace/*`

当前仓库中已有的 STL 和 PPTX 应视为迁移验证输入或用户工作区文件。

## Thread 生命周期

### 新交互式会话

1. `main.py` 生成新 thread id。
2. `Runtime.update_current_thread_id(thread_id)` 写入 `data/runtime.json`。
3. 用户消息通过 `Agent.stream_text()` 进入 deepagent。
4. LangGraph 状态暂存在 `InMemorySaver`。

### 正常退出

1. 用户输入 `/quit` 或 `/exit`。
2. `_save_thread_snapshot()` 从 deepagent state 读取 messages。
3. `save_messages_to_file()` 写入 `memory/thread_objects/{thread_id}.json`。
4. 同时追加 `memory/threads.jsonl`。
5. DreamAgent 整理长期项目记忆。
6. runtime 清空 `current_project` 和 `current_thread_id`。

### reset

1. 保存当前 thread snapshot。
2. 生成新的 thread id。
3. 清空当前 project。
4. 写入新的 `current_thread_id`。

### 中断

EOF 或 KeyboardInterrupt：

- 保存 thread snapshot。
- 保留 `current_thread_id`。
- 下次启动时提示是否继续该未完成 thread。

## Resume 机制

当前 resume 不是 durable checkpoint resume，而是 message snapshot resume：

1. 启动时读取 `data/runtime.json`。
2. 如果存在 `current_thread_id`，询问用户是否继续。
3. 用户确认后读取 `memory/thread_objects/{thread_id}.json`。
4. 用 `messages_from_dict` 恢复 LangChain messages。
5. 下一次用户消息会与恢复的历史 messages 一起传给 deepagent。

已知限制：

- tool state、graph internal state 和 checkpoint metadata 不会完整恢复。
- 如果未来需要更强恢复能力，应替换或补充 durable LangGraph checkpointer。

## 配置自动化建议

当前启动依赖多个手动步骤。建议新增一个初始化模块，例如 `core/bootstrap.py`，
并在 CLI 中暴露：

```bash
python main.py --init
python main.py --doctor
```

`--init` 可做：

- 如果 `.env` 缺失，从 `.env.example` 复制。
- 如果 `config/cleo.json` 缺失，从 `config/cleo.example.json` 复制。
- 如果 `data/runtime.json` 缺失，从 `data/runtime_example.json` 或默认 dict 创建。
- 创建 `memory/thread_objects/`、`memory/projects/`、`workspace/`。
- 保持已有本地文件不覆盖。

`--doctor` 可检查：

- `.env` 是否存在。
- `config/cleo.json` 是否存在且 JSON 可解析。
- active profile 是否存在。
- API key 是否仍是模板占位符。
- `data/runtime.json` 是否存在且字段完整。
- shell allowlist 和 denylist 是否为空或危险。
- 运行目录是否可写。

更进一步，可以让 `Runtime` 在 runtime JSON 缺失时自动创建默认状态，让
`Agent` 在 profile 缺失时抛出面向用户的配置错误。这样首次运行会更稳。

## 当前技术债

- 项目命名仍混有 `Cleo` 和 `ai4casting`。
- README、包名、console command 是否统一，需要一次明确决策。
- `config/cleo.json` 和 `data/runtime.json` 缺失时错误不够友好。
- `DreamAgent` 已能运行，但项目选择逻辑仍依赖 `runtime.current_project`。
- `SHELL_REQUIRE_APPROVAL=True` 的 interrupt/resume 交互还没有在 CLI 中完整实现。
- `skills/` 当前只有 demo-production，业务技能迁移尚未完成。

## 推荐演进顺序

1. 增加 bootstrap/doctor，先自动化本地初始化。
2. 明确命名策略：保留 `ai4casting` 兼容入口，还是改为 `cleo`。
3. 让 runtime/profile 缺失时给出清晰修复建议。
4. 为 DreamAgent 增加 project 选择或 project inference。
5. 再迁移 casting/pptx/CAD 等业务技能目录。
6. 最后评估 durable LangGraph checkpointer。
