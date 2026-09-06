# Cleo 开发与发布指南

本指南面向准备修改、测试或发布 Cleo 的贡献者。产品架构先读[架构说明](ARCHITECTURE.md)，后端阅读顺序见[后端代码导读](BACKEND_CODE_REVIEW.md)。

## 技术栈

- Python 3.12+：产品核心、CLI/TUI、session、memory、harness 与 desktop backend。
- Deep Agents、LangChain/LangGraph：通用聊天 agent runtime。
- Textual 与 Rich：终端交互和一次性输出。
- FastMCP：stdio MCP server。
- React 19、TypeScript、Vite、Electron：Windows、macOS、Linux 桌面客户端。
- Pytest、Ruff、Node test runner、Playwright smoke scripts：回归验证。

## 本地环境

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

源码浏览器工具：

```powershell
npm install -g agent-browser@0.33.1
```

Desktop renderer：

```powershell
Set-Location ui
npm install
npm start
```

开发模式会启动 Electron，并通过 `ui/electron/backend.mjs` 连接当前源码环境中的 Python backend。生产 renderer 只依赖 `CleoClient` 协议，不应直接访问 Python 文件或用户数据。

## 代码所有权

```text
cleo/agents/                  通用 Cleo 与 DreamAgent
cleo/agents/tools/            shell、browser、memory、Codex 等 agent tools
cleo/cli/                     参数、chat/productivity TUI、生命周期和渲染
cleo/config/                  Pydantic 配置模型、加载器和模板
cleo/desktop/                 JSONL stdio 协议、use case service 和 UI projection
cleo/harnesses/               provider-neutral model、data plane 与 control plane
cleo/integrations/harnesses/  Codex、Claude 与 ACP provider 实现
cleo/memory/                  compaction、store、persona、state 与路径
cleo/sessions/                session 事实源、registry 与 managed/native 聚合
cleo/runtime/                 当前交互状态与 context usage
ui/                           Electron main/preload、React renderer 和 smoke tests
tests/                        与上述 Python 责任域对应的测试
```

依赖方向应保持清晰：入口可以组合 core service；session 与 memory 不应反向依赖 CLI；provider SDK 类型不应泄漏到 `SessionStore` 或 UI renderer。

## 配置开发环境

从模板创建私有配置：

```powershell
Copy-Item cleo\config\templates\cleo.example.json config\cleo.json
Copy-Item cleo\config\templates\harnesses.example.json config\harnesses.json
```

不要在测试 fixture、日志或 commit 中写入真实 API Key。单元测试应优先注入临时路径、fake provider 和最小事件，不依赖用户的本地配置或登录状态。

## 验证矩阵

### Python

```powershell
ruff check cleo tests
pytest -q
```

修改单个 subsystem 时先运行对应测试，例如：

```powershell
pytest -q tests\sessions
pytest -q tests\memory
pytest -q tests\desktop
pytest -q tests\integrations
```

### Desktop

```powershell
Set-Location ui
npm run typecheck
npm run test:backend
npm run smoke
npm run smoke:update
```

- `typecheck`：TypeScript project build check。
- `test:backend`：Electron backend/updater 的 Node 单元测试。
- `smoke`：使用确定性 mock 验证 renderer 主流程。
- `smoke:update`：使用隔离目录验证更新期间的启动拦截、普通单实例，以及安装成功／失败提示。
- `smoke:real`：验证源码模式的真实 JSONL IPC。
- `smoke:packaged`：验证带独立 Python runtime 的最终发布包。

### Diff 完整性

```powershell
git status --short
git diff --check
git diff --stat
```

`git diff` 不显示 untracked 文件。提交或 review 前必须同时查看 `git status --short`，并确认没有 `config/`、runtime DB、event log、模型、附件或构建缓存进入变更。

## 依赖管理

`pyproject.toml` 是 Python 直接依赖入口，保留最低版本，不限制旧的上限。
`ui/package.json` 和 `ui/runtime/package.json` 中的应用依赖跟随 npm 的 `latest` 稳定版标签。
运行工具中的 npm 保留 11.x，以兼容内置 Node 24；Python/Node 本身仍使用发布流程指定的运行时。
Codex Python SDK 使用官方配套依赖，桌面版通过 `CLEO_CODEX_BIN` 调用单独更新的官方 `@openai/codex` CLI，避免模型列表受 Python SDK 发版速度限制。

`requirements.txt` 是面向 Python 3.12/Linux 容器生成的精确锁文件；两个 `package-lock.json` 记录对应的 npm 解析结果。这些文件由更新命令生成，不应手工编辑。仓库忽略的 `uv.lock` 仅供本地使用；使用 uv 开发环境时，运行 `uv sync --upgrade --extra dev` 同步升级。

更新锁文件并构建镜像：

```powershell
python scripts\update_project.py
```

只更新 Python 和两个 npm 锁文件（需要 Node/npm）：

```powershell
python scripts\update_project.py --skip-build
```

Docker 不可用但已安装 `uv` 时：

```powershell
python scripts\update_project.py --local-resolver --skip-build
```

使用镜像源时可以同时保留官方 PyPI 作为缺失包 fallback：

```powershell
python scripts\update_project.py `
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple `
  --extra-index-url https://pypi.org/simple
```

更新后运行完整 Python 测试、`npm --prefix ui run test:backend` 和前端构建，并检查锁文件变化。桌面构建默认先运行相同更新流程；CI 在测试前更新一次，打包传入 `--locked-dependencies`（Windows 为 `-LockedDependencies`）复用已测试的版本。

