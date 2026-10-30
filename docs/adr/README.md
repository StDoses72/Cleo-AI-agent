# 架构决策记录（ADR）

本目录记录 Cleo 中影响架构、数据模型或用户可见行为边界的决策，写给没有参与当时讨论的人：重点是**为什么这样选**、否决了什么、留下了什么限制。实现细节以代码和对应 PR 为准，ADR 不复述它们。

## 约定

- **编号与文件名**：`docs/adr/NNNN-<kebab-slug>.md`，`NNNN` 为四位递增编号，由提出决策的 PR 分配；同一时期并行的 PR 事先分段领号（例如 0001–0003 与 0004–0006），避免撞号。编号一经合并不再复用。
- **一个决策一份 ADR**：一个 PR 可以带多份，一份 ADR 不跨多个不相关的决策。
- **随 PR 提交**：ADR 与实现同一个 PR 合并，评审时一起看；评审中改掉的方案记入 Alternatives considered，而不是从历史里抹去。
- **状态流转**：
  - `Proposed`：随 PR 提出，尚未合并。
  - `Accepted`：PR 合并后即为 Accepted（合并时把状态改掉，或在合并后的首个相关 PR 里改掉）。
  - `Superseded by NNNN`：被后续决策替代；旧文件保留，只改状态并链接到新编号。新 ADR 的 Context 要说明替代了哪一份以及原因。
  - `Deprecated`：决策所涉能力已移除且没有替代决策。
- **语言**：正文使用中文（与 `docs/README.md` 一致），章节标题使用固定英文，便于检索。引用代码时写真实的文件路径和标识符。

## 每份 ADR 的结构

| 节 | 内容 |
|---|---|
| 标题 | `# NNNN. <决策的一句话>` |
| Status | 上面的状态之一 |
| Date | 决策日期（`YYYY-MM-DD`） |
| Context | 要解决的问题、相关 issue 编号、当时代码施加的约束（引用真实路径/标识符）、决策时已知的事实 |
| Decision | 选了什么、边界在哪里（做什么、不做什么） |
| Alternatives considered | 至少列出被否决的方案及否决理由，包括评审过程中被换掉的方案 |
| Consequences | 正面与负面影响、留下的限制、必要的后续工作 |
| References | PR、issue、相关文档与关键代码位置 |

## 索引

| 编号 | 标题 | 状态 |
|---|---|---|
| [0001](0001-retry-failed-memory-sources.md) | 失败的记忆源可自动重试（有界退避）并可从队列手动重试 | Accepted |
| [0002](0002-move-conversation-into-project.md) | 已有会话加入同一空间的项目：复用 move_session，重新绑定工作目录 | Accepted |
| [0003](0003-per-conversation-built-in-browser.md) | 内置浏览器按会话隔离、按需创建、闲置 10 分钟回收 | Accepted |
| [0004](0004-claude-turn-and-background-task-lifecycle.md) | Claude 回合与后台任务的生命周期归 provider 所有 | Accepted |
| [0005](0005-single-codex-cli-distribution.md) | Codex CLI 只随 Python 运行时分发一次 | Accepted |
| [0006](0006-online-runtime-ownership-and-retirement.md) | 在线运行环境的归属登记与基于证据的退役 | Accepted |

每个引入 ADR 的 PR 自己在此表追加对应行（并行 PR 之间的小冲突在合并时解决），这样任何一个 PR 合并后索引都是完整的。0001–0006 随同一个集成 PR 合入 `main`，状态在集成时改为 Accepted。
