# Markdown 偏好与内嵌 Git

项目 `MEMORY.md` 现在直接保存当前偏好。DreamAgent 逐块提出明确的 old/new 编辑，在候选文本中顺序合并，全部块完成后发布一次，不再向事实 SQLite 或 persona 写入提取条目。原始会话和现有历史索引继续保留。

## 内容与读取

文件接受 `# User Preferences` 或 `# 用户偏好` 标题及单行列表。上限为完整文件 6,000 Unicode 字符、30 条偏好；手动整理可附一个 `## Last Consolidation` 小节，上限 1,500 字符、模型至多五条短状态。字符预算不是所有 provider 的 token 计量。

新增/替换必须有当前块的有效来源引用；移除已有冲突条目可以省略新引用。同义重复不重写；任一操作旧值不唯一、超预算或来源错误，均不发布候选。模型对事实与偏好的语义判定仍可能失败，来源存在不等于结论必然正确。

项目偏好由聊天启动上下文和生产力 adapter 的当前范围上下文读取；原始用户消息保持原样保存，不把注入偏好再伪装成用户证据。

`search_long_term_memory` 保留兼容名称，只返回当前 Markdown 偏好，绝不回退查询旧事实。`read_project_memory` 显式读取偏好、历史交接快照及 Git 记录。`memory_history` 只读查看最近提交。其他历史工具继续读取原始来源。

无法判定的显性冲突保持原文件，并返回 `needs_clarification`。`.memory-review.json` 只记录被抑制条目的 hash 和澄清问题，不保存完整偏好副本；读取层暂不使用冲突部分，保留无关偏好。澄清后成功发布会移除该标记。

已有 persona 的展示和人工内容保持兼容；此版本不会继续从 DreamAgent 自动生成 persona。全局偏好管理和语义向量检索不在本次新增范围。

## Git 边界与恢复

仓库位于配置的 memory 根目录内，拥有自己的 `.git`，不是源码仓库的 submodule。默认忽略全部文件，仅通过精确路径强制暂存 `<space>/projects/<project>/MEMORY.md`。已有源码策略文件仍由父源码仓库维护。

没有变化不提交。首次修改已有或人工编辑的文件，会先提交原始基线，再提交本次记忆变更；该基线提交用于避免人工内容无版本可查。正常的后续整理一次变化只产生一个提交。没有 remote 也可使用，不自动推送、不修改全局 Git 作者或配置。

发布持有根目录锁，核对当前文件和提取基线一致，并使用 `.git/cleo-publish.json` 临时发布日志协调文件替换与提交。提交失败恢复旧文件；进程中断保留日志，下一次整理先恢复，恢复前读取明确报告不可用。检测到中断期间人工修改时不覆盖，报告需协调。完成后删除日志。

Git 当前仅允许白名单文件；若已有内层仓库跟踪其他内容，会报错而不擅自清理。`MemoryRepository.revert(space, project, commit)` 可撤销一个提交的偏好增删，保留后来无关条目；目标已变化则拒绝自动撤销。此 API 不回滚项目源码。UI 显示最近记忆提交；当前未添加 UI 撤销按钮。

Git 历史会增长，旧值仍可存在于历史中。普通删除不是彻底遗忘；全历史重建和历史擦除需独立审查。原始会话的保留政策也没有被改变。

## 旧格式迁移

事实型旧 Markdown 不继续作为有效偏好注入，也不会被静默覆盖。记忆页显示迁移提示。旧数据库和文件原样保留，避免丢失独有手写内容。

先在源目录以外生成预览（使用当前配置的 DreamAgent 模型）：

```powershell
python scripts/migrate_memory.py --source-root <memory根目录> --space productivity --project 17214 --output <任务临时目录>/preview.md
```

可用 `--sessions id1,id2` 限定来源。预览从原始会话重新形成偏好，不把旧提炼事实作为真值；在隔离临时目录运行，结束前检查源文件 hash 未变。所有会话与模型原始输出都不提交到源码仓库。

审查预览并核实旧文件中是否有独有人工内容后，才显式应用：

```powershell
python scripts/migrate_memory.py --source-root <memory根目录> --space productivity --project 17214 --apply-reviewed <已审查文件> --expected-hash <预览报告的原文件hash>
```

应用检查原文件仍一致，并将旧正文基线保存在内层 Git 后发布新文件；不会删除旧 SQLite 或原始会话。本 PR 的开发和模型评测没有对真实 17214 数据执行应用。

## 验证

确定性回归覆盖 Markdown 编辑、真实嵌套 Git、提交失败、重试、撤销中间提交、冲突抑制及澄清后的修复。原有断点、取消、原始事件前缀与 MCP 测试已迁移到新输出契约。

```powershell
python -m pytest tests/memory tests/agents/test_dream.py tests/integrations/test_memory_mcp.py
python scripts/evaluate_memory.py --cases P01,P13,P14 --output <任务临时目录>/smoke.json
python scripts/evaluate_memory.py --repeat 3 --output <任务临时目录>/development.json
python scripts/evaluate_memory.py --fixtures tests/fixtures/memory_rewrite/holdout.json --output <任务临时目录>/holdout.json
```

评测通过生产 SessionStore 与 DreamAgent，期望答案不传给模型。JSON 报告仅是可删除的评测产物；`change_matches` 只检查变化契约，不代表语义正确。须人工核对每项 must_keep/must_not，错误与重试都列入最终报告。
