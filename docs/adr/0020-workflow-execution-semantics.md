# 0020. 自定义工作流由确定性的编排器在启动它的对话的一轮内执行；每个节点是一段子会话

- **Status**: Proposed
- **Date**: 2026-11-28

## Context

ADR 0007（PR #161，尚未合并）确定了自定义工作流的定义方式：用户拥有编排，节点绑定执行者，结构只有顺序、限轮循环和并行，并要求实现时补一份执行语义的 ADR。本文就是那一份，同时修正 0007 的两处写法（见 Decision 的「与 0007 的差异」）。

前端 demo 已经定型（`ui/src/components/workflows/`、`ui/src/workflow-types.ts`，数据来自 `ui/src/services/mockWorkflows.ts`），后端尚未实现。决策时核对过的代码约束：

- 一个对话同时只有一个运行：`RunSupervisor`（`cleo/desktop/runs.py`）按 thread 登记，`_stream_turn` 在已有未结束的运行时拒绝（`cleo/desktop/service.py`）。斜杠命令在这个名额之内执行。
- 后端到界面只有「请求内流式事件」：`cleo/desktop/server.py` 的事件都带请求 id，只有 `stream_turn` 是流式方法；Electron 丢弃没有对应请求的消息（`ui/electron/backend.mjs`）。没有后端主动通知的通道。
- 关闭窗口后应用留在托盘，后端继续运行（`ui/electron/tray.mjs`）；窗口销毁后事件不再转发，界面靠落盘的 `events.jsonl` 重建。
- 子会话已有先例：路由委派给子任务建独立会话并写入 `parent_session_id`（`cleo/routing/execution.py`、`cleo/sessions/store.py`）；子任务的批准请求经 `.routing/approvals` 回到父对话。
- 各 harness 能强制的限制不同：Codex 有 `sandbox: read-only`，Claude 有 `plan` 权限模式，Antigravity SDK 的 `deny_all` 只放行只读工具（`cleo/integrations/harnesses/antigravity.py` 的 `_decide`）；通用 ACP 只有批准模式，拦不住写入。
- Cleo 通过进程内 MCP 服务向 Codex、Claude、ACP 提供工具（`cleo/integrations/harnesses/memory.py`）；Antigravity SDK 目前收不到。Google 订阅额度走 `agy acp`，属于 ACP（ADR 0016）。
- 路由目录的候选是 harness、模型、思考强度的组合，没有速度档位（`cleo/routing/models.py` 的 `Candidate`）。
- 启动时不清理状态；进程退出后会话清单停在 `running`。
- git worktree 只在 Electron 一侧实现（`ui/electron/source-control.mjs`），Python 后端没有。
- Cleo 不向 harness 分发技能，只读取用户自己的技能目录（`cleo/desktop/skills.py`）。

## Decision

**编排器是代码，不是 agent。** 它读取运行开始时的定义快照，按边决定下一步；节点里的 agent 看不到流程图，不能跳过或新增步骤。定义在启动后不可修改，要改就停止后重新启动。

**运行发生在对话的一轮之内。** `/workflow <id> <任务>` 是开发会话的命令，占用该对话的运行名额直到结束或被停止：期间这段对话不能再发消息，其他对话不受影响。停止沿用现有的取消。关闭窗口不停止运行；退出后台才中断。

**每个节点是一段子会话。** 复用会话服务与 harness 适配器创建，`parent_session_id` 指向启动对话，另记所属运行与节点。循环的每一轮、逐项的每一项、每一次重试各是一段新会话。节点会话只读：界面不提供输入框，运行结束后也不能续聊。

**节点的输入。** 任务原文，加上直接上游节点的最终回复；在循环里再加判定节点的打回意见。节点看不到其他节点的过程。

**结构。** 顺序、并行与汇合、限轮循环（最多 5 轮），以及**按清单逐项**：上游节点交回一份清单，本节点为每一项各起一份并行处理，最多 8 项，全部完成后汇总给下游。同时运行的节点会话最多 4 个。

**判定与清单用结构化工具交回。** 判定节点交回「通过／打回」与意见，产出清单的节点交回条目，都通过 Cleo 的 MCP 工具，由后端校验。收不到 Cleo 工具的 harness 不能担任这两类节点，编辑器在保存前指出。判定节点没有给出结论按失败处理。

