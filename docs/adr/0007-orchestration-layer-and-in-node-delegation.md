# 0007. 多 agent 协作拆成编排层与节点内委派层，子任务路由收窄为后者的一种实现

- **Status**: Proposed
- **Date**: 2026-11-02

## Context

v0.12.2（PR #159，提交 `a1217db`）合入了子任务路由。它的运行结构是星型的：主 agent 调用 `delegate_subtask` / `route_subtask`（`cleo/routing/tools.py::tool_functions`），`cleo/routing/execution.py::RoutingService` 绑定到父会话，`cleo/routing/evaluator.py::SubtaskEvaluator` 产出需求评估，`cleo/routing/router.py::route` 在候选池里按硬约束和档位选出一个“连接 + harness + 模型 + 推理档位”组合（`cleo/routing/models.py::Candidate`），交给 `cleo/harnesses/service.py::AgentService` 执行，结果回到主 agent 验收。设置在 `cleo/desktop/routing_settings.py::RoutingControls` 与 `ui/src/components/model-settings/RoutingSettingsPanel.tsx`；每个会话另有 `runtime_options.routing_mode`，由 `cleo/routing/models.py::execution_mode` 与全局 `enabled` / `default_mode` 合成实际模式。详细行为见 `docs/benchmark-routing.md` 和 `docs/subtask-routing-architecture-plan.md`。

这版功能本身是对的，但有两类问题。

**体验问题。** 设置面板已有一个“自动路由”总开关，但同一层级平铺了默认模式、执行权限、优先考虑、保守回退、分配方式、反馈、按任务统计、每个候选的启用与档位、benchmark 密钥等十余项；`RoutingControls.save` 在开关打开时要求用户先手选一个已启用且可用的回退候选，否则保存报错（`routing_settings.py` 中 “开启路由前，请选择一个已启用的保守回退配置”）。用户想开一个开关，先要理解什么是回退候选。

**概念问题。** `RoutingService` 一个类里同时负责四件事：允许谁被调用（候选目录、启用状态、`allow_cross_backend_delegation`、`max_depth`）、怎么选（evaluator、规则 router、benchmark 排序、本地反馈加权）、怎么执行和监督（起 worker、取消、失败后升级、handoff 证据、任务账本）、以及如何暴露给主 agent（两个工具）。其中只有“怎么选”才是路由，但整个模块、设置与界面文案都叫路由。

更重要的是产品层面的需求：现有结构只覆盖“主 agent 自己决定要不要派、派给谁、还是亲自做”这一种协作方式。用户同时需要另一种：系统预先规定好的固定结构，例如“规划者产出计划，必须交给 codex 做反驳者，不通过则回到规划者”。在这种结构里，规划者节点内的 agent 没有“要不要让 codex 反驳”这个选项。用 `delegate_subtask` 表达它是不成立的，因为 delegate 的主语是 agent，而这里做决定的是系统。

仓库里已经有后一种结构的硬编码实例：本地进化流程中，`cleo/desktop/evolution_planning.py` 的只读需求分析器被明确告知“不调用工具，不执行修改”，产出验收案例后交给执行会话，再进验收（`docs/cleo-evolution.md`）。分析器无权跳过自己直接去改代码。这条边由系统掌控，只是写死在 Python 里，没有数据结构，用户不能编辑。

讨论中确认的关键区分：决定一条边性质的不是方向（上下级还是平级），而是**这条边由谁掌控**。

- agent 掌控的边是一种**许可**：agent 可以不用。现有子任务路由全部属于这一层，候选池是许可范围，evaluator 和 router 只是帮 agent 在许可范围内选。
- 系统掌控的边是一种**义务**：由编排器推着数据沿边走，节点里的 agent 不需要知道整张图的存在，只收到输入、产出输出。

两种边都可以是上下级形状，所以“只有上下级和平级两种关系”不是正确的抽象轴。

必须保留的既有约束：父会话绑定校验、`cleo/routing/handoff.py::prepare_handoff` 对产物范围的限制、跨 backend 委派需显式授权（`execution.py` 中 `cross_backend_permission_authorization_required`）、`cleo/routing/permissions.py` 的权限预设映射、委派深度上限（`execution.py` 中 “Delegation depth limit reached”）。这些都有测试覆盖，是这版功能的主要价值所在。

## Decision

1. **协作模型分为两层，各自有明确的所有者。**
   - **编排层**（orchestration）：一张由用户或系统所有的图。节点是角色（规划者、反驳者、执行者……），每个节点绑定一个候选 ID 并带一个“节点内委派”开关；边是强制的数据流，由编排器执行，节点内的 agent 既不能发起也不能跳过。控制结构第一版只有三种：顺序、带最大轮数和退出条件的循环、并行扇出与汇合。循环的终止条件、节点失败的处理和最终验收权都归图所有，不归任何节点内的 agent。
   - **节点内委派层**（in-node delegation）：某个编排节点在自己的回合里，节点内的 agent 可以在许可范围内自主决定亲自做、派给自己的子线程、或派给其他候选。这一层就是现有子任务路由。
   - 两层的边界：外层决定“谁必须参与、按什么顺序”，内层决定“一个参与者在自己的回合里可以找谁帮忙”。
2. **现有子任务路由收窄为节点内委派层的实现，不重写。** `RoutingService` 保留，测试原样保留。从它身上抽出两个接口，让它成为第一个实现：
   - 许可范围：可达候选集合与约束（启用状态、跨 backend 授权、深度上限）。
   - 选择策略：输入任务评估与可达候选，输出一个候选。现有代码里已经有三个实现可对照：evaluator + 规则 router、`delegate()` 的 `request` 显式指定、配置的固定回退。
   执行、取消、任务账本、升级重试、handoff 仍归 `RoutingService`，第一版不再往外抽。主 agent 看到的工具接口 `delegate_subtask` / `route_subtask` 不变，提示词与 MCP 注册不动。
