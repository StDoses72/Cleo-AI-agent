# 架构审查与重构记录 · 2026-09-06

## 发现与处理

1. **[P1，已修复] manifest 写入失败可使后续事件序号重复，导致会话无法读取。**
   位置：`cleo/sessions/store.py:474`、`:805`、`:877`。
   事件已落盘但 manifest 原子替换失败时，旧实现从落后的 `last_event_seq` 分配下一序号，
   产生 `[1, 2, 2]`；`load_events` 随后抛出 `session event sequence is not strictly increasing`。
   现从事件日志及其元数据缓存恢复已提交序号，重复事件重试也会修正 manifest；迁移与 compact
   使用真实日志序号，compact 在同一 store 的锁内完成快照与投影更新。
   回归位置：`tests/sessions/test_store.py:15`、`:49`。先确认四个追加恢复用例失败，再修复；
   六个故障用例覆盖重启、重复/新事件、项目迁移与投影重建。

2. **[P2，已处理] 通用 harness 编排直接选择存储实现和 ACP provider。**
   旧位置：`cleo/harnesses/adapter.py` 的构造器与 `register_acp`。
   现位置：`cleo/harnesses/service.py:39`、`cleo/sessions/ports.py:8`、
   `cleo/harnesses/adapter.py:15`。用例代码依赖 `AgentProvider`、`SessionRepository` 两个
   Protocol；原构造器和 ACP 便捷 API 留在兼容装配层。没有新增 DI 容器、通用 Repository
   框架或为单次调用制造接口。存储仍实现原来的字典/JSONL/SQLite 契约。

3. **[P2，已处理] Desktop 反向依赖 CLI，事件数据解析又依赖 Rich renderer。**
   位置：`cleo/desktop/service.py:31`、`:42`、`:836`、`:980`；
   `cleo/desktop/projection.py:11`。共享事件投影移至 `harnesses/events.py`，内容规则移至
   `sessions/policy.py`，进程和工作目录操作移至 `integrations/{background,workspace}.py`。
   CLI 保留调用入口，桌面模块不再导入 CLI。

4. **[P3，已处理] 前端装配点暴露两个具体 client 的推导类型。**
   位置：`ui/src/services/cleoClient.ts:5`。显式返回已有 `CleoClient` interface，IPC 与 mock
   继续实现同一接口；React 组件、文案、样式和交互逻辑没有改动。

## 保留的行为与架构取舍

- 保留功能目录，按模块划分 domain、application、infrastructure 和 presentation，说明见
  [架构说明](ARCHITECTURE.md)。不以目录迁移数量作为重构目标。
- 逐方法比较 Git 基线与新 `AgentService` 的 AST，33 个迁移的业务方法执行主体一致；
  构造与 ACP 注册负责装配，单独保留在兼容入口。
- provider 的可选控制能力、CLI/MCP/IPC 入口、配置字段、权限默认值、用户数据路径和持久化
  schema 保持原样。异常恢复修复是本次唯一有意改变的运行行为。
- `AgentService` 仍负责已有的工作目录输入验证；`SessionStore` 是基础设施实现，
  `agents/`、`memory/`、`Runtime` 也仍含具体框架或 I/O。此次没有把整个仓库宣称为纯 domain。
- 兼容入口存在于原路径，新增编排写进 service，新增 provider 装配写进现有 factory。

## 验证

- 修改前完整 Python 基线：188 passed。
- 最终完整 Python：199 passed（76.64s）。
- Session / memory 专项：39 passed；存储 port 签名、无磁盘用例、无 SDK/CLI/config 导入验证通过。
- Ruff（`cleo tests scripts/build-release.py`）、TypeScript 严格检查、Vite 生产构建通过。
- Electron 单元测试：34 passed、2 个 POSIX 用例在 Windows 跳过。
- 下载目标测试：10 passed；下载脚本：7 passed、3 个 POSIX 用例跳过。
- 现有桌面 Playwright smoke：通过，console errors 为空；覆盖聊天、审批允许/拒绝、记忆队列、
  模型选择、附件、运行结果、错误恢复、删除确认、紧凑窗口布局。
- 真实 Python JSONL IPC：隔离模板配置下加载工作区、重命名、重新读取、正常 shutdown 通过；
  没有调用真实 LLM 或读取用户凭据。
- 最终 `git diff --check` 通过。测试产物位于工作区外的临时目录，构建缓存被 Git 忽略，均不属于提交内容。

## 覆盖范围与限制

本次是全仓库范围的架构盘点与定向代码审查，**不是完整的逐文件、逐行正确性审计**。
下面列出所有 tracked/untracked 仓库自有文件，并区分完整阅读、依赖/职责盘点和仅清点。
Python 文件全量解析了 AST/import，前端脚本检查了 import 边界；这些自动检查不等于人工
理解每个分支。未逐行阅读的测试、UI 组件、安装脚本和文档不计入完整代码审查。
基线工作树干净，没有用户的未提交修改或已删除文件。第三方依赖、现有缓存、release、
构建产物和被 Git 忽略的私有配置/用户数据不属于审查清单。

