# Cleo Desktop

Cleo Desktop 是 Cleo 的 Windows、macOS 和 Linux 图形客户端，由 Electron、React、TypeScript 和 Vite 构建。它不是独立实现的第二套 agent：renderer 通过受控 IPC 调用随应用运行的 Python product core，session、memory、harness 和配置语义都由这个后端服务统一提供。

## 子系统边界

```text
React renderer
    │ CleoClient
    ▼
preload.cjs (contextBridge)
    │ Electron IPC
    ▼
main.mjs / backend.mjs
    │ JSONL over stdio
    ▼
python -m cleo.desktop.server
    │
    ├── DesktopService ── SessionStore / Runtime / Memory
    └── Agent / AgentAdapter ── model and harness providers
```

- `src/`：产品 UI、React hooks、类型和 `CleoClient` 抽象。
- `electron/preload.cjs`：向 renderer 暴露最小 IPC API；保持 context isolation。
- `electron/backend.mjs`：启动 Python、关联 request/response/event，并管理 shutdown。
- `electron/main.mjs`：窗口、菜单、数据根目录、backend 与 updater 生命周期。
- `electron/updater.mjs`：读取 release manifest、校验 SHA-256、下载并重启安装。
- `scripts/`：mock、real backend 与 packaged app smoke test。

Renderer 不应直接读取文件、环境变量或 API Key。Python 配置读取 DTO 只返回 `hasApiKey`；更新密钥时通过写入命令发送，之后不得再次回传原值。

同一次应用运行中，“开发”和“对话”分别保留最后选中的项目与线程；切换到其他页面再返回时恢复原位置，也保留新任务和空项目的草稿。只有原项目或线程已不存在时才选择可用的替代项。这些页面选择不跨应用重启保存。

Codex 和 Claude 的会话、连接验证和账号登录使用本机原生目录（`CODEX_HOME` / `CLAUDE_CONFIG_DIR` 优先，否则 `~/.codex` / `~/.claude`），与原生客户端共用登录和历史。旧版 Cleo 专用目录 `data/codex`、`data/claude` 中可移植的内容会补充到原生目录，原件保留；规则见[配置说明](../docs/CONFIGURATION.md)。

消息操作只在悬停时显示为图标：复制，以及对自己消息的编辑。编辑会调用 `rewind_thread` 回退到该消息之前，再以新文本发送。运行期间输入的消息进入输入框上方的队列：点 Steer 立即送入当前回合，否则在回合正常结束后作为下一条消息发送；停止或失败时保留队列。

开发任务的输入框里，`RuntimePicker` 提供两个控件：模型控件显示「harness · 模型」，菜单先列当前 harness 的模型，标题回到 harness 列表，检查未通过的 harness 仍列出并标为未连接；思考深度控件的菜单里有快速模式和恢复默认。快速模式只在 harness 和模型支持时显示，按对话保存，运行期间不可切换；它消耗更多额度，可用性取决于模型、账号与管理员策略。子任务路由只在设置里开关。

发送按钮旁的圆环（`ContextMeter`）显示上下文占用：最近一次请求放进窗口的输入除以 harness 上报的窗口，没有窗口就不显示。点开面板可看数值，并按需读取 Codex 或 Claude 账号的用量窗口与重置时间。

运行中的回合把思考写成正文，每段工具调用收成一行；回复出现或回合结束后，整段折叠为一行摘要。界面文案只保留标签和状态，不写解释性句子。

## 源码运行

先在仓库根目录准备 Python 3.12 环境和 `config/cleo.json`，再运行：

```powershell
Set-Location ui
npm install
npm start
```

`npm start` 先运行 TypeScript/Vite build，再启动 Electron。开发模式使用当前源码 checkout 的 Python 环境与本地 Cleo 数据根目录。

如果 Python backend 无法启动，先在仓库根目录验证：

```powershell
python -m cleo.desktop.server
```

这条命令会进入 JSONL stdio 协议等待状态，手工检查后可用 Ctrl+C 退出。

## Client 适配层

`src/services/cleoClient.ts` 定义 renderer 所需的产品能力：bootstrap、thread/project 操作、stream turn、slash command、configuration 与 update。当前实现包括：

- `ipcCleoClient.ts`：生产 Electron IPC。
- `mockCleoClient.ts` 与 `mockData.ts`：确定性 smoke/test 数据。

新增 renderer 功能时先扩展稳定的 client/type 契约，再实现 IPC 与 Python command。不要让组件按运行环境分支或绕过 client 直接访问 backend。

