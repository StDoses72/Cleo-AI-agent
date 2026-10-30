# 0002. 已有会话加入同一空间的项目：复用 move_session，重新绑定工作目录

- **Status**: Proposed
- **Date**: 2026-10-30

## Context

用户常常先在 General（不关联项目）里开始一个线程，聊过或执行过任务后才发现它属于某个已有项目（issue #150）。当时的代码只允许在未发送的草稿阶段选择项目（`ui/src/components/ProjectTarget.tsx`、`retargetDraft`）；已有会话的"更多"菜单没有迁移入口。

已有的基础与约束：

- `cleo/sessions/store.py` 的 `SessionStore.move_session(session_id, target_project)` 已能在同一 space 内迁移：改写每个事件的 `project`、追加 `session_project_moved` 事件、丢弃源项目的记忆状态与 chunk、刷新 compact；它**拒绝**已经 consolidation 进原项目的会话（`CompactStore.is_consolidated`）。
- 普通聊天已有 `/project move <name>` 命令直接调用 `store.move_session`，并且接受没有注册目录的项目名；开发任务的 `/project` 只显示项目。
- 开发任务的工作目录保存在 manifest 的 `cwd`；下一轮恢复原生 harness 会话时 `DesktopService._ensure_productivity_session` 用 `manifest["cwd"]` 作为 `project_path`；项目列表（`_projects`）和撤销检查点（`undo_checkpoint`）也都以 cwd/仓库为准。
- harness 交接（`cleo/harnesses/service.py` 的 `switch_session`）会把原生会话绑定到一个**按项目/空间限定**的上下文快照（`cleo/harnesses/context.py` 的 `ConversationContext.load` 校验 `payload["project"] == manifest["project"]`，否则抛 `Context snapshot scope changed`）。
- 运行中的会话不能在执行期间改变工作环境；跨空间、批量、拖拽迁移不在本次范围。

## Decision

- 新增 `DesktopService.move_thread(thread_id, project_id_value)`（RPC `move_thread`，`rpc.py` 与 `main.mjs` 白名单同步），内部 `_move_thread` 复用 `store.move_session`，在与删除相同的 `_memory_operation()` 守卫下执行。公开路径拒绝：运行中或正在切换 harness 的线程、跨空间目标、Cleo 自我演进任务（双向）、已移除或未注册的目标；存储层的"已 consolidation"拒绝被转译成明确的用户可读原因，而不是绕过。
- **迁移后重新指向目标项目**：开发任务把 `cwd` 改为目标项目目录，并关闭驻留的 harness 会话，下一轮用新目录恢复原生会话；聊天线程丢弃缓存的 agent，下一轮用目标项目的记忆重建。当前线程保持为活动线程，侧栏分组和面包屑由快照刷新。
- **带 harness 交接快照的任务拒绝迁移**（`_has_context_snapshot`：事件里存在 system actor、`context_version == 1` 且带 `snapshot_id` 的 payload），错误信息说明原因；对话框文案预先注明这一限制。
- **迁移时丢弃上一轮的 Git 撤销点**：调用 `discard_git_checkpoint` 并清空 `undo_checkpoint`/`undo_checkpoint_shared`。
- `AgentService.resume_session` 的"空任务重连"分支把 `session_project_moved` 视为无对话事件，保证从未发过消息的 Codex 任务迁移后首次发消息仍能启动。
- `/project move <name>` 对开发任务也可用（同一内部路径，在命令回合内执行）；聊天命令保留"接受未注册目录的项目名"的旧行为（`require_known=False`）。
- UI：对话"更多"菜单新增"加入项目…"，对话框列出同一空间内的其他项目（排除演进项目），对开发任务说明工作目录将从 X 改为 Y、文件/Git 仓库/附件不会移动；运行中显示提示并禁用确认；取消不改数据；失败在对话框内显示后端原因。

## Alternatives considered