**系统强制的限制只有三项**：只读或可改、能否派子任务（会话级的 `routing_mode`）、是否使用独立 worktree。路径级的范围只写在职责文字里，不作强制。ACP harness 拦不住只读，这类节点固定为可改。独立 worktree 由后端创建，运行结束后保留，分支名显示在节点概要里，由用户自行合并；项目不是 git 仓库时不可选。

**权限。** 可改文件的节点有一项权限选择，与会话相同的三档（`cleo/routing/permissions.py` 的 `NATIVE_PRESETS`）：请求批准（请求出现在启动对话里，沿用子任务批准的通道）、帮我审批、完全访问，界面也用会话的同一个选择器。默认「帮我审批」；harness 没有的档位不提供，只有自有模式的 ACP harness 不显示这一项。只读节点不会询问，没有这项选择。

**失败与重试。** 节点失败后自动重试，最多 3 次；仍失败则运行结束，把已有结果和失败原因交回对话，并行中的其他节点做完手头这一段。之后可以手动「从失败处重试」，只重跑失败的节点。

**中断与继续。** 运行、节点的开始与结束都作为会话事件落盘，因此能确定运行停在哪个节点。后端启动时把没有存活进程的运行标为已暂停；用户点「继续」后从该节点重新开始，已完成的节点不动。不自动继续。

**节点绑定。** 界面上 harness、模型、思考强度、速度四项分开选择；后端用路由目录校验前三项，速度按模型目录单独校验。留空表示跟随启动对话。

**存储。** 每个工作流一个 JSON 文件，位于全局数据目录的 `workflows/<id>.json`；保存下来复用的节点定义在 `workflows/roles/`。保存时由后端校验。暂不支持按项目存放。

**由 AI 起草。** `/create-workflow` 是 Cleo 的内置命令，带内置提示词；节点的「一句话起草」共用同一份指引。起草结果通过 MCP 工具交回，后端校验通过后在对话里出一张卡片；卡片打开画布，保存由用户完成。

**与 0007 的差异**（需在 PR #161 中同步）：节点绑定不再是「选一个候选」，而是四项分开、同一份目录校验；结构在三种之外增加「按清单逐项」。

## Alternatives considered

- **让一个 agent 担任编排者。** 流程是否被遵守取决于模型，无法保证「必须经过审查」这类要求。否决。
- **运行脱离对话在后台进行。** 需要新建后端主动通知的通道，并重做停止、批准和进度的归属。工作量约翻倍，而换来的只是运行期间还能在同一段对话里发消息。否决。
- **从回复文本里解析判定和清单。** 所有 harness 都能用，但格式不受约束，解析失败时只能当作节点失败。否决，改用结构化工具。
- **通用 ACP 不允许担任节点。** 会把 Google 订阅用户（`agy acp`）挡在外面。否决，改为这类节点固定可改。
- **所有节点都沿用启动对话的权限档位。** 无人值守的流程会停在批准请求上。否决，改为按节点选择。
- **节点权限只分「自动／询问」两档。** 与会话里的三档是两套说法，用户要学两次。否决，改为与会话相同的档位和控件。
- **`create-workflow` 做成 SKILL.md 技能。** Cleo 不向 harness 分发技能，没有安装位置。否决，改为内置命令。
- **AI 交回的工作流直接保存。** 用户没有看过就进了仓库。否决。
- **重启后自动继续。** 用户可能已经不想继续，且会在启动时悄悄消耗额度。否决。

## Consequences

- 运行期间启动它的对话被占用；想同时聊别的要另开对话。
- 中断后「继续」会让当时在跑的节点从头再来，那一段的用量重复计。
- 自动重试最多把单个节点的用量放大到 4 倍。
- Antigravity SDK 在能接收 Cleo 工具之前不能担任判定或产出清单的节点；实现时需核实 SDK 是否支持自定义工具。
- ACP 节点没有系统强制的只读。
- 保留的 worktree 会积累，需要用户自己清理；后端要新增一份 worktree 的实现。
- 时间线新增两种落盘事件与对应的投影（运行、提议）；`ui/src/types.ts` 里已有它们的类型。
- 「导入工作流文件」不在本次范围内。

## References

- ADR 0007（PR #161）、ADR 0016
- `ui/src/workflow-types.ts`、`ui/src/components/workflows/workflow-model.ts`
- `cleo/desktop/service.py`、`cleo/desktop/commands.py`、`cleo/desktop/runs.py`、`cleo/routing/execution.py`、`cleo/harnesses/service.py`、`cleo/desktop/projection.py`
