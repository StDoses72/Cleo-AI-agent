# Cleo contribution targets

The contribution dialog offers two explicit actions:

- Submit a PR from the signed-in user's fork to an existing upstream branch.
- Submit a GitHub Issue applying for a target branch. An owner/collaborator creates the named branch from the empty `submission-base` template (Source in GitHub). Refresh verifies its existence; a separate user action then submits the PR.

Neither action creates an upstream Git ref or merges a PR. `main` and the reusable `submission-base` template are excluded from the UI and rejected by the backend, including qualified `refs/heads/main`, surrounding whitespace, and case variants. Missing targets have no default. Git validates all requested branch names.

Both actions pin a local build ID. PR submission verifies the live source hash equals that build's hash before exporting and pushing a new snapshot commit; the developer checkout and index are never committed or modified. A branch application retains that version during cleanup so it remains available while waiting. To submit a different saved version, first select it in the version picker and prepare its source.

Branch applications and PRs retain stable IDs across retries, reconcile remote receipts after response loss, and reject changes to an existing attempt's content/target/version. PRs use independent fork branches without forced pushes. GitHub Issues must be enabled and accessible to submit an application; an API or permission error remains visible and does not imply success.

An abandoned evolution request retains its prompt, error, and evidence with `abandonedAt`; further retries are rejected. Its remaining manual cases are cancelled, not passed. The desktop clears the active request and its retry callback so a new request can start independently. Existing code changes are retained; discarding code remains the separate version action.

Validation: `node --test ui/tests/evolution-submit.test.mjs ui/tests/evolution-store.test.mjs ui/electron/evolution-requests.test.mjs`. The submission tests use real local Git repositories and an intercepted GitHub boundary, including a maintainer-created target, version pinning, response loss, and rejected non-fast-forward pushes. `ui/tests/acceptance-retry.smoke.mjs` exercises the built UI, including the original preparation error, abandonment, both contribution paths, and main prohibition. No public Issues or PRs are created by these checks.
# 提交兼容性与合并辅助

维护者先创建空模板 `submission-base`。收到 Issue 后，使用 **Create a branch → Source: submission-base**，按申请中的名字创建独立接收分支，不添加 README 或任何文件。用户刷新 Cleo 的目标列表后选择这个新分支。

Cleo 读取并固定目标分支 SHA，拉取后验证文件树确实为空，在独立临时仓库导出选定版本的完整程序源码，创建以目标 SHA 为唯一父提交的快照。不使用本地开发历史，因此空模板可以拥有独立的根提交。程序文件按原始字节导出，保留已跟踪文件的可执行位；本机配置、对话、运行数据和构建产物不上传。

新提交推送到用户自己 fork 的独立分支，再发起 PR。维护者合并后，接收分支获得这份源码。提交准备、fork 和 push 前后重新核对目标 SHA；目标已有文件、期间变化、工具失败或源码摘要变化时停止。检查不会强推、覆盖远端或修改开发工作区。目标合并过一次后不再为空，后续收录应创建另一个独立接收分支。

提交回执保存目标 SHA、选定版本及快照格式；未完成提交保留临时快照，以同一提交重试。GitHub 已接收但响应丢失时先查询原 PR，不重复创建。旧版尚未完成的开发历史提交要求重新发起；已完成的历史 PR 保留查看和修复入口。

提交结果和 PR 历史均有“帮助合并 / 刷新状态”。它重新查询原 PR 的分支、提交、
合并状态、CI 和源仓库权限，并尝试在临时副本复现冲突。失败原因直接显示；
GitHub 无冲突不等于 CI、审查或分支规则全部满足，也不授权最终合并。

“调查并修复原 PR”在再次刷新后进入现有 Cleo 需求/验收对话流程，绑定原 URL 和
源分支，要求隔离修复、保留双方功能、通过相关检查后非强制更新原 PR；
需要人工取舍时展示差异。它不是自动解决任意冲突的保证，也不会自动最终合并。
修复结束后可再次刷新状态。新建 PR 仍独立于旧 PR。

这些检查依据某一时刻的分支 SHA，不能锁定 GitHub 分支。创建 PR 后目标仍可能前进；实际合并时仍以 GitHub 的检查、审查和权限规则为准。历史 PR 继续使用三方合并诊断，不会自动转换或重写其历史。
