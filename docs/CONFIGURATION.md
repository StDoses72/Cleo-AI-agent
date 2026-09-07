# Cleo 配置与安全边界

Cleo 使用两个经过 Pydantic 校验的 JSON 文件：`cleo.json` 管理通用 agent、目录和工具，`harnesses.json` 管理 Productivity provider。配置应被视为本机私有数据。

## 配置位置

| 运行方式 | 主配置 | Harness 配置 | 数据根目录 |
| --- | --- | --- | --- |
| 源码运行 | `config/cleo.json` | `config/harnesses.json` | 仓库根目录下的 `data/`、`memory/` 等 |
| Windows 桌面版 | `%LOCALAPPDATA%\Cleo\config\cleo.json` | `%LOCALAPPDATA%\Cleo\config\harnesses.json` | `%LOCALAPPDATA%\Cleo` |
| macOS 桌面版 | `~/Library/Application Support/Cleo/config/cleo.json` | 同目录 `harnesses.json` | `~/Library/Application Support/Cleo` |
| Linux 桌面版 | `~/.local/share/Cleo/config/cleo.json` | 同目录 `harnesses.json` | `$XDG_DATA_HOME/Cleo`，默认 `~/.local/share/Cleo` |
| Docker Compose | `/config/cleo.json` | `/config/harnesses.json` | `/app`，相关目录由 volume 持久化 |

可用 `CLEO_CONFIG_PATH` 与 `CLEO_HARNESSES_CONFIG_PATH` 指定配置文件。打包应用由 Electron 显式设置 `CLEO_HOME`；源码 checkout 会以仓库为相对路径根。

## `cleo.json` 结构

配置由激活选择和 profile registry 组成：

```json
{
  "active_profiles": {
    "agent": "primary",
    "dream_agent": "economy",
    "directory": "default",
    "shell": "default",
    "tools": "default"
  },
  "profiles": {
    "agents": {},
    "directories": {},
    "shell": {},
    "tools": {}
  }
}
```

`active_profiles` 只保存当前选择的名称；具体定义保存在 `profiles`。引用不存在的 profile、出现未知字段或字段类型不正确时，Cleo 会在启动阶段失败并给出校验错误。

### Agent profile

```json
{
  "provider": "openai",
  "model": "your-model",
  "temperature": 0.7,
  "max_tokens": 100000,
  "api_key": "YOUR_API_KEY",
  "base_url": "https://provider.example/v1"
}
```

- `agent` 用于前台 Cleo。
- `dream_agent` 用于后台记忆整理；省略或设为 `null` 时跟随来源 Chat 会话的模型。
- `api_key` 在内存中使用 secret 类型，但配置文件本身仍是明文，必须保护文件权限。
- `max_tokens` 既传给模型，也用于 context 状态展示；应填写 provider 实际支持的值。

Chat 也支持通过官方 CLI 登录的订阅连接，DreamAgent 可跟随会话或指定已配置的模型。
连接配置、登录步骤和各家限制见 [订阅登录与 DreamAgent](SUBSCRIPTION_CHAT.md)。

### Directory profile

Directory profile 定义产品数据布局。相对路径基于 `root_dir`：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `data_dir` | `data` | runtime state、工具审计和 session artifacts |
| `skills_dir` | `skills` | Cleo 可加载的本地 skills |
| `workspace_dir` | `workspace` | 可选工作区输入/输出 |
| `memory_dir` | `memory` | session event log、memory DB 与投影 |
| `memory_policy_path` | `memory/MEMORY_POLICY.md` | 开发者维护的记忆提取策略 |
| `persona_path` | `PERSONA.md` | persona 的人类可读投影 |
| `session_index_path` | `memory/sessions.sqlite3` | 全局 session metadata registry |
| `session_artifacts_dir` | `data/session_artifacts` | 大型 browser/tool 产物 |
| `runtime_state_path` | `data/runtime.json` | 当前 UI/CLI 导航状态 |

把数据目录迁移到新位置时，应整体迁移相关文件并保持 scope 结构，不要只复制 Markdown 记忆投影。

### Shell profile

推荐的安全基线：

```json
{
  "sandbox_root": ".",
  "audit_log_path": "data/shell_audit.log",
  "require_allowlist": true,
  "enforce_sandbox": true,
  "require_approval": false,
  "timeout_seconds": 30,
  "max_output_chars": 12000,
  "allowed_commands": ["python", "git"],
  "include_platform_defaults": true,
  "denied_patterns": []
}
```

