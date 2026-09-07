# 订阅登录与 DreamAgent

Cleo Chat 可以使用 API Profile，也可以运行用户本机安装的官方 agent CLI。
订阅连接使用官方 CLI 的账号存储；Cleo 不读取、复制或保存 OAuth token，也不提供
网页 Cookie 代理。各 CLI 的模型、订阅额度及计费仍由服务商决定。

Codex 连接使用 ChatGPT 订阅中的 **Codex 额度**，跟随此连接的 DreamAgent 也消耗
同一类额度。普通 ChatGPT Chat 的聊天额度未接入；通过 ChatGPT 账号登录不改变
实际请求使用的服务与计费规则。

## 支持的连接

| 连接 | 官方运行接口 | 登录方式 |
| --- | --- | --- |
| ChatGPT / Codex | Codex App Server，经现有 Python SDK | 设置页打开官方浏览器登录，或 `codex login` |
| Gemini | `gemini --acp` | 设置页调用官方 Google 登录，或在 `gemini` 中选择 Google 登录 |
| GitHub Copilot | `copilot --acp --stdio` | 设置页运行 `copilot login` |
| Grok | `grok agent stdio` | 设置页运行 `grok login` |
| Claude Code | 未修改的本机 `claude -p`，stream-json | 设置页运行 `claude auth login` |

先安装相应的官方 CLI，并放入 PATH，或在 Profile 中填写完整可执行文件路径。
设置 → 模型包含三个独立子页面：当前配置、新增连接、DreamAgent。
“新增连接”使用 **API 密钥 / 账号登录** 标签页。选择服务商后验证密钥或完成官方登录，
再勾选需要添加的模型。验证读取模型元数据，不发送聊天 prompt；保存订阅连接时再次检查认证。
API 支持 OpenAI 兼容、Anthropic 和 Google Gemini 接口。服务没有模型列表端点时允许手动
填写模型 ID，此时不会把未验证的连接标成已验证。
选择账号返回的模型，或填写 `default` 使用官方运行时默认模型。
部分运行时不提供动态模型列表，可以填入官方支持的模型名。
订阅的 `default` 跟随服务商默认值；需要固定模型时应选择具体模型 ID。

API Key 配置继续可用。订阅 Profile 不接受 API Key 或 Base URL。
多个同服务的 Profile 共用该 CLI 当前账号；它们不是相互独立的账号槽位。
登录或在官方 CLI 退出账号会影响使用该 CLI 的其他应用。
Cleo 不主动在额度耗尽后切换付费 API，也不自动购买额度。
官方 CLI 本身的既有配置、组织策略、额外用量设置仍然适用。

“当前配置”只负责查看、切换与管理已有连接。新增不会改变默认模型；切换默认模型用于
新建对话，现有会话仍使用其配置快照。连接显示名称可以修改，内部 Profile ID 保持不变。
一个连接可保存多个 `models`，`model` 是该连接的对话默认模型；旧的单模型配置仍然有效。
列表默认显示“已配置”，需要在连接详情中验证后才显示“已验证”。
默认对话、当前打开的对话或独立 DreamAgent 正在使用的连接不能移除；原因仅在“移除连接”
按钮旁的悬停/点击浮窗中显示。移除闲置连接会删除其本地配置和 API Key，历史会话记录仍可
查看；继续运行这些历史会话需要可用的模型连接。

## DreamAgent

设置 → 模型 → DreamAgent，修改后点击“保存设置”：

- **跟随当前会话**：新配置的默认值。使用来源会话记录的 Profile、连接类型及模型。
  修改全局 Chat 默认模型不改变已有会话的整理来源。
- **独立模型**：从已配置连接中搜索并选择模型，适用于单独整理记忆或处理 Productivity 来源。
- **关闭自动整理**：保留原始会话与待整理来源。

