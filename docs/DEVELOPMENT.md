# Cleo 开发与发布指南

本指南面向准备修改、测试或发布 Cleo 的贡献者。产品架构先读[架构说明](ARCHITECTURE.md)，后端阅读顺序见[后端代码导读](BACKEND_CODE_REVIEW.md)。

## 技术栈

- Python 3.12+：产品核心、CLI/TUI、session、memory、harness 与 desktop backend。
- Deep Agents、LangChain/LangGraph：通用聊天 agent runtime。
- Textual 与 Rich：终端交互和一次性输出。
- FastMCP：stdio MCP server。
- React 19、TypeScript、Vite、Electron：Windows 桌面客户端。
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
cleo/memory/                  compaction、gate、store、persona、state 与路径
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
```

- `typecheck`：TypeScript project build check。
- `test:backend`：Electron backend/updater 的 Node 单元测试。
- `smoke`：使用确定性 mock 验证 renderer 主流程。
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

`pyproject.toml` 是 Python 直接依赖的唯一手工维护入口。`requirements.txt` 是面向 Python 3.12/Linux 容器生成的精确锁文件，不应手工编辑。

更新锁文件并构建镜像：

```powershell
python scripts\update_project.py
```

只更新锁文件：

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

更新后运行完整 Python 测试，并检查锁文件是否只发生预期变化。

## Docker 开发

```powershell
docker compose build
docker compose run --rm cleo --help
docker compose run --rm cleo "运行一次 smoke task"
```

镜像通过 `requirements.txt` 安装依赖，并默认缓存 memory gate 模型。可用 build arg 覆盖：

```powershell
docker build --build-arg CLEO_MEMORY_GATE_MODEL=<model> -t cleo-ai-agent:local .
docker build --build-arg CLEO_SKIP_MEMORY_MODEL_DOWNLOAD=1 -t cleo-ai-agent:local .
```

Compose 使用 bind mount 读取配置与 workspace，用 named volume 保存 data、memory 和 Codex home。测试后不要把 volume 中的用户数据复制回仓库。

## Windows 桌面发布

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
