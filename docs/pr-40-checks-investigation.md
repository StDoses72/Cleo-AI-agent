# PR #40 检查调查与本地修复

调查对象：[PR #40](https://github.com/StDoses72/Cleo-AI-agent/pull/40/checks)。
冻结验收：`76858132-57fd-4a38-934d-6ba937d3f03a` /
`10c390b8-f234-4f35-b5e3-2a0e03c1b5cd`（人工；尚未通过）。

## 远端实际证据

- PR head：`219af2cbcae1b74274c3d6a60f07f61aea1e0848`。
- Actions checkout 的测试合并提交：`a4a7935c3a78012aed9e07e536c7e93a29d36524`。
- [Desktop platforms #41](https://github.com/StDoses72/Cleo-AI-agent/actions/runs/34674428936)，四项均已结束并失败，没有一直排队或运行。
- GitHub 返回 PR 状态为 closed、merged=false，关闭时间为 `2026-09-12T17:35:18Z`。

| 检查名称 | 日志 | 失败步骤及证据 |
| --- | --- | --- |
| desktop (windows-latest, windows-x64) | [103501626206](https://github.com/StDoses72/Cleo-AI-agent/actions/runs/34674428936/job/103501626206) | Ruff；46 个 E501、4 个 I001，Found 50 errors |
| desktop (macos-15-intel, macos-x64) | [103501626264](https://github.com/StDoses72/Cleo-AI-agent/actions/runs/34674428936/job/103501626264) | Ruff；46 个 E501、4 个 I001，Found 50 errors |
| desktop (macos-14, macos-arm64) | [103501626325](https://github.com/StDoses72/Cleo-AI-agent/actions/runs/34674428936/job/103501626325) | Ruff；46 个 E501、4 个 I001，Found 50 errors |
| desktop (ubuntu-24.04, linux-x64) | [103501626351](https://github.com/StDoses72/Cleo-AI-agent/actions/runs/34674428936/job/103501626351) | Ruff；46 个 E501、4 个 I001，Found 50 errors |

四个平台执行的失败命令相同：

```text
ruff check cleo tests scripts/build-release.py scripts/update_project.py
```

Ruff 版本均为 0.16.7。共同根因是提交的 Python 源码不符合项目已有的
100 字符行长及导入排序规则。例子：`cleo/agents/profiles.py:51` 为
`E501 Line too long (105 > 100)`；`cleo/desktop/evolution_planning.py:3`
为 `I001 Import block is un-sorted or un-formatted`。

全部 50 条诊断涉及：

- `cleo/agents/profiles.py`
- `cleo/desktop/evolution_planning.py`
- `cleo/desktop/service.py`
- `tests/agents/test_dream.py`
- `tests/desktop/check_task_harness_compatibility.py`
- `tests/desktop/test_evolution_planning.py`
- `tests/desktop/test_service.py`
- `tests/desktop/test_task_harness_selection.py`
- `tests/integrations/smoke_agent_mcp.py`
- `tests/memory/check_dream_compatibility.py`

四个平台依赖安装均成功。pytest、Node 回归、前端构建、桌面冒烟和适用的原生打包步骤
因 Ruff 失败而未执行。因此这些日志不能证明后续步骤成功，也没有提供平台特有故障的证据。
重跑不变的提交仍会遇到相同错误。

## 本轮修复及边界

当前工作区 HEAD 是 `0068419def50fcd385868a2d62c7d945002fe5eb`，是 PR head 的后续提交，
已经包含原来 50 条诊断的修正及本地 lint 阻断打包的检查。
本轮开始时还有其他未提交的需求分析/UI 改动；保留这些既有改动。

对本轮开始时的工作区运行 CI 同范围 Ruff，实际得到 6 条 E501：
`cleo/desktop/evolution_planning.py` 5 条，`tests/desktop/test_evolution_planning.py` 1 条。
本轮只调整这两处文件的长行排版和相邻字符串书写方式。
修改前后 AST 完全一致，包括提示词、证据文本、条件及断言的值。
没有放宽规则、增加忽略、降低断言或修改受保护控制器。

未修改任何持久化格式、读写行为、真实会话或记忆；没有运行数据迁移。
本轮未运行旧版数据格式往返测试，因为此次修改没有改变格式或程序语义。
验证使用临时测试数据；没有修改 CLEO_HOME/userData 的持久配置。

## 实际验证

| 验证 | 结果与限制 |
| --- | --- |
| 从 git 读取 PR head 的上述 10 个文件，逐一传入 Ruff 标准输入 | Ruff 0.15.11 同样复现 46 E501 + 4 I001，共 50 条；未覆盖工作区文件 |
| 工作区 CI 同范围 Ruff 命令 | 修改前 6 E501；修改后 All checks passed，退出码 0 |
| 两个修改文件的修改前后 AST 比较 | 通过，包括精确字符串值，语义不变 |
| Python 全套 pytest -q | 380 passed、1 failed、1 skipped、9 subtests passed；失败为 tests/scripts/test_download.py 的 Windows 安装测试，Get-CimInstance 拒绝访问（HRESULT 0x80041003）；随后临时 npm 缓存清理还报告目录非空 |
| npm --prefix ui run test:backend | 38 passed、1 failed、2 skipped；Windows restart-install 测试同样被 Get-CimInstance 权限拒绝阻断 |
| npm --prefix ui run test:evolution | 无完整结果；真实子进程取消测试未退出，已中断；增加诊断用 30 秒超时也未得到完整结果，未修改测试或规则 |
| 独立 taskkill 探针，仅针对本轮创建的临时 Node 子进程 | taskkill /PID /T /F 返回 1、拒绝访问；随后用子进程句柄结束并回收该探针进程，支持上述取消测试受本地权限影响的判断 |
| 原有 Python lint errors fail locally before packaging 测试 | 1 passed；只运行该命名用例，不能代替完整进化回归 |
| evolution-acceptance.test.mjs + evolution-requests.test.mjs | 19 passed；覆盖冻结、人工案例不自动通过、旧 Dream 回归继续调用、重试恢复、版本绑定等 |
| npm --prefix ui run build | tsc -b 和 Vite 均成功，退出码 0；仍有非阻断的大体积 chunk 提示 |
| node ui/scripts/smoke.mjs | 未通过：Electron 启动阶段 Target crashed；此前检查未发现 node_modules/electron/dist/electron.exe；没有获得 UI 断言结果 |
| node ui/scripts/check-dream-regressions.mjs | 未执行回放：当前共享套件没有 enabled 的 dream-format 案例，脚本明确报 No frozen Dream regressions available；没有修改套件或制造通过结果 |
| git diff --check | 通过 |

本地使用已安装的 Ruff 0.15.11；尝试在临时工具目录安装 CI 使用的 0.16.7，
连接 PyPI 时被网络权限拒绝（os error 10013）。没有改动依赖锁或将 CI 降级。
Python 使用已有依赖的打包解释器，pytest 等测试工具来自本地缓存，在临时 CLEO_HOME
中运行，并关闭自动发现的外部 pytest 插件；这不是 GitHub 干净 runner 环境的等价替代。

## 尚未完成的验收

本轮没有提交、推送、重开 PR、发布版本或触发桌面应用/保存。
修复没有出现在 PR #40 的旧 head 上，也没有修复提交对应的四平台绿色运行链接。
四个平台新提交上的完整 CI、原生打包和桌面冒烟仍待验证；上述人工验收不能标记通过。
结论限于：已查明原四项共同失败的根因，并修复当前工作区同类问题，尚不能宣称四平台已根治。
