# PR #49 冲突调查与修复

## 已取得的远端证据

- PR：<https://github.com/StDoses72/Cleo-AI-agent/pull/49>
- 源：`zhouk2-blip/Cleo-AI-agent:codex/pr-d2b33463-1b01-4a42-84a0-9b92f9a06040`
- 原始源提交：`bb74fe60d387bd82745b41366f5134b85c98be0a`（Apply local Cleo improvements）
- 目标：`StDoses72/Cleo-AI-agent:PR&SKILLS`
- 检查目标：`4e6a74737940bb0ccf9a16a9bfdb5a6d96157ef9`
- 共同祖先：`1e21834cc76894789b3de169b1b46fef83fa9ad4`
- GitHub 初查：open、未合并、`mergeable=false`；源只有一个提交，140 个变更文件。

目标在共同祖先后有四个提交：`f140500`（add self-evolving mechanism）、
`106b21d`（add gitignore）、`cc76cf5`（new）、`4e6a747`（self-evolving perfection）。
源提交的唯一父提交仍是共同祖先，没有这些上游提交。
证据 API：
<https://api.github.com/repos/StDoses72/Cleo-AI-agent/compare/1e21834cc76894789b3de169b1b46fef83fa9ad4...4e6a74737940bb0ccf9a16a9bfdb5a6d96157ef9>。

## 复现方法与实际冲突

环境禁止 shell 连接 github.com；经 GitHub 连接器读取完整目标树和缺失的 27 个 blob。
在临时克隆中逐个用 `git hash-object` 校验 blob，重建的 `git write-tree` 严格等于
远端树 `71b8e59fbca060ca2f4e7fe9f302f15dc4b80f0b`。
为了避免伪称获取了完整 Git pack，复现使用该精确目标树的临时合成提交，
父提交指定为 API 已证实的共同祖先；源使用真实 `bb74fe6`。
`git merge-tree --write-tree --name-only <真实源> <精确目标树的合成提交>`
返回 1，产生以下 21 个冲突。三方合并使用的源树、目标树、共同祖先树均与远端条件一致。

| 类型 | 文件 |
| --- | --- |
| content | `cleo/desktop/service.py` |
| content | `ui/electron/main.mjs` |
| content | `ui/src/App.tsx` |
| content | `ui/src/components/Conversation.tsx` |
| content | `ui/src/useCleoWorkspace.ts` |
| add/add | `docs/cleo-evolution.md` |
| add/add | `ui/electron/evolution-acceptance.mjs` |
| add/add | `ui/electron/evolution-acceptance.test.mjs` |
| add/add | `ui/electron/evolution-store.mjs` |
| add/add | `ui/electron/evolution-tools.mjs` |
| add/add | `ui/electron/evolution.mjs` |
| add/add | `ui/scripts/smoke-evolution-github.mjs` |
| add/add | `ui/scripts/smoke-evolution.mjs` |
| add/add | `ui/src/components/EvolutionCases.tsx` |
| add/add | `ui/src/components/EvolutionPanel.tsx` |
| add/add | `ui/src/components/evolution.css` |
| add/add | `ui/src/evolution-types.ts` |
| add/add | `ui/src/useEvolution.ts` |
| add/add | `ui/tests/evolution-manager.test.mjs` |
| add/add | `ui/tests/evolution-store.test.mjs` |
| add/add | `ui/tests/evolution-submit.test.mjs` |

## 原因与逐组取舍

不是从本地 status 推断远端：两边实际历史已分叉。双方独立引入同名自迭代文件，
本地又继续演进；压成一个提交后，Git 无法把目标中的早期实现识别为源的祖先。
原提交方法只验证目标存在，然后把当前 HEAD 推送到独立分支，没有 fetch/三方合并预检。

- 自迭代管理、store、tools：保留源中的既有独立 PR/重试、Python lint 门禁、
  Windows 原子写重试与日志处理。所有受保护控制器相对于源保持字节不变。
