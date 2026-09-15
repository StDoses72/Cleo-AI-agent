# 会话内切换 harness

## 行为与边界

- 开发和进化会话使用原有 harness/model 选择器，在当前 Cleo ID 内切换。项目、工作目录、可查看的完整历史和未发送草稿保持连续。
- 桌面等待当前 stream 的完整收尾；AgentService 的会话锁保护 prompt 与切换。等待期间拒绝重复切换、新轮次和运行参数修改，原轮次仍可回答权限/澄清问题或取消。
- 先读取并校验完整事件序列，再启动目标，检查可获得的登录状态并配置权限/问题入口，最后更新路由。失败保留原路由；切回旧 harness 也创建新的原生会话，避免恢复陈旧的原生上下文。
- 规范对话、来源引文工作状态和近期证据作为只读背景随目标的下一条新消息传入。长证据保存在有来源校验的快照中，由绑定本会话的只读 MCP 分页提供。选择操作本身不提交模型轮次，也不重放历史工具调用。首轮成功落盘仅表示运行完成，不代表模型已理解全部历史。
- 未确认交接的会话重开后，从完整事件重新准备目标。旧版的 `session_completed` 不冒充交接确认；旧版写入的新增进度也会纳入后续交接。

### 长历史

旧实现的 16,000 字节原始历史上限已移除。新实现将原始历史、规范对话与本轮输入分开：交接正文默认最多 24,000 UTF-8 字节，外置证据通过绑定快照读取，单页最多 8,000 字节。新用户消息加交接正文超过保守 64,000 字节时在写入/提交前拒绝；这些是未知目标容量时的应用策略，不是目标模型的精确 token 窗口。

当前长历史通道支持已配置记忆 MCP 的 Codex 与 Claude；其他 Adapter 在规范历史可全部内联时仍可使用，否则在提交前明确拒绝。尚未新增模型摘要调用，也未承诺任意模型上的无损语义续接。详见 `context-handoff.md`。

### 原生运行限制

Codex 使用账号接口；Claude 对 SDK 实际使用的 CLI 执行只读 `auth status`（无法识别 SDK transport 时拒绝切换），ACP 依赖现有连接/认证/新会话协议的错误。实际厂商端的认证、持久化及模型是否遵守只读历史说明仍需人工验收；不把本地启动成功当成模型轮次已经通过。

## 受影响的持久化

| 存储 | 改动 |
| --- | --- |
| `manifest.json` | 更新已有 `provider`、`native_session_id`、`runtime_options`，保留 Cleo 身份字段及未知字段；运行选项按已知字段合并。 |
| `events.jsonl` | 继续使用 schema 1 和已有 `provider_event` 包装，追加 `cleo/harness_switch` / `cleo/handoff_delivered` 载荷。历史事件不重写。 |
| `harnesses.json` | 复用已有注册函数，仅在选择未注册内置 harness 时追加已有 schema 的配置。 |

未修改 SessionStore、schema/defaults、memory 格式、skills、CLEO_HOME、Electron userData、版本选择器或恢复控制器。未增加自动迁移。未知/不可读数据报错，不用空默认值覆盖。

旧程序不理解交接标记：若在新版尚未发送首轮前切回旧程序，旧程序不能主动给原生线程注入历史（无 native ID 的新草稿也可能无法恢复）。共享历史与交接标记仍保留；再使用新版可重新交接。不能将原生 SDK 行为或旧程序功能兼容性描述为已验证。

## 本次验证

全部数据夹具位于临时目录，未使用真实聊天、记忆、配置或技能作为写入对象。

- `PYTHONPATH=. python -m unittest discover -s tests/desktop -p test_harness_switch.py -v`：15 项通过。含流式工具结果、失败重试、取消等待、登录检查、磁盘写入失败、未分配 native ID、旧 writer 写入、未知字段及长历史拒绝。
- `PYTHONPATH=. python -m unittest discover -s tests/desktop -p test_task_harness_selection.py -v`：已有 13 项通过。
- `node --test ui/tests/timeline-cache.test.mjs ui/tests/model-connection-scope.test.mjs`：已有 11 项通过；Vite WebSocket 尝试监听端口出现沙箱 EPERM 提示，测试断言均完成。
- `npm run build --prefix ui`：安装的 TypeScript 编译器 `tsc -b` 与 Vite 生产构建通过，仅有既有 bundle 大小提示。
- `PYTHONPATH=. python tests/desktop/check_harness_switch_compatibility.py`：迭代 HEAD 和可返回的 `baseline-91cf47d1-ad81-490c-a2eb-f0d47c74ab72` 源码，**2 组**旧读写器 → 新切换/读写 → 旧恢复/读写 → 新恢复/切回通过。验证缺失可选字段、未知字段、非空消息/工具结果/记忆/配置/技能，以及完整新增事件载荷未丢失。厂商原生会话使用 fake provider。
- `git diff --check`：通过。

待验证：`node ui/tests/harness-switch.smoke.mjs` 在监听 `127.0.0.1` 时被沙箱 EPERM 阻断，未运行浏览器交互断言。完整 pytest/ruff 未运行：当前 Python 缺少这些依赖，网络 DNS 限制阻止安装。

冻结的六个人工案例及既有预期没有修改，也没有标为通过。桌面独立检查及人工验收继续决定是否可应用。