## 协议约束

- Python stdout 只允许完整的一行一个 JSON 对象；日志和 traceback 写 stderr。
- 每个 request 必须有可关联的完成、错误或取消结果。
- 流式 UI 更新使用 event，不把 token delta 直接写入持久化 session。
- Window 关闭、backend crash 与应用更新必须结束子进程，不能留下孤儿 runtime。
- 新字段要同时更新 Python projection、TypeScript types、client 实现与 mock fixture。
- Secret 字段不能进入 bootstrap、日志、event、错误文本或 updater metadata。

## 验证

```powershell
npm run typecheck
npm run test:backend
npm run smoke
npm run smoke:inspector
npm run smoke:uiux
npm run smoke:layout
npm run smoke:real
npm run smoke:packaged
```

| 命令 | 验证内容 |
| --- | --- |
| `typecheck` | TypeScript project 与 renderer build contract |
| `test:backend` | backend 进程管理和 updater 单元测试 |
| `smoke` | 确定性 mock 下的主要界面流程 |
| `smoke:inspector` | 普通/窄窗口中的 diff、历史文件列表与终端独立滚动，长内容不撑宽侧栏 |
| `smoke:uiux` | 运行中与折叠后的回合、运行方式菜单、圆环面板等界面回归 |
| `smoke:layout` | 窄窗口下各面板不溢出、不换行 |
| `smoke:real` | 源码模式真实 Python JSONL IPC |
| `smoke:packaged` | 最终独立 runtime、路径和应用启动 |

Windows 上从 PowerShell 运行这些命令；需要 Python 的 smoke 可用 `CLEO_PYTHON` / `CLEO_TEST_PYTHON` 指向仓库的 `.venv`。其余专项 smoke（权限、项目、steering、计时、更新设置等）见 `package.json` 的 `scripts`。

`smoke:packaged` 按平台查找 `release/Cleo` 或 `release/Cleo.app`，也可用 `CLEO_EXECUTABLE` 指定安装后的程序。涉及 Python protocol、数据目录、preload 或 package layout 的改动必须运行 real/packaged smoke。

## 构建发布包

```powershell
npm run package:portable
```

该命令按系统选择 Windows 的 `scripts/build-release.ps1` 或 macOS/Linux 的 `scripts/build-release.py`。平台、架构、数据目录与签名要求见[平台支持](../docs/PLATFORMS.md)。构建器会：

1. 在隔离临时目录执行全新 `npm ci`；
2. 下载独立 Python 3.12 runtime；
3. 从零安装 Cleo 与锁定依赖；
4. 组合 Electron、Python、Node、`agent-browser` 与默认资产；
5. 生成 ZIP、SHA-256 和 update manifest。

产物位于仓库根目录：

```text
release/Cleo/Cleo.exe
release/Cleo-windows-x64.zip
release/Cleo-windows-x64.sha256
release/release.json
```

`ui/` 只保存桌面客户端源码和前端测试，不存放 Python backend、用户数据或最终发布包。

## 安装与更新验证

安装本地构建：

```powershell
Set-Location ..
.\scripts\download.ps1 -PackagePath .\release\Cleo-windows-x64.zip -Launch
```

程序文件位于 `%LOCALAPPDATA%\Programs\Cleo`，用户数据位于 `%LOCALAPPDATA%\Cleo`。安装器与 updater 只在 checksum 和 manifest 校验通过后替换程序目录，不覆盖配置、session、memory 或模型缓存。

上表为 Windows 产物。macOS/Linux 产物及各自的 manifest 命名见[平台支持](../docs/PLATFORMS.md)。发布时须成组上传对应平台的安装包、SHA256 和 manifest；Linux .deb 通过包管理器更新。

## 贡献检查清单

- UI 能力通过 `CleoClient` 表达，没有 Node/文件系统泄漏到 renderer。
- Python stdout 保持纯 JSONL，异常和取消都可关联到 request。
- API Key 只写不读，所有响应和 fixture 都不含 secret。
- mock、real 和 packaged 三种模式使用相同产品语义。
- `npm run typecheck`、`npm run test:backend` 和相关 smoke 通过。
- 用户可见行为同步更新根 README 与对应 `docs/` 页面。

产品总览见[根 README](../README.zh-CN.md)，核心架构见[架构文档](../docs/ARCHITECTURE.md)，完整发布流程见[开发指南](../docs/DEVELOPMENT.md)。