已有显式 `active_profiles.dream_agent` 配置继续生效；清空它即跟随 Chat。
`active_profiles.dream_enabled` 默认 `true`，设为 `false` 停止自动整理。
`active_profiles.dream_model` 保存独立模型选择；即使 Chat 使用同一连接，切换 Chat 模型也
不会改动 DreamAgent 的独立选择。选择跟随或关闭时清除此覆盖值。
Productivity 会话并非 Chat Profile，没有可跟随的 Chat 连接时会要求指定整理 Profile，
不会悄悄使用当前全局 API 模型。

订阅模式的 DreamAgent 开启独立运行时会话，不能续写或替换用户的 Chat 原生会话。
它只获得用于当前来源的记忆整理 MCP 工具。仍必须完成既有的 source hash、证据
event ID、Markdown 输出和显式完成协议；失败保留来源供重试。

配置示例（放入已有 `profiles.agents`）：

```json
{
  "chatgpt": {"backend": "codex", "provider": "codex", "model": "default"},
  "google": {"backend": "gemini", "provider": "gemini", "model": "default"},
  "github": {"backend": "copilot", "provider": "copilot", "model": "default"},
  "grok": {"backend": "grok", "provider": "grok", "model": "default"},
  "claude": {"backend": "claude_code", "provider": "claude_code", "model": "default"}
}
```

## 会话与工具边界

Chat 保留 Cleo persona、项目指导和记忆读取，通过 stdio MCP 复用 Cleo 工具。
每个会话保存不含密钥的配置快照和原生会话标识。支持恢复的运行时使用原生历史；
ACP 明确声明不支持恢复时，以 Cleo 已保存的历史创建新原生会话。
认证失败和普通运行错误不触发重新发送，也不跨服务回退。
已有内容的 Chat 切换连接类型需要新建会话。

原生运行时有自己的系统指令和工具策略，因此行为不会与 API/DeepAgents 完全一致。
Codex 使用只读原生沙箱；Claude Code 关闭内建工具；ACP 拒绝未授权的权限请求，
仅对 Cleo 的 MCP 服务器添加官方工具授权参数。
Cleo MCP 中的 shell、browser 和记忆工具继续执行 Cleo 自己的校验。
Gemini 使用仍受支持但已弃用的 `--allowed-tools` 参数授权 Cleo MCP。

当前订阅 Chat 支持文本。图片及其他附件在调用服务商前明确拒绝，仍可使用 API
Profile 处理。用量展示不把未知值伪装成零；各家 CLI 未统一提供精确额度接口。

## 官方依据（核对于 2026-09-06）

- [Codex App Server](https://learn.chatgpt.com/docs/app-server) 与
  [ChatGPT 订阅认证](https://learn.chatgpt.com/docs/auth)。
- [Gemini ACP](https://geminicli.com/docs/cli/acp-mode/) 与
  [Google AI Pro / Ultra 配额](https://geminicli.com/docs/resources/quota-and-pricing/)。
- [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)。
- [Grok ACP](https://docs.x.ai/build/cli/headless-scripting) 与
  [Grok 官方订阅第三方接入公告](https://x.ai/news/grok-opencode)。普通
  [xAI API 仍独立计费](https://docs.x.ai/console/faq/accounts)。
- [Claude Code 集成条件](https://code.claude.com/docs/en/legal-and-compliance)：
  本连接运行用户安装的未经修改的官方 CLI，由用户通过 Anthropic 自身流程认证。
  不实现第三方 Claude.ai OAuth、不收集凭据、不转售用量；部署方需遵守该页的
  商业条款及运行 Claude Code 的条件。非交互调用是否计入订阅及如何计费，以账号
  当前规则为准，不等同于网页聊天额度。
- [Qwen 认证](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) 已移除
  原 Qwen OAuth 入口，因此不把它列为可用订阅登录。需要 API Key 的 Coding Plan
  可通过已有 API Profile 配置，不能作为网页登录订阅宣传。

自动化测试覆盖配置、来源跟随、恢复、取消、错误传播、MCP schema 和来源范围。
每家服务的账号资格和真实推理仍需在拥有对应订阅的环境中验证。
