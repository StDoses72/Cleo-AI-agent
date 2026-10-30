# 0005. Codex CLI 只随 Python 运行时分发一次

- **Status**: Accepted
- **Date**: 2026-10-30

## Context

每套桌面在线运行环境同时装了两份 Codex CLI：

- Python 侧：`requirements.txt` 锁定的 `openai-codex` 与 `openai-codex-cli-bin`（0.163.0），后者在 `site-packages/codex_cli_bin/bin/` 携带 `codex.exe` 及 Windows sandbox、code-mode host、`rg` 等辅助程序。
- npm 侧：`ui/runtime/package.json` 声明 `@openai/codex`，在线安装与依赖更新都对它 `npm ci`，把平台包 `@openai/codex-win32-x64` 装进 `browser/node_modules`。

#142 在 0.10.3 上实测：两个 `codex.exe` 均为 341,270,320 字节、SHA-256 相同、不是硬链接；npm 侧约 444 MiB。更要紧的是 `scripts/release_dependencies.py` 要求收据里 `@openai/codex` 的版本与 lock 一致，等于把重复分发固化进了发布校验。issue 没有断言 npm 包全局无用，要求先审计所有 shell / PATH、登录、安装器、自更新、MCP 等入口。

## Decision

**以 Python 配套 CLI 为 Codex 二进制的唯一受控来源，移除 npm 分发，并让发布校验拒绝它回流。**

审计结果（当前 `main`，不是 issue 里 pin 的旧 commit）：

| 入口 | 二进制解析方式 | 结论 |
| --- | --- | --- |
| `openai_codex/client.py::_resolve_codex_bin` | `CodexConfig.codex_bin`，否则 `codex_cli_bin.bundled_codex_path()`；从不查 PATH | 不依赖 npm |
| `cleo/integrations/harnesses/codex.py::CodexProvider._client` | `CLEO_CODEX_BIN` → `config.codex_bin`，否则 SDK 默认 | 不依赖 npm |
| `cleo/integrations/subscriptions.py::executable`（登录、模型枚举） | `profile.executable` 或 `CLEO_CODEX_BIN`，否则 `shutil.which("codex")` | 打包版始终有 `CLEO_CODEX_BIN`；源码运行回退到用户系统 PATH，与改动前相同 |
| `cleo/desktop/subscription_login.py`、`inspect_connection`、`cleo/mcp/codex_server.py`、`cleo/agents/tools/codex_tools.py` | `AsyncCodex(config)` | SDK 默认解析 |
| `ui/electron/dependencies.mjs::resolveCodexBinary` → `backend.mjs` / `release-repair.mjs` | `validate_codex_runtime()` 返回 `bundled_codex_path()`，以 `CLEO_CODEX_BIN` 传给后端；失败即启动失败 | 不会静默落到 PATH |
| `ui/electron/setup-manager.mjs`、`scripts/installer-check.py`、`cleo/desktop/dependencies.py::validate_runtime` | Python 侧校验 SDK / CLI 版本一致 + `agent-browser --version` | npm 侧只校验 agent-browser |
| `ui/electron/platform.mjs::harnessPath` | 把 `browser/node_modules/.bin` 加入后端 PATH | npm `codex` shim 唯一可能被找到的位置；实际消费者只有 `cleo/agents/tools/browser_tools.py` 用的 `agent-browser` shim |
| `cleo/desktop/dependencies.py::update`（每日自更新） | 对 `browser/package.json` 跑 `npm update --package-lock-only` 再 `npm ci` | 跟随 manifest；声明删掉后不会装回 |
| `scripts/release_dependencies.py`、`.github/workflows/publish-release.yml` | 收据校验 | 需要修改 |

改动：`ui/runtime/package.json` / `package-lock.json` 用 `npm uninstall @openai/codex --package-lock-only` 去掉依赖（其余版本不变）；`scripts/release_dependencies.py` 的 `BROWSER_TOOLS` 只剩 `agent-browser` 与 `npm`，新增 `DUPLICATE_CLI_PACKAGES`，打包的 `browser/node_modules/@openai/codex` 或 runtime lock 里再出现它就拒绝生成收据；`docs/DEVELOPMENT.md` 写明唯一来源与 `.bin` 的用途。

## Alternatives considered

- **保留 npm 分发，去掉 Python 的 `openai-codex-cli-bin`。** 否决：Python SDK 的默认解析、`validate_codex_runtime` 的 SDK / CLI 版本一致性校验、`CLEO_CODEX_BIN` 的传递链都建立在 Python 配套 CLI 上；npm 包与 SDK 版本之间没有任何校验关系，换过去要重做整条解析链并失去版本一致性保证。
- **两份都保留，用硬链接或共享不可变组件去重。** 否决：issue 自己也把它列为备选并要求先证明更新、卸载、权限与跨平台行为安全；仅凭 hash 相同不能替换，而且在没有消费者的情况下为一份多余的二进制设计共享机制没有意义。
- **只删 npm 包里的 `codex.exe`，保留包的其余部分。** 否决：审计表明包的任何部分都没有消费者；部分删除还会让 `npm ci` 的完整性校验失败。
- **把 `browser/node_modules/.bin` 从 PATH 移除以杜绝 shim 回退。** 否决（不在本 PR 做）：`agent-browser` 的 shim 依赖它；源码运行时 `subscriptions.executable` 回退到系统 PATH 是既有行为，与 npm 包无关。
- **在收据里保留 `@openai/codex` 为可选项。** 否决：issue 要求"自动依赖更新不会重新引入重复分发"，可选项挡不住回流；改为反向检查。

## Consequences

- 正面：每套在线运行环境少一份约 0.4 GiB 的重复二进制（以 issue 的 Windows 实测为预期值）；Codex 二进制只有一个来源，SDK / CLI 版本一致性校验覆盖全部入口；发布收据会在重复分发回流时失败。
- 负面 / 限制：源码运行（无 `CLEO_CODEX_BIN`）的登录 / 模型枚举仍可能用到系统 PATH 上的 `codex`，与改动前一致；本 PR 没有做四平台隔离安装的体积与文件清单对比，也没有因此重跑 Codex 登录 / 任务 / 恢复的真实流程（解析路径未变，由 `tests/integrations/test_codex_runtime.py` 覆盖 `CLEO_CODEX_BIN` 优先级）。
- 后续工作：发布时在隔离安装里实测 Windows / Linux / macOS 的压缩包与落盘体积变化；旧环境的退役由 #141 处理，两者的空间收益不能简单相加。

## References

- PR #156，issue #142；相关 #141（旧环境退役）。
- `ui/runtime/package.json`、`scripts/release_dependencies.py`、`tests/scripts/test_release_dependencies.py`、`cleo/desktop/dependencies.py`、`ui/electron/dependencies.mjs`、`ui/electron/platform.mjs`、`cleo/integrations/subscriptions.py`。
- `docs/DEVELOPMENT.md` "依赖管理" 段落。
