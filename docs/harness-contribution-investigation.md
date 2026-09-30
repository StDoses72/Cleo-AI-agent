# “harness修复”提交失败调查

调查时间：2026-09-15 UTC。对应请求 `26d22eed-f408-4b90-baa0-697259410896`。

## 实际停在哪一步

本次“harness修复”是目标分支名称，不能仅根据名称将问题归因于 harness 任务执行或原 PR 修复入口。

只读检查桌面的 `evolution/state.json` 得到两次待提交记录：

| submissionId | 创建时间（UTC） | 目标 | 状态证据 |
| --- | --- | --- | --- |
| `2414d087-8205-4d8f-b007-0a43c22bb1ef` | 2026-09-15 04:04:51.373 | harness修复 | 没有 commit、snapshot 或成功回执 |
| `ba5e93eb-c852-49b2-b5a9-120ae6564e1c` | 2026-09-15 04:05:25.571 | harness修复 | 没有 commit、snapshot 或成功回执 |

两次都选择 `local-1b22453f-0574-4640-8780-d1c586cda1b2`（“非harness修复”）。截图显示“源码路径无效”。该错误只出现在 `createContributionSnapshot` 的文件枚举检查，发生在 `commit-tree`、fork、push 和创建 PR 之前。结合上述记录，可以将本次阻塞定位到本地源码快照导出。

GitHub 只读 API 同时确认：

- [harness修复 分支](https://github.com/StDoses72/Cleo-AI-agent/tree/harness修复)存在，SHA 为 `73a7c48e63fdbfab36b23280bea1047361f8638e`，tree 为标准空树 `4b825dc642cb6eb9a060e54bf8d69288fbee4904`，满足空目标分支要求。
- `GET /repos/StDoses72/Cleo-AI-agent/pulls?state=all&base=harness%E4%BF%AE%E5%A4%8D&per_page=100` 返回 `[]`。本次没有可供继续更新的原 PR。
- 本地没有本次提交 SHA，不能报告“改动已进入 PR”“CI 通过”“具备合并条件”或“已合并”。

## 会话与历史 PR 的区别

已读取 productivity / cleo-evolution 项目的 `agent_66e5c7b5139a` 会话。最后的回复记录了非 Codex harness 和新任务交互改动，以及该旧会话中命令审批阻塞、验证未完成的事实。这说明此前确有代码编辑任务，不能把本次快照导出错误当作该旧会话没有执行的证据。

同时读取的历史会话 `agent_142f59d46830` 指向 PR #49 的冲突修复需求。当前 GitHub 的 [PR #49](https://github.com/StDoses72/Cleo-AI-agent/pull/49)已关闭、未合并，head 仍为 `bb74fe60d387bd82745b41366f5134b85c98be0a`，只有一个提交，mergeable_state 为 dirty。其 commit status 和 review 查询均为空，不能推断 CI 或审查通过。历史 [PR #51](https://github.com/StDoses72/Cleo-AI-agent/pull/51)已合并。二者都不是此次向“harness修复”提交失败的 PR。

## 已确认的诊断缺陷及修改

原错误省略了文件名和阶段，无法从截图判断哪个路径触发了检查。另一个已复现的缺陷是：受保护的命令执行器会合并 stdout 与 stderr；Git 即使成功退出，也可能报告无法枚举目录。读取一个历史工作区时实际观察到 `Filename too long` 警告。这样的警告混入 NUL 分隔的文件列表后，会被误报为“源码路径无效”。

修改仅限未受保护的 `evolution-snapshot.mjs`：

- 非法路径报错包含转义后的路径、约束和“快照导出已停止，未推送或创建 PR”。
- 检出文件枚举诊断时保留诊断原因并停止；不丢弃警告继续导出可能不完整的源码。
- 保留原路径校验、版本摘要检查、目标分支检查和禁止自动合并的行为。

**未确认**：当前工作区的 508 个 Git 文件记录均未触发旧路径条件；保存的程序中的检查逻辑与工作区一致。截图当时的原始 stdout/stderr 和具体被拒绝文件未被保留下来，不能断言本次一定由长路径警告造成，也不能宣称真实提交故障已完全修复。

## 验证与边界

- 新增两项隔离回归：非法路径必须显示具体路径与失败阶段；枚举警告必须显示 Git 原因，不能伪装为普通路径错误。修改前两项均失败，修改后通过。
- 运行 `node --test tests/evolution-merge-assistance.test.mjs tests/evolution-submit.test.mjs`：35 项全部通过，零失败、零跳过。保留既有提交、原 PR 提示、冲突、远端变化和非强制推送回归。最后收窄诊断匹配条件后，再次运行两项受影响回归，均通过。
- 已运行安装的 TypeScript 编译器 `node node_modules/typescript/bin/tsc -b` 和 Vite production build，均成功。Vite 保留大于 500 kB 的 bundle 提示。
- 仅使用隔离测试目录测试写入；不修改共享用户数据、持久化格式、CLEO_HOME、userData 或受保护控制器。没有数据格式变更，未新增迁移或声称做过版本数据 round-trip。
- 命令行 GitHub 请求被当前沙箱网络权限阻断；远端证据由已连接 GitHub 的只读 API 获取。未验证桌面 GitHub 登录账号的源仓库写权限。
- 未推送、未新建替代 PR、未最终合并，未应用、保存、发布或重启 Cleo。
- 冻结的三个 manual 案例保持未人工验证。实际桌面重走、成功提交 SHA、对应 CI 与审查状态仍缺失；原 PR 更新案例在本次没有已创建 PR 的情况下无法执行。