- **只改 UI 的 `projectId`。** 被否决：事件、记忆状态、compact、索引都按项目分目录；不走 `move_session` 会让侧栏与持久化归属不一致，重启后回退。
- **用"新建线程 + 复制消息"代替迁移。** 被否决：会话 ID、标题、附件引用和可继续的上下文都会丢，issue 明确要求保留。
- **放宽存储层对已 consolidation 会话的拒绝。** 被否决：已整理进原项目的记忆无法可靠地跟着迁走，issue 也不授权移除该校验；改为给出明确原因。
- **迁移后不改 `cwd`、不关闭驻留会话。** 被否决：这正是 issue 警告的"只改侧栏仍在 General 目录执行"。
- **对带交接快照的任务重建绑定**（评审前的实现是直接放行，评审用真实存储复现了下一次恢复直接失败）。两种重建思路都被否决：
  - 直接改写快照里的 `project` 字段会破坏快照的指纹完整性校验（`fingerprint(payload) == snapshot_id`），等于伪造证据；
  - 在新项目下重新 `prepare` 一份快照并追加新的交接事件，意味着在迁移时同步启动一次 harness 交接（拉起 harness 进程、校验登录、重放上下文），成本高、失败路径多，而且会在时间线上留下一次并非用户发起的"切换"。
  在没有真实 harness 可验证的情况下，选择**明确拒绝并说明原因**，把重建留作后续工作。
- **迁移时保留 undo checkpoint、在 undo 时按快照记录的目录做检查**（评审提出的另一种修法）。被否决：这会让"撤销项目改动"按钮在面包屑已显示项目 B 时去改仓库 A 的文件和暂存区，对用户来说是跨仓库的意外副作用；丢弃检查点更安全，代价只是迁移后那一轮不能撤销。
- **用交接机制把原生会话"重新扎根"到新目录（同 provider 的 `switch_session`）**，以规避 harness 跨目录恢复的不确定性。未采用：与上一条相同的成本和不可验证性；当前实现依赖 harness 自己的 resume，若某个 harness 按目录存储会话而无法恢复，下一轮会报出 harness 的错误，对话框已据实说明。

## Consequences

- 正面：General 里的聊天和开发任务都能保留 ID、标题、消息和附件引用地加入项目；后续执行使用目标项目目录；失败路径（运行中、跨空间、已整理、已移除、带交接快照）都有明确原因而不是假成功。
- 负面/限制：
  - 原生 harness 会话能否在新目录恢复取决于 harness（例如按目录存储会话的 CLI 可能拒绝），沙箱里没有验证；对话框已说明，用户可以切换 harness 或新建任务。
  - 带交接快照的任务暂不能迁移；迁移后那一轮无法撤销 Git 改动。
  - 聊天命令仍接受未注册目录的项目名（旧行为），与 UI 路径的"只列出已注册项目"不一致，但这是为了不破坏现有命令和测试。
- 后续工作：在能接触真实 harness 的环境验证跨目录恢复；评估用交接机制为迁移后的任务重建上下文绑定；考虑把聊天命令也收紧为只接受已注册项目。

## References

- PR [#154](https://github.com/StDoses72/Cleo-AI-agent/pull/154)；issue [#150](https://github.com/StDoses72/Cleo-AI-agent/issues/150)。
- 代码：`cleo/desktop/service.py`（`move_thread`、`_move_thread`、`_has_context_snapshot`、`_target_project_path`），`cleo/desktop/commands.py`（`_chat_project`、`_task_project`），`cleo/sessions/store.py`（`move_session`），`cleo/harnesses/service.py`（`resume_session` 的空任务重连），`cleo/harnesses/context.py`（`ConversationContext.load`），`ui/src/components/Overlays.tsx`（`MoveThreadDialog`），`ui/src/components/Conversation.tsx`，`ui/src/useCleoWorkspace.ts`（`moveThread`）。
- 测试：`tests/desktop/test_service.py`（`test_move_thread_moves_general_chat_into_project_and_keeps_history`、`test_move_thread_rebinds_task_directory_and_releases_resident_session`），`tests/integrations/test_codex_empty_resume.py`（`test_moved_empty_draft_still_reconnects_in_its_new_project`），`ui/tests/uiux-regressions.smoke.mjs`（"projects: an existing general task can join a project and stays open"）。
- 相关文档：`docs/ARCHITECTURE.md`（会话模型与 harness 数据流）。
