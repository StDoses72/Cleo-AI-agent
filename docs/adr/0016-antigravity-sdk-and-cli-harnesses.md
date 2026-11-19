# 0016. Gemini 开发会话分两条路径接入：订阅额度走 Antigravity CLI（`agy acp`），API Key / Google Cloud 走 Antigravity SDK

- **Status**: Accepted
- **Date**: 2026-11-19

## Context

Issue #184：希望把 Google 官方的 Antigravity Python SDK（`google-antigravity`）接入 Cleo 的 harness 层，在开发任务里选择和使用 Gemini 模型；优先确认能否通过 Google 官方登录直接使用 Google AI Pro / Ultra 的订阅额度，并保留 Gemini API Key 作为独立选项。

决策时已知的事实（2026-11-19 核实）：

- `google-antigravity` 0.1.24 会为每个会话启动一个随包附带的 `localharness` 进程（Windows 上的 `localharness.exe` 约 145 MB），进程之间通过 protobuf 通信。它的模型端点只有 `GeminiAPIEndpoint`（Gemini API Key）、`VertexEndpoint`（Google Cloud / Gemini Enterprise，可用 ADC）、`GemmaEndpoint` 和 `CustomEndpoint` 四种（见 `proto/localharness.proto` 中的 `ModelConfig`），**没有 Google 账号登录方式**。官方安装文档在 SDK 一节只列出 API Key 和 Vertex 两种认证；个人 Google 账号（Free / Pro / Ultra）的浏览器登录只适用于 App、CLI 和 IDE 插件。
- Google 已于 2026-06-18 停止为 Pro / Ultra 订阅用户提供 Gemini CLI 服务，改由 Antigravity CLI（`agy`）接替。`agy` 1.5.0 起自带 `agy acp`，以 ACP 服务的形式运行，复用 `agy` 或 `agy acp --login` 登录后缓存的凭据（凭据保存在系统钥匙串中）。
- Cleo 已有通用的 ACP provider（`cleo/integrations/harnesses/acp.py`），开发任务里的 `gemini --acp`、`opencode acp` 等就是这样接入的。
- 旧版 Cleo 读取 `harnesses.json` 时，`ProductivityProviderSettings` 是只认识 `codex_sdk` / `claude_sdk` / `acp` 的判别联合，并且设置了 `extra="forbid"`。文件里一旦写入新的 `type`，回退到旧版后配置就无法读取。

## Decision

**订阅额度走 Antigravity CLI。** 开发任务的内置 harness 增加 `antigravity`，即 ACP 预设 `agy acp`，与 `gemini --acp` 并列。Pro / Ultra 账号先用 `agy` 完成一次登录，Cleo 不经手任何凭据。由于类型仍是 `acp`，旧版 Cleo 也能读懂这条配置。

**API Key 和 Google Cloud 走 Antigravity SDK。** 新增 `AntigravityProvider`（`provider_type = "antigravity_sdk"`，见 `cleo/integrations/harnesses/antigravity.py`）：

- 认证：`api_key` 读取 `GEMINI_API_KEY`；`vertex` 使用 ADC，加上 `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`。`auth_status()` 不发请求，只给出认证方式、计费归属（`gemini_api_key` 或 `google_cloud_project`）和缺少的配置。连接检查失败时直接说明缺了什么。
- 会话：工作目录即 `workspaces`；会话记录保存在 Cleo 自己的 `data/antigravity` 下，按 conversation id 以 `RESUME` 模式恢复；回复和思考按增量流式输出；取消调用 `conversation.cancel()`。
- 模型与思考深度：SDK 没有列出模型的接口，只提供 SDK 默认模型和配置里写明的模型；思考深度对应 `ThinkingLevel`。由于两者都在 agent 启动时固定，改动后会在同一个 conversation 上重启 agent。
- 审批：注册一条 `ask_user("*")` 策略，由 Cleo 的 `_decide` 判断。只读工具直接放行；工作区之外的文件操作一律拒绝；其余操作按会话的审批模式处理：`user` 在 Cleo 中询问，`auto_allow` 放行，`deny_all` 拒绝。
- SDK 采用延迟导入。没有安装 SDK 时 Cleo 照常启动，选择这个 harness 时会提示如何安装。
- 上下文占用不显示：SDK 只提供整轮的累计用量，不符合 ADR 0011 的口径（最近一次请求的输入）。

**`antigravity_sdk` 不写入 `harnesses.json`。** 它作为内置选项在运行时合并，以免旧版 Cleo 读不了配置。

## Alternatives considered

- **只用 SDK。** 无法使用订阅额度，也就满足不了 issue 的首要目标。否决。
- **在 SDK 里读取 `agy` 缓存的账号凭据，或自己实现 Google OAuth。** SDK 不支持这样做；绕过官方客户端去使用订阅凭据，既违背官方提供的方式，也容易随版本变化失效。否决。
- **为 `agy` 的 headless stream-json 模式写一个专用 provider。** `agy acp` 已经是官方的 ACP 服务，没必要再写一层（ADR 0004 的原则：不为每个 harness 增加额外的适配层）。否决。
- **把 `antigravity_sdk` 写进 `harnesses.json` 的类型联合。** 回退到旧版后配置无法读取（参见 #166）。否决，改为运行时内置。

## Consequences

- 订阅路径需要用户自行安装 Antigravity CLI 并登录一次；Pro / Ultra 请求的计费归属要在 Google 的用量页面核实，这一步需要真实账号。
- SDK 路径需要 API Key 或 Google Cloud 项目才能做端到端验证；离线测试使用伪 SDK 覆盖事件翻译、审批、恢复和错误处理。
- 是否把 SDK（约 150 MB）随安装包分发，见 PR 说明中的待定事项。

## References

- Issue #184
- `cleo/integrations/harnesses/antigravity.py`、`cleo/desktop/task_harnesses.py`
- [Antigravity SDK](https://antigravity.google/docs/sdk/overview) · [认证](https://antigravity.google/docs/install#programmatic-authentication) · [Antigravity CLI ACP](https://antigravity.google/docs/cli/acp/) · [Gemini CLI 迁移公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