限制：未运行 macOS/Linux 原生构建与安装，没有验证在线模型/SDK 服务；现有单 session
单 writer 假设不变。本次预防新的序号损坏，不重写用户已有的损坏事件日志。memory、
runtime 和大型 Desktop/React 模块的进一步拆分需要沿实际用例继续审查，不建议机械加接口。

清单共 **212** 个文件：依赖/职责盘点；非逐行审阅 145；完整阅读 62；清点；未审阅内容 4；交付文档 1。

### .github

| 文件 | 深度 |
| --- | --- |
| `.github/workflows/desktop-platforms.yml` | 完整阅读 |
| `.github/workflows/download-page.yml` | 完整阅读 |

### cleo

| 文件 | 深度 |
| --- | --- |
| `cleo/__init__.py` | 依赖/职责盘点；非逐行审阅 |

### cleo/agents

| 文件 | 深度 |
| --- | --- |
| `cleo/agents/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/cleo.py` | 完整阅读 |
| `cleo/agents/dream.py` | 完整阅读 |
| `cleo/agents/tools/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/tools/browser_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/tools/codex_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/tools/dream_agent_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/tools/memory_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/tools/shell_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/agents/tools/web_search_tools.py` | 依赖/职责盘点；非逐行审阅 |

### cleo/cli

| 文件 | 深度 |
| --- | --- |
| `cleo/cli/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/application.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/chat.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/chat_tui.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/console.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/context.py` | 完整阅读 |
| `cleo/cli/dream_worker.py` | 完整阅读 |
| `cleo/cli/lifecycle.py` | 完整阅读 |
| `cleo/cli/productivity.py` | 完整阅读 |
| `cleo/cli/productivity_history.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/productivity_renderer.py` | 完整阅读 |
| `cleo/cli/productivity_tui.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/cli/workspace.py` | 完整阅读 |

### cleo/config

| 文件 | 深度 |
| --- | --- |
| `cleo/config/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/config/settings.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/config/templates/cleo.example.json` | 依赖/职责盘点；非逐行审阅 |
| `cleo/config/templates/harnesses.example.json` | 依赖/职责盘点；非逐行审阅 |

### cleo/desktop

| 文件 | 深度 |
| --- | --- |
| `cleo/desktop/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/desktop/configuration.py` | 完整阅读 |
| `cleo/desktop/projection.py` | 完整阅读 |
| `cleo/desktop/server.py` | 完整阅读 |
| `cleo/desktop/service.py` | 完整阅读 |

### cleo/harnesses

| 文件 | 深度 |
| --- | --- |
| `cleo/harnesses/__init__.py` | 完整阅读 |
| `cleo/harnesses/adapter.py` | 完整阅读 |
| `cleo/harnesses/control.py` | 完整阅读 |
| `cleo/harnesses/events.py` | 完整阅读 |
| `cleo/harnesses/models.py` | 完整阅读 |
| `cleo/harnesses/provider.py` | 完整阅读 |
| `cleo/harnesses/service.py` | 完整阅读 |

### cleo/images

| 文件 | 深度 |
| --- | --- |
| `cleo/images/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/images/assets/cleo-startup.png` | 清点；未审阅内容 |
| `cleo/images/portrait.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/images/sixel_encoder.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/images/sixel_renderable.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/images/startup.py` | 依赖/职责盘点；非逐行审阅 |

### cleo/integrations

| 文件 | 深度 |
| --- | --- |
| `cleo/integrations/__init__.py` | 完整阅读 |
| `cleo/integrations/background.py` | 完整阅读 |
| `cleo/integrations/codex.py` | 完整阅读 |
| `cleo/integrations/git.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/integrations/harnesses/__init__.py` | 完整阅读 |
| `cleo/integrations/harnesses/acp.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/integrations/harnesses/claude.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/integrations/harnesses/codex.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/integrations/harnesses/codex_approvals.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/integrations/harnesses/factory.py` | 完整阅读 |
| `cleo/integrations/harnesses/memory.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/integrations/workspace.py` | 完整阅读 |

### cleo/mcp

| 文件 | 深度 |
| --- | --- |
| `cleo/mcp/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/mcp/codex_server.py` | 完整阅读 |
| `cleo/mcp/memory_server.py` | 完整阅读 |

### cleo/memory

| 文件 | 深度 |
| --- | --- |
| `cleo/memory/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/memory/compaction.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/memory/overview.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/memory/paths.py` | 完整阅读 |
| `cleo/memory/persona.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/memory/reader.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/memory/state.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/memory/store.py` | 依赖/职责盘点；非逐行审阅 |