- `require_allowlist` 限制可执行命令的第一个 token。
- `enforce_sandbox` 限制工作目录与路径参数不得逃逸 `sandbox_root`。
- `require_approval` 启用执行前审批；无交互审批通道的场景不应打开后假设命令仍可自动运行。
- `timeout_seconds` 与 `max_output_chars` 控制资源占用，但不是 OS 级安全沙箱。
- `denied_patterns` 是额外的字符串拒绝规则，不能替代 allowlist、路径校验或 provider sandbox。

### Tools profile

`tavily_api_key` 启用 Tavily 搜索；`codex_model` 只控制 Cleo 内部的 Codex tool/MCP 默认模型，不控制所有 Productivity provider。

Browser 子配置的重要边界：

- `enabled` 控制工具是否注册。
- `command` 指向 `agent-browser` 可执行文件。
- `allow_private_network` 默认为 `false`，拒绝 localhost、私网、链路本地和 metadata 地址。
- `allowed_domains` 非空时进一步限制可访问域名。
- `timeout_seconds`、`operation_timeout_ms`、`idle_timeout_seconds` 和 `max_output_chars` 控制进程与输出生命周期。

每个 Cleo thread 使用独立 browser session。截图和被截断的完整结果写入 `session_artifacts_dir/browser/`，其中可能包含敏感页面内容。

## `harnesses.json` 结构

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

`providers` 的 key 是 Cleo session 中记录的 provider 名称，`type` 决定实现：

| `type` | 关键配置 | 说明 |
| --- | --- | --- |
| `codex_sdk` | `model`、`approval_mode`、`sandbox` | 支持丰富的原生 thread、model、usage 与控制面 |
| `claude_sdk` | `model`、`permission_mode` | 通过 Claude Agent SDK 运行；能力按 SDK 暴露 |
| `acp` | `command`、`args`、`env`、`auto_approve` | 启动任意兼容 Agent Client Protocol 的本地进程 |

Codex 的 `approval_mode` 支持 `deny_all`、`auto_review` 和 `user`。`user` 会把
app-server 的命令、文件修改和额外权限请求交给调用端决定。Cleo Desktop 会把
`auto_review` 切换成可交互的 `user` 模式并在输入区上方显示审批面板；显式配置的
`deny_all` 仍保持拒绝。CLI 继续遵循 `harnesses.json` 中配置的模式。

只有 `enabled: true` 的 provider 会注册。`default_provider` 必须存在且启用，否则配置校验失败。

ACP 的 `env` 可能包含 secret；不要把含真实 token 的 `harnesses.json` 提交到版本库。`auto_approve` 会扩大外部 agent 的权限，只有在可信工作区和明确 sandbox 下使用。

## Space、project 与 cwd

这三个概念不能互换：

- `space`：`non_productivity` 或 `productivity`，是最高级数据隔离边界。
- `project`：Cleo memory scope。通用聊天中是逻辑名称；Productivity 中通常由工作目录名称派生。
- `cwd`：外部 coding harness 实际读写的文件目录。

`--project` 不会改变 Productivity 的代码目录，`--cwd` 也不会让通用聊天跨 project 读取记忆。

## 本地文件的权威级别

| 文件 | 权威级别 | 是否可重建 |
| --- | --- | --- |
| `events.jsonl` | session 原始事实源 | 否，应优先备份 |
| `manifest.json` | 当前 metadata/status 投影 | 可从事件和上下文部分重建 |
| `compact.json` | 脱敏压缩投影 | 是 |
| `sessions.sqlite3` | 全局 session registry | 是 |
| space `memory.sqlite3` | 长期记忆、evidence、chunks | 部分内容来自 consolidation，不应随意删除 |
| `MEMORY.md` / `PERSONA.md` | 人类可读投影 | 是，应由数据库重新渲染 |
| `runtime.json` | 当前导航状态 | 是，不含对话正文 |

## 部署前安全清单

- 使用专用 API Key，并在 provider 侧设置最小权限和费用上限。
- 保持 `config/`、`data/`、`memory/` 和 session artifacts 私有。
- 对 shell 同时启用 allowlist 与 sandbox，避免仅依赖字符串 denylist。
- 为 coding harness 选择最小可用 sandbox/approval，不默认使用 full access 或 auto approve。
- 浏览器默认保持 `allow_private_network: false`，需要内网测试时再临时开放并限制域名。
- 在备份或迁移前正常关闭 Cleo，避免复制正在写入的 SQLite/event 文件。
- 把重要自动记忆回查到 evidence 与 `events.jsonl`，不要把生成投影当作未经验证的事实。

架构层面的数据流与不变量见[架构说明](ARCHITECTURE.md)。