安装后的 Cleo 每天后台检查 Python 依赖、Codex CLI 和 agent-browser。更新安装在 Cleo 数据目录的独立 `runtimes/` 目录中，导入检查、依赖一致性和工具启动检查通过后才发布切换指针，下次启动生效。当前任务始终使用启动时选定的版本。检查或安装失败保留当前版本，启动检查失败回退到随应用安装的运行时。后续检查会清理不用的旧运行时和中断的更新目录。

React 和 Electron 等已构建的依赖随 Cleo 整包升级：安装版每六小时检查发布服务器，自动下载并校验，下次启动再次校验后安装。Linux `.deb` 安装仍由系统包管理器更新应用；其 Python/工具依赖也支持上述后台更新。此机制需要先安装包含该功能的 Cleo 版本，不会改写旧安装版的代码。

## Docker 开发

```powershell
docker compose build
docker compose run --rm cleo --help
docker compose run --rm cleo "运行一次 smoke task"
```

镜像通过 `requirements.txt` 安装依赖。DreamAgent 使用 `cleo.json` 中选择的模型，
不再下载或常驻本地 embedding 模型。

Compose 使用 bind mount 读取配置与 workspace，用 named volume 保存 data、memory 和 Codex home。测试后不要把 volume 中的用户数据复制回仓库。

## Windows 桌面发布

macOS/Linux 的原生构建、安装格式、签名边界与四目标 CI 见[平台支持](PLATFORMS.md)。
`npm run package:portable` 会按当前操作系统选择构建器；下面保留 Windows 发布步骤。

从 `ui/` 运行：

```powershell
npm run package:portable
```

该命令调用 `scripts/build-release.ps1`，在隔离临时目录中执行全新 `npm ci`，下载独立 Python 3.12 runtime，从零安装 Cleo 依赖，并组合 Electron、Python、Node 与 `agent-browser`。

最终产物统一生成到仓库根目录：

```text
release/Cleo/Cleo.exe
release/Cleo-windows-x64.zip
release/Cleo-windows-x64.sha256
release/release.json
```

发布前至少执行：

```powershell
Set-Location ui
npm run typecheck
npm run test:backend
npm run smoke
npm run package:portable
npm run smoke:packaged
```

安装当前本地产物：

```powershell
Set-Location ..
.\scripts\download.ps1 -PackagePath .\release\Cleo-windows-x64.zip -Launch
```

下载器会校验 checksum 并原子替换程序目录。自动更新依赖 GitHub Release 中同时存在 ZIP、SHA256 和 `release.json`，三者版本与内容必须一致。

点击“重启并安装”后，独立的 Windows 更新窗口显示校验、解压、等待退出、替换和完成状态。
只有安装器及进度窗口确认启动后主程序才退出；此时重复打开相同安装目录的 Cleo 会立即退出
并唤起更新窗口。安装状态保存在临时目录下按安装路径区分的 `cleo-install-*/status.json`，
通过 PID 和进程启动时间判断安装器是否仍然存活，避免异常退出或 PID 重用造成永久拦截。
安装包在安装目录同一磁盘的专属临时目录中解压，再以目录重命名替换；被拦截的启动若短暂
占用目录句柄，安装器会进行有限重试。新的更新尝试会关闭上一次的进度窗口。

安装失败会保留下载缓存并明确提示原因，不自动重复启动旧版；用户可以从进度窗口打开 Cleo
后重新检查更新。新版启动时显示一次安装结果。打包时必须同时包含 `update.ps1` 和
`update-progress.ps1`。这些保护需要发起更新的旧版本已包含本实现；此前发布的版本不会因
下载新 ZIP 而提前获得启动拦截能力。

## 变更契约

### Session 或 memory

- `events.jsonl` 继续保持 append-only，并先写事实源再更新派生投影。
- 事件必须携带正确的 space/project/session 绑定和递增 seq。
- compact 必须校验 source hash、scope 与最后 seq。
- DreamAgent evidence 必须引用当前 validated compact 中存在的 event ID。
- 失败不得推进 consolidation 完成状态。

### Harness provider

- 在 provider adapter 内把原生事件翻译成 canonical event。
- 通用 `AgentAdapter` 只新增所有 provider 真正共有的能力。
- provider-specific 历史、模型、usage 或 thread 操作放在可选 control plane。
- cancel、close 和进程退出路径必须有测试，不把断连解释成成功。

### Desktop 协议

- Python backend 的 stdout 只输出 JSONL 协议消息；诊断写 stderr。
- API Key 的读取 DTO 只暴露 `hasApiKey`，不返回原值。
- Renderer 只依赖 preload 暴露的 `CleoClient`，不直接使用 Node 或文件系统。
- 新增事件类型时同步更新 Python projection、TypeScript types 和 smoke fixture。

### 用户可见行为

命令、配置、默认权限、安装路径、数据布局或限制发生变化时，同步更新：

- 根目录中英文 README；
- 对应 `docs/` 专题；
- 配置模板或 `ui/README.md`；
- 面向该行为的测试。

## 提交前完成条件

- 变更只触及完成当前目标所需的文件。
- focused test、完整 pytest、Ruff 与相关 Desktop check 全部通过，或已记录环境限制。
- `git diff --check` 通过，最终 diff 没有 secret、本地状态、生成缓存或意外格式化。
- 新行为有最小回归测试，文档与实现一致。
- 没有把规划能力描述为已经交付。