### cleo/runtime

| 文件 | 深度 |
| --- | --- |
| `cleo/runtime/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/runtime/state.py` | 完整阅读 |
| `cleo/runtime/usage.py` | 完整阅读 |

### cleo/sessions

| 文件 | 深度 |
| --- | --- |
| `cleo/sessions/__init__.py` | 依赖/职责盘点；非逐行审阅 |
| `cleo/sessions/hub.py` | 完整阅读 |
| `cleo/sessions/policy.py` | 完整阅读 |
| `cleo/sessions/ports.py` | 完整阅读 |
| `cleo/sessions/store.py` | 完整阅读 |

### data

| 文件 | 深度 |
| --- | --- |
| `data/.gitkeep` | 依赖/职责盘点；非逐行审阅 |
| `data/runtime_example.json` | 依赖/职责盘点；非逐行审阅 |

### docker

| 文件 | 深度 |
| --- | --- |
| `docker/requirements.Dockerfile` | 依赖/职责盘点；非逐行审阅 |

### docs

| 文件 | 深度 |
| --- | --- |
| `docs/ARCHITECTURE.en.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/ARCHITECTURE.md` | 完整阅读 |
| `docs/ARCHITECTURE_REVIEW_2026-09-06.md` | 交付文档 |
| `docs/BACKEND_CODE_REVIEW.md` | 完整阅读 |
| `docs/CASTMIND_MEMORY_MIGRATION.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/CONFIGURATION.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/Cleo_Runtime_State_Maintenance_Guide.docx` | 清点；未审阅内容 |
| `docs/DEVELOPMENT.md` | 完整阅读 |
| `docs/GETTING_STARTED.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/MEMORY_READING.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/PLATFORMS.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/README.md` | 依赖/职责盘点；非逐行审阅 |
| `docs/UX_REVIEW_2026-09-05.md` | 依赖/职责盘点；非逐行审阅 |

### download