3. **两层共用同一个候选目录。** 编排节点绑定的是 `Candidate` 的 ID（连接 + harness + 模型 + 档位），复用 `cleo/routing/catalog.py::CandidateCatalog` 与 `cleo/harnesses/availability.py` 的可用性检查。不新建第二套模型列表。
4. **节点内委派的开关语义。** 全局“自动路由”开关改为节点内委派的默认值；编排图里每个节点的开关覆盖默认值；会话级 `routing_mode` 保留，它和全局开关语义不同（会话级是“这个会话当前用不用”，全局是“默认用不用”）。开关打开时后端自动选回退：取当前可用候选中档位最高的一个，用户无需手选；用户仍可在高级设置里改。
5. **设置面板按此收敛。** 面板只留开关和一行状态摘要（启用状态、可执行候选数、当前回退）；其余折叠进“高级”，分为“模型池”“评估器”“benchmark 数据”三组。界面文案“子任务路由”暂不改名，等编排层落地后再统一命名，避免中途出现两套叫法。
6. **图编辑器只对编排层开放。** 可拖拽编辑的对象是编排图的节点、强制边和三种控制结构；不允许在图里连接内层候选。内层可以有只读视图（主 agent → evaluator → 候选池，标注可用状态和最近选择），用于解释路由决策，但不可编辑。
7. **明确不做的事。** 不实现平级关系（没有用例）；不支持自由拓扑（任意图、环）超出三种控制结构之外；内层第一版只保留请求应答协议，受监督执行（steer / 审批）和接力（handoff）作为协议变体的抽象留到有第二个使用者时再做；本地进化流程不强制迁移到编排图，它继续作为硬编码实例存在，直到编排层稳定。

## Alternatives considered

- **把 `RoutingService` 重写成通用“委派”类，用上下级 / 平级枚举区分关系。** 否决：方向不是区分轴，规划者到反驳者的强制边和主 agent 自主派活都是上下级形状，却是两种完全不同的东西；重写还会丢掉已验证的安全约束。
- **把拖拽图编辑器直接做在现有路由候选上（拖线启用或禁用候选）。** 否决：运行时结构是星型，图里画出来的任何非星型拓扑执行层跑不了，要么静默忽略，要么得为它新写执行语义，而那套语义与 evaluator 动态选模型冲突；同时它让“选项太多”的问题更严重。
- **用提示词实现强制结构（告诉主 agent “你必须调用反驳者”）。** 否决：agent 可以不听，不可强制；而需求恰恰是 agent 不被允许选择。
- **拆成三层：拓扑、选择策略、边协议。** 这是讨论早期的方案，被双层模型替代：它仍然把“谁掌控这条边”藏在拓扑里；边协议的受监督与接力变体目前没有使用者，抽象跑在第二个实现前面。保留为内层的后续工作。
- **只隐藏控件、不改语义。** 部分采纳（面板收敛），但单独做它解决不了“开关打开要先选回退”的问题，也解决不了编排需求，所以不能作为全部。
- **先做可编辑的图，再补执行语义。** 否决：图编辑器是全部工作里最贵、最难测的一块，而且用户编辑的结果必须能跑；顺序应当是先有数据模型和编排器，再有图。

## Consequences

- 正面：用户可以同时拥有“agent 自主派活”和“系统固定流程”两种协作方式，且两者边界清楚；Jason 这版路由的全部约束和测试保留；图编辑器有了明确的编辑对象（编排图）而不是去编辑一个运行时不存在的东西；设置面板从十余项收敛为一个开关。
- 负面 / 限制：编排层是一个新的运行时，它的执行语义（循环终止、节点失败、并行汇合、最终验收）需要在实现 PR 里逐项定义并带 ADR；全局默认开关与节点开关并存，文案要写清楚覆盖关系；界面在过渡期继续叫“子任务路由”，与内部命名不一致；本地进化流程与编排图在一段时间内是两套并行的“系统掌控流程”。
- 后续工作，按依赖顺序分成独立 PR：
  1. 设置面板收敛与自动回退（只动内层，用户立刻有感）。
  2. 从 `RoutingService` 抽出许可范围与选择策略接口，现有实现成为第一个实现。
  3. 编排层数据模型与编排器（无界面），带执行语义 ADR。
  4. 编排图编辑器与内层只读视图。

## References

- PR #159（v0.12.2 集成），提交 `a1217db`（子任务路由实现）。
- 代码：`cleo/routing/execution.py`（`RoutingService`、深度与跨 backend 限制）、`cleo/routing/tools.py`（`route_subtask`、`delegate_subtask`）、`cleo/routing/router.py::route`、`cleo/routing/evaluator.py::SubtaskEvaluator`、`cleo/routing/models.py`（`RoutingSettings`、`Candidate`、`execution_mode`）、`cleo/routing/handoff.py`、`cleo/routing/permissions.py`、`cleo/routing/catalog.py`、`cleo/harnesses/availability.py`、`cleo/desktop/routing_settings.py::RoutingControls`、`cleo/desktop/evolution_planning.py`。
- 界面：`ui/src/components/model-settings/RoutingSettingsPanel.tsx`、`ui/src/components/Conversation.tsx`（会话级“指定 harness / 子任务路由”切换）。
- 文档：`docs/benchmark-routing.md`、`docs/subtask-routing-architecture-plan.md`、`docs/subtask-routing-feedback-and-token-plan.md`、`docs/routing-permissions.md`、`docs/cleo-evolution.md`。