- 验收模块、Cases、App/main 和对应回归：保留源已实现的冻结需求、人工确认、
  反馈/重试以及由桌面负责构建的流程；不退回目标的旧接口，不改现有测试预期。
- Conversation/useCleoWorkspace：保留源的本机 skills、运行任务切换及流式状态隔离。
- useEvolution、提交测试/smoke：保留源的提交回执恢复、新意图独立 PR 和 CI 分离。
- service/Dream：目标的格式纠正与 schema 限制已经存在于源；源后来采用原始事件读取，
  解决晚到 turn_diff 而不重写 compact 缓存。保留源行为及未知字段回归，
  不重新引入目标的 `refresh_compact` 写入。旧目标测试中要求刷新 compact 的语义
  与当前“缓存不重写”回归不兼容，明确以当前数据兼容要求为准；不声称旧语义同时满足。
- `.gitignore`、`.dockerignore`：补回目标独有的运行数据、workspace、打包与缓存忽略规则。
- 文档：保留当前验收策略，补回仍适用的流式 SHA-256 与隔离回放说明；
  旧版“必须人工验收后才能应用”已经被源的“先应用体验、确认后保存”替代，不恢复旧规则。

修复提交必须以原始源和真实目标 SHA 为双父提交，向原源分支非强制 fast-forward 更新。
这样建立真实祖先关系，不能用整树复制或仅删除冲突标记替代。

## 验证边界

新增逻辑只在临时 Git 克隆及内存中工作，既有持久化读写器、schema、默认值均未修改。
聊天、记忆、配置、skills、CLEO_HOME、Electron userData 不参与合并检查。
没有新增共享格式，因此没有宣称执行旧/新写入器往返迁移；保留现有存储回归。
自动化结果与远端修复 SHA 见本次交付说明；桌面冻结的四个人工案例仍待人工核对，
不会由单元测试或 GitHub 的 mergeable 状态自动标为通过。

### 本次实际结果

- `node ui/node_modules/typescript/bin/tsc -b ui --force`：通过，使用本机已安装 TypeScript。
- `node ui/node_modules/vite/bin/vite.js build ui`：通过；保留现有大 chunk 提示，未改变检查规则。
- `node ui/tests/contribution-merge.smoke.mjs`：通过；只启动隔离组件页面，没有启动 Electron。
- 81 个相关 Node 回归通过，零失败、零跳过：`evolution-submit`、`evolution-merge-assistance`、
  `evolution-behavior-policy`、`evolution-interactions`、`evolution-json`、`evolution-store`，
  以及 electron 下的 `evolution-acceptance` 和 `evolution-requests` 测试。
- 全量 `evolution-*.test.mjs` 尝试停在既有 GitHub 登录/子进程测试附近，没有完整结束；
  带 60 秒 test timeout 的诊断运行也未正常退出，已停止。未删除、跳过或弱化这些检查，
  未修改受保护代码；因此不能声称全量回归通过或桌面已可应用。
- 本地修复源码树在加入双方父关系的隔离模拟后，`git merge-tree` 返回 0，无冲突。
  模拟使用精确树与已证实共同祖先，不能冒充一个已经发布的真实修复提交。
- GitHub 最后查询仍是原源 `bb74fe6` 对目标 `4e6a747`，`mergeable=false`。
  创建远端 Git tree 的请求被拒绝：`MCP tool call requires approval, but approval policy is never`。
  没有创建远端修复提交、更新源分支或最终合并；原 PR 的远端修复仍未完成。
- 本次保留所有既有读写代码和回归文件，没有执行 live data 迁移或跨版写入。
- 临时清理命令被环境策略拒绝（`blocked by policy`），未改用其他渠道绕过。
  取证副本保留于 `%TEMP%/cleo-pr49-investigation-9be2e54f`，blob/复现脚本保留于
  源码下已被忽略的 `.codex-test-tmp-pr49/`。为使用已安装编译器创建的
  `ui/node_modules` junction 也保留，指向现有 source-history 中的依赖；没有复制或修改用户数据。