| 文件 | 深度 |
| --- | --- |
| `download/.gitattributes` | 依赖/职责盘点；非逐行审阅 |
| `download/site/app.mjs` | 依赖/职责盘点；非逐行审阅 |
| `download/site/download.ps1` | 依赖/职责盘点；非逐行审阅 |
| `download/site/download.sh` | 依赖/职责盘点；非逐行审阅 |
| `download/site/index.html` | 依赖/职责盘点；非逐行审阅 |
| `download/site/style.css` | 依赖/职责盘点；非逐行审阅 |
| `download/site/targets.mjs` | 依赖/职责盘点；非逐行审阅 |
| `download/tests/browser.mjs` | 依赖/职责盘点；非逐行审阅 |
| `download/tests/targets.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `download/tests/test_scripts.py` | 依赖/职责盘点；非逐行审阅 |

### memory

| 文件 | 深度 |
| --- | --- |
| `memory/MEMORY_POLICY.md` | 依赖/职责盘点；非逐行审阅 |

### scripts

| 文件 | 深度 |
| --- | --- |
| `scripts/build-release.mjs` | 完整阅读 |
| `scripts/build-release.ps1` | 依赖/职责盘点；非逐行审阅 |
| `scripts/build-release.py` | 依赖/职责盘点；非逐行审阅 |
| `scripts/clean-runtime.cmd` | 依赖/职责盘点；非逐行审阅 |
| `scripts/clean-runtime.ps1` | 依赖/职责盘点；非逐行审阅 |
| `scripts/download.ps1` | 依赖/职责盘点；非逐行审阅 |
| `scripts/uninstall.ps1` | 依赖/职责盘点；非逐行审阅 |
| `scripts/update-progress.ps1` | 依赖/职责盘点；非逐行审阅 |
| `scripts/update_project.py` | 依赖/职责盘点；非逐行审阅 |

### skills

| 文件 | 深度 |
| --- | --- |
| `skills/agent-browser/SKILL.md` | 依赖/职责盘点；非逐行审阅 |
| `skills/agent-browser/agents/openai.yaml` | 依赖/职责盘点；非逐行审阅 |
| `skills/demo-production/SKILL.md` | 依赖/职责盘点；非逐行审阅 |
| `skills/demo-production/agents/openai.yaml` | 依赖/职责盘点；非逐行审阅 |

### tests

| 文件 | 深度 |
| --- | --- |
| `tests/test_boundaries.py` | 完整阅读 |

### tests/agents

| 文件 | 深度 |
| --- | --- |
| `tests/agents/test_browser_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/agents/test_cleo.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/agents/test_dream.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/agents/test_shell_tools.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/agents/test_web_search_tools.py` | 依赖/职责盘点；非逐行审阅 |

### tests/cli

| 文件 | 深度 |
| --- | --- |
| `tests/cli/test_application.py` | 完整阅读 |
| `tests/cli/test_chat_tui.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/cli/test_console.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/cli/test_context.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/cli/test_lifecycle.py` | 完整阅读 |
| `tests/cli/test_productivity_history.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/cli/test_productivity_tui.py` | 依赖/职责盘点；非逐行审阅 |

### tests/config

| 文件 | 深度 |
| --- | --- |
| `tests/config/test_directories.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/config/test_settings.py` | 依赖/职责盘点；非逐行审阅 |

### tests/desktop

| 文件 | 深度 |
| --- | --- |
| `tests/desktop/test_configuration.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/desktop/test_projection.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/desktop/test_service.py` | 依赖/职责盘点；非逐行审阅 |

### tests/images

| 文件 | 深度 |
| --- | --- |
| `tests/images/test_terminal.py` | 依赖/职责盘点；非逐行审阅 |

### tests/integrations

| 文件 | 深度 |
| --- | --- |
| `tests/integrations/test_codex_facade.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/integrations/test_git.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/integrations/test_harness_factory.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/integrations/test_harnesses.py` | 完整阅读 |
| `tests/integrations/test_memory_mcp.py` | 依赖/职责盘点；非逐行审阅 |

### tests/memory

| 文件 | 深度 |
| --- | --- |
| `tests/memory/test_overview.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/memory/test_persona.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/memory/test_pipeline.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/memory/test_reader.py` | 依赖/职责盘点；非逐行审阅 |

### tests/runtime

| 文件 | 深度 |
| --- | --- |
| `tests/runtime/test_state.py` | 依赖/职责盘点；非逐行审阅 |

### tests/scripts

| 文件 | 深度 |
| --- | --- |
| `tests/scripts/test_download.py` | 依赖/职责盘点；非逐行审阅 |

### tests/sessions

| 文件 | 深度 |
| --- | --- |
| `tests/sessions/test_hub.py` | 依赖/职责盘点；非逐行审阅 |
| `tests/sessions/test_ports.py` | 完整阅读 |
| `tests/sessions/test_store.py` | 完整阅读 |

### ui

| 文件 | 深度 |
| --- | --- |
| `ui/README.md` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/attachments.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/attachments.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/backend.mjs` | 完整阅读 |
| `ui/electron/backend.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/install-state.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/install-state.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/local-files.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/local-files.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/main.mjs` | 完整阅读 |
| `ui/electron/platform.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/platform.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/posix-installer.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/posix-installer.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/preload.cjs` | 完整阅读 |
| `ui/electron/updater.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/electron/updater.test.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/index.html` | 依赖/职责盘点；非逐行审阅 |
| `ui/package-lock.json` | 清点；未审阅内容 |
| `ui/package.json` | 完整阅读 |
| `ui/public/cleo.png` | 清点；未审阅内容 |
| `ui/scripts/smoke-inspector.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/scripts/smoke-packaged.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/scripts/smoke-real.mjs` | 完整阅读 |
| `ui/scripts/smoke-update.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/scripts/smoke-ux.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/scripts/smoke.mjs` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/App.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/ApprovalPrompt.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/Conversation.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/Inspector.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/MemoryView.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/Overlays.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/ThreadSidebar.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/components/WorkspaceRail.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/index.css` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/main.tsx` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/platform.ts` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/services/cleoClient.ts` | 完整阅读 |
| `ui/src/services/ipcCleoClient.ts` | 完整阅读 |
| `ui/src/services/mockCleoClient.ts` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/services/mockData.ts` | 依赖/职责盘点；非逐行审阅 |
| `ui/src/types.ts` | 完整阅读 |
| `ui/src/useCleoWorkspace.ts` | 完整阅读 |
| `ui/src/vite-env.d.ts` | 依赖/职责盘点；非逐行审阅 |
| `ui/tsconfig.json` | 完整阅读 |
| `ui/vite.config.ts` | 完整阅读 |

### 根目录

| 文件 | 深度 |
| --- | --- |
| `.dockerignore` | 依赖/职责盘点；非逐行审阅 |
| `.gitattributes` | 依赖/职责盘点；非逐行审阅 |
| `.gitignore` | 依赖/职责盘点；非逐行审阅 |
| `AGENTS.md` | 完整阅读 |
| `Dockerfile` | 完整阅读 |
| `LICENSE` | 依赖/职责盘点；非逐行审阅 |
| `PERSONA.md` | 依赖/职责盘点；非逐行审阅 |
| `README.en.md` | 依赖/职责盘点；非逐行审阅 |
| `README.md` | 依赖/职责盘点；非逐行审阅 |
| `compose.yaml` | 完整阅读 |
| `main.py` | 依赖/职责盘点；非逐行审阅 |
| `pyproject.toml` | 完整阅读 |
| `requirements.txt` | 完整阅读 |
