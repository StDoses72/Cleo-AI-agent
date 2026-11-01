# 基于 benchmark 的子任务模型路由

Session 当前主模型始终是协调者。它决定是否拆分、何时并行、向子任务提供哪些上下文、如何验收，以及最终回复。简单任务可直接完成。路由服务只接收拆分后的结构化需求，推荐并校验子任务执行配置，不修改父会话模型。Evaluator 未指定时使用新对话默认模型，用户也可显式指定连接和模型。

## PR #159 集成

路由、评估器、任务用量和权限设置已接入基于 v0.12.1 的集成分支。保留新版的记忆来源工具、项目移动、按会话隔离的内置浏览器、Claude 多阶段后台任务、运行时归属记录及单份 Codex CLI 打包方式。路由 MCP 与记忆来源共用现有入口；Claude 重连保留任务归属钥匙，空后台通知不计作模型调用。配置示例可用于新安装；已有用户配置由原有加载流程读取，不把本机连接、密钥或缓存打包进仓库。

## Evaluator 分配模式（v2）

设置中的“分配方式”可切换 `evaluator` 与兼容旧版的 `rules`。新模式流程为：主模型拆分 → 宿主筛选当前账号和实际 harness 支持的模型 → 读取 AA 缓存与相对参考排名 → evaluator 给出候选、证据与理由 → 执行层重新校验能力、预算、权限和可用状态 → 统一委派 → 验收与反馈。主会话模型保持不变。

默认 evaluator 跟随新对话默认模型；与协调者相同时，先调用 `route_subtask` 获取候选和排名，再将 `recommendation` 传入 `delegate_subtask`，无需额外评估调用。独立 API 或 harness evaluator 每个实际子任务调用一次只读评估，预览不调用 evaluator。首版没有批量评估调用。上下文修订、候选与证据 ID 由宿主校验；数据变化后需要重新获取上下文。明确指定的执行配置仍优先。

AA 参考分成精确绑定、家族参考、未匹配。家族匹配只提供模型级参考，不冒充完整 coding-agent 测量；不确定版本和多重匹配会保留标记。排名只比较同 family、同指数版本、同分项的已知数据，成本与速度分开列出。缺少数据时 evaluator 可以参考明确的保守配置并解释选择；不满足硬约束仍停止执行。

“最近委派”提供实际用户反馈入口，按任务记录一次可修改的结果，并区分执行、选择、拆分、交接、环境和需求变化。至少 5 个独立且明确归因到执行或选择的确认结果，才给当前工作区、当前任务类型和当前账号/runtime 下的模型偏好一个不超过 15% 的有界修正；它不是成功概率，也不修改 AA 分数。可以冻结、撤回反馈。`flag_subtask_feedback` 仅记录待归因返工，主模型不能把自述变成用户确认。可信配置检查也可提供反馈，用户结论优先。

上下文栏新增“当前任务累计 token”：累计本对话及子孙任务、独立 evaluator 的已报告输入/输出，包含返工、失败、取消和撤回前已发生的用量；原上下文窗口统计单独保留。不预测默认模型消耗。未上报调用显示未知，不能解释成零。旧记录缺失的遥测不能恢复。

扩展配置保存在同目录 `routing-v2.json`，旧版可以继续读取原有配置：

```json
{
  "strategy": "evaluator",
  "auto_refresh_benchmarks": true,
  "feedback_enabled": true,
  "feedback_min_samples": 5,
  "feedback_weight_cap": 0.15
}
```

模型支持证据按账号、连接和真实 CLI 内容标识隔离；安装路径变化但二进制相同可复用证据，runtime 更新后重新确认。不支持某个组合不等于该模型在所有 Codex 版本或所有账号中不可用。

## 旧版规则模式与首版批次

完整执行配置是 `connection + harness/backend + model + effort`。候选目录读取现有 harness 注册表，非付费地检查账号和模型元数据，分别记录检查时间、未知能力和人工配置的档位。API 连接不会被任意绑定给另一个 harness。

评估 → 硬约束过滤 → 配置档位 → 同类、同版本 benchmark 辅助排序 → 成本/耗时偏好 → 稳定 ID 破同分 → 执行前复查 → 现有 AgentAdapter 执行 → 可信检查/unknown → 有条件升级 → 结果交回主模型。

实现按以下依赖顺序组织：

1. 本地候选与受约束委派：完整跑通本地配置的子任务。
2. Benchmark 辅助路由，依赖 1：刷新、离线导入和可解释推荐。
3. 共享委派入口，依赖 1、2：两类主模型使用同一服务和宿主绑定的 parent。
4. 验收、升级与观察，依赖 3：可审查的正常执行记录和回归覆盖。

不训练、不运行多模型对照实验；仅在 v2 显式开启时使用上述可撤销的本地反馈偏好。

## 配置与使用

把示例 `cleo/config/templates/routing.example.json` 复制为与运行中的 `cleo.json` 同目录的 `routing.json`。默认关闭路由。配置只属于用户/管理员；模型的评估对象不允许携带权限或配置修改。

客户端入口为 **设置 → 模型 → 子任务路由**。可以查看启用状态、人工档位、保守回退、benchmark 缓存及最近委派；保存开关、偏好、候选启用与档位。目录刷新只读取元数据，benchmark 支持手动刷新；v2 在第一次评估或缓存过期时按 TTL 准备数据，并对失败重试限流。密钥仅由后端安全配置读取。并发修改会要求重新加载，避免覆盖 CLI 的新配置。开关会更新未来会话的 MCP 配置，已有运行中的 provider 不会被重写。

先使用现有 Cleo 会话 ID 查看候选（命令中的 `PARENT_SESSION_ID` 需要替换）：

```powershell
python -m cleo.routing --parent PARENT_SESSION_ID candidates --refresh
```

目录只包含当前 `harnesses.json` 中实际配置的 provider。未注册、检查失败、没有模型目录的条目不可执行。客户端元数据检查不是付费推理，也不证明余额、模型请求或工具调用已经在线成功。首次使用会检查目录；之后按 TTL 复用，执行前只复查选中的连接。

从输出复制完整候选 ID 到 `fallback_candidate` 和 `candidates`，再填写实际确认的能力、上下文、价格及档位，然后设置 `enabled: true`。未知值留空。若缺少可靠比较数据，自动选择需要一个满足硬约束和档位的明确回退项；没有回退项会失败而不猜测。

`economy / balanced / strong` 是人工配置的档位。复杂度与档位的对应也是配置，不是“难度转分数”的通用公式。高失败影响要求 strong。用户明确指定 provider、model、effort 或候选 ID 时，服务只在这个选择内校验和执行；不可用就解释失败。

API 主模型获得 `route_subtask`、`delegate_subtask`、`list_execution_candidates`、`subtask_status`。原 `codex` 工具在路由开启后也要求 `assessment`，并通过同一服务执行；支持显式 `provider`、`model`、`candidate_id`。自动路由关闭时，原 Codex/model 和 `codex_reply` 行为保留。路由开启后不允许通过无评估的旧 reply 绕过检查：后续工作应由主模型重新评估并委派。

评估例子：

```json
{
  "task_type": "bug_fix",
  "complexity": "medium",
  "required_capabilities": ["text", "file_read", "file_write", "shell"],
  "context_requirement": null,
  "uncertainty": "medium",
  "failure_impact": "medium",
  "acceptance_criteria": ["原复现通过，相关回归不失败"],
  "budget": null,
  "deadline": null
}
```

需求不确定时可先委派 exploration，再由主模型重新评估。预算可给 `max_usd`、`mode: soft`、预估 `input_tokens/output_tokens`；deadline 必须包含时区。路由不从 prompt 长度推断难度，也不输出成功概率。

## Artificial Analysis 数据

核实时间：2026-10-19。官方 v2 API 通过服务端 `x-api-key` 认证。实现默认使用 `/api/v2/language/models/free`，支持分页；Pro 模式使用 `/api/v2/language/models`。不同套餐限制字段和端点权限；403 保留旧缓存，不绕过访问控制。[官方 API 参考](https://artificialanalysis.ai/data-api/docs/reference)、[认证及数据约定](https://artificialanalysis.ai/data-api/docs)。

在后端环境提供 `ARTIFICIAL_ANALYSIS_API_KEY`，或用配置指定另一个环境变量名。配置、前端及缓存不包含 key。

```powershell
python -m cleo.routing benchmark-refresh
python -m cleo.routing benchmark-status
python -m cleo.routing benchmark-import path/to/snapshot.json
python -m cleo.routing --parent PARENT_SESSION_ID preview path/to/assessment.json
```

旧规则模式只读缓存；v2 在初始化候选参考或 TTL 到期时刷新，缓存有效时不请求外部榜单，失败保留最近有效数据并在重试窗口内避免重复请求。无 key 可导入规范化快照（`BenchmarkSnapshot` schema）；导入保留原获取时间，不能把旧数据包装成新数据。请求失败使用最后有效缓存并标注 stale、时间和错误类别。无缓存时本地回退仍可执行。

快照保存来源、访问层级、获取时间、模型变体、评测版本、可获得的独立分项、输入/输出/缓存价格、benchmark 每任务成本、输出速度及延迟。缺失值是 null。API 当前没有在该公开参考中提供完整 coding-agent 榜单端点，因此不抓网页伪造该 API；完整 agent 数据可通过带 family/harness/harness_version/version 的本地快照导入。

匹配必须人工绑定具体 record ID、模型版本和 effort；没有确定版本的别名不自动匹配。完整 agent 指数还要求相同 harness 类型及版本。不同 family 或评测版本不混算。Coding Agent Index 评价完整配置，不能替代模型级 coding/agentic 分项。[Coding Agent Index 方法](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)。

绑定示例（仅说明结构，值必须依据实际证据填写）：

```json
{
  "model_version": "VERIFIED_MODEL_VERSION",
  "benchmark": {
    "record_id": "ARTIFICIAL_ANALYSIS_RECORD_ID",
    "model_version": "VERIFIED_MODEL_VERSION",
    "effort": "high",
    "family": "model"
  }
}
```

benchmark 分数不是任务成功概率，Cost per Task 不是 Cleo 报价。订阅和未知成本不等于免费。软成本估算采用人工配置的 API 单价；缺失时可参考精确匹配的 AA 模型价格，并结合结构化 token 估计。参考估算与当前连接的实际账单分开记录。当前 harness 不能兑现美元硬上限，所以硬美元预算会被拒绝，软预算会明确标注估算性质。总执行时间另有可取消的超时限制。

## 验收与升级

执行 completed 与验收 passed 是两个字段。无可靠验收信号时为 unknown；不因为回复“完成了”就标记通过。可在管理员配置中声明检查命令，并通过 `checks_by_task_type` 关联任务类型。命令直接以 argv 启动，不通过 shell 插值，也不把测试输出写入路由记录。评估参数不能添加命令。

自动升级默认关闭，硬上限一次。只有可信检查判定的 implementation 失败才可能升级；认证、网络、额度、上下文问题、超时及取消均不自动升级。显式指定的配置不自动替换。有预算且无法确定剩余额度时不自动升级。

自动重放还要求：选中的 Codex 子任务强制只读、配置声明 replay-safe、Git 工作区指纹未改变、未观察到工具副作用、检查命令由管理员声明只读。未知副作用、非 Git 目录或写任务会交回主模型审查。只读声明属于管理员对检查的信任，不是对任意命令副作用的硬隔离。普通写任务仍可正常执行，但不能盲目重放。

## 支持路径与限制

- API 主模型：在现有 LangChain 委派工具处集成，宿主通过 ContextVar 绑定父会话。
- 开发主模型：现有 Codex SDK、Claude SDK、ACP 的进程内 MCP 配置可携带宿主启动标识，统一适配器在创建、恢复和切换时绑定父会话。已有 MCP 进程需要重启会话才能获得新增工具。Codex/Claude 可执行受约束委派；ACP 主会话因缺少可通用验证的权限边界，第一版可预览、但自动执行会明确拒绝。
- 子任务：复用已有注册的 Codex/Claude/ACP provider；不新增直接 API 子任务执行器，也不把 DeepSeek API 凭空接进 Codex。
- 未绑定宿主的外部 MCP 调用明确返回 unsupported。不能从工具参数指定其他 parent 或越过 parent 的项目目录；嵌套深度受配置约束。
- 电脑工具继续校验运行中的桌面会话归属。独立 MCP 子进程不会仅凭持久化 parent 文件取得主会话浏览器或本机输入权限；需要电脑操作的部分应由已绑定的主会话执行。
- 保留原生 provider 权限。只读/plan 父会话不能委派给无法保持此边界的后端；不通过路由开放自动批准、bypass 或更宽 Codex sandbox。原生 harness 主会话跨 backend 委派还需要管理员显式配置 `allow_cross_backend_delegation: true`；API 主模型可在已配置执行器中选择。未知权限边界不会由模型评估补全。
- 管理入口包括桌面路由设置面板、CLI 与主模型工具。设置面板支持 AA 数据连接和精确 benchmark 绑定；能力、连接单价、上下文及可信检查由管理员配置文件提供。界面不能授予额外执行权限。任务拆分仍由主模型决定，不自动采样实验或增加验收模型调用。

## 观察记录

缓存和每个任务的独立 JSON 记录位于当前 memory 根目录的 `.routing`。任务关联 parent、attempt、子会话、评估摘要、候选、最终选择、原因、benchmark 来源/版本/时间、开始结束时间、可取得用量、实际成本、验收和升级记录。没有实际账单信号时实际成本为 null；不保存完整 prompt、回复、验收条件原文或文件内容。

这些路由记录只用于观察。原 AgentAdapter 的会话事件仍按仓库原有机制保存正常子任务会话；不重复执行任务收集数据，不自动学习或修改策略。

## 离线验证

`python -m pytest tests/routing` 使用 fake provider、本地 HTTP transport、临时会话库和本地检查命令。还应运行相关既有工具、MCP、harness、取消及主 Agent 回归。离线通过不表示真实服务、额度、模型推理和工具执行已验证。

早期四批的验证记录如下；PR #159 的集成回归结果记录在 PR 描述中：

- 路由与相关桌面服务、MCP、harness、取消及主 Agent 扩大回归：170 项测试及 9 个子测试通过，1 条依赖警告。
- 最后补充接口异常结构及父会话权限边界后，路由测试完整重跑：36 项通过。此结果与上一组有重叠，不相加计算。
- Ruff 静态检查、路由模块格式检查、`git diff --check` 通过；示例配置通过 schema 校验。
- CLI 使用合成空快照完成 `benchmark-import` 和 `benchmark-status` 冒烟验证。

Windows 验证使用本地隔离环境 `.venv-routing`，复用仓库依赖并覆盖旧 Codex SDK；配置、provider 和 HTTP 响应均使用离线 fixture。没有使用真实密钥、付费推理或多模型评测，也没有将离线结果当作线上连接验证。
## 侧栏中的真实本地配置预览

桌面应用继续使用 Electron IPC。浏览器开发预览默认仍是演示环境；要查看本机真实配置，
在启动 Vite 前显式指定 Python 和配置目录（PowerShell 示例，在 `ui` 目录运行）：

```powershell
$env:CLEO_PREVIEW_PYTHON = '完整路径\Cleo\resources\python\python.exe'
$env:CLEO_HOME = Join-Path $env:LOCALAPPDATA 'Cleo'
$env:CLEO_CONFIG_PATH = Join-Path $env:CLEO_HOME 'config\cleo.json'
$env:CLEO_HARNESSES_CONFIG_PATH = Join-Path $env:CLEO_HOME 'config\harnesses.json'
npm exec vite -- --host 127.0.0.1 --port 5173 --strictPort
```

Python 必须已安装 Cleo 的依赖；可使用当前 Cleo 安装包附带的 Python。预览运行仓库中的
`cleo.desktop.local_config`，复用模型配置读取、候选目录和 RoutingControls，不启动会话、
记忆后台任务或推理执行。未连接成功时显示错误，不回退到演示数据。

“已添加连接”展示保存的连接及模型，明确区分配置记录与本次在线验证。
“子任务路由”读取同一份 `config/routing.json`，保存会修改本机实际路由配置。
桌面客户端下一次读取时获得更新，已运行的任务保持原设置；主会话模型不变。
新发现模型的启用状态遵循现有路由策略默认值和显式覆盖，预览不自动修改策略。

该接口仅在开发服务器显式开启，绑定 `127.0.0.1`，检查 Host、Origin 和每次启动生成的
请求 token，不提供 CORS；只允许读取连接、读取/保存路由、保存 AA 数据连接和手动刷新 benchmark。
模型验证、聊天、委派、模型连接凭据修改和任意桌面 RPC 均不开放。API key、连接 URL、客户端
可执行文件路径和后端原始诊断不会返回前端。

验证：`CLEO_TEST_PYTHON` 指定带有 Cleo 依赖的 Python 后，运行
`node tests/local-config.integration.mjs`（`ui` 目录），使用隔离配置与本地目录快照验证 HTTP
读写、冲突、密钥隐藏和访问限制，不使用真实密钥或付费调用。另有
`tests/routing/test_local_config.py` 的 fake provider 测试。

## 执行方式、AA 数据连接与独立 evaluator

开发任务输入框先选择两种执行方式之一：

- **指定已连接的 harness**：再选择该客户端实际发现的模型。自动子任务路由关闭。
- **子任务路由**：当前主模型负责拆分、调度、验收和最终回复，按子任务需求选择候选。
  不会把整个用户请求换给另一个主模型，也不保证所有任务同时获得最低 token 和最高质量。

模式保存在父会话的 `runtime_options.routing_mode`；修改模式不会修改父模型或权限。
默认方式和 evaluator 保存在相邻的 `routing-execution.json`，基础 `routing.json`
继续兼容上一版；旧版客户端会忽略扩展设置，使用新功能需要运行当前构建。

```json
{
  "default_mode": "auto",
  "evaluator": {
    "mode": "default",
    "profile_id": null,
    "model": null,
    "timeout_seconds": 60
  }
}
```

Evaluator 默认 `default`，使用 `active_profiles.agent` 指定的新对话默认连接及模型；
它随新对话默认设置更新，独立于当前任务已切换的主模型。如果该连接/模型就是协调者，
复用主模型正常拆分时提供的结构化评估；否则额外调用一次。用户可选择 `independent`，
并从已配置连接中选择 API（包括 OpenAI-compatible 的
DeepSeek 等）、Codex 或 Claude Code 的具体模型。它使用现有只读分析传输，隔离于任务
目录与会话索引；预览不会调用，仅实际委派前调用一次，会消耗 API 用量或订阅额度。
取消不会重试，失败不会静默回退或启动执行器。评估不能放宽原预算、截止时间、必要能力、
上下文和失败影响，也不能授予权限。存在美元预算时，当前无法可靠计入独立评估成本，
因此在调用前拒绝并交回协调者。Harness 的输出/花费没有硬上限保证，
只提供有界超时，实际评估用量缺失时记录未知。

“Benchmark 数据”可输入 Artificial Analysis 的 **数据 API** key、Free/Pro 级别和缓存有效期。
URL 固定为官方接口，不向可自定义地址发送密钥。Windows 本地密钥用当前用户 DPAPI
保护，其他平台文件仅所有者可读写；环境变量优先。保存不会自动请求数据，点击刷新才
拉取，失败保留最近有效缓存。页面不回显密钥，演示环境拒绝保存凭据。

刷新后在执行配置里点击“校准模型版本”，确认实际版本并绑定同推理档位的唯一评测。
可变别名不能自动当作固定版本。明确匹配后，router 可用 AA 分项分数、价格和速度；
软预算估算使用明确给出的输入/输出 token 估计，API 参考价格不会变成订阅实际账单。
完整 coding-agent 评测与模型级指数仍分开比较。校准不包含付费对照测试或自动训练。

接口口径参考：[官方 Data API 文档](https://artificialanalysis.ai/data-api/docs)、
[Free/Pro 字段与认证](https://artificialanalysis.ai/data-api/docs/reference)、
[Coding Agent Index 方法](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)。

# v0.10.0 本地迁移

路由和评估器与 v0.10.0 的通用项目、存储回收及启动入口兼容。迁移保留本机连接、路由策略和评估器选择；缺少 benchmark 时继续使用配置的保守回退，不自动请求评测或模型推理。

进化伴随窗口仅在进化版本切换、主界面暂不可用时打开。日常会话、进化聊天和检查构建都在主窗口内进行；新程序实际载入工作区后，伴随窗口自动退出。失败切换期间保留独立恢复入口与已排队的补充消息。普通版本切换继续使用原有安全重启进度窗口。

## 模型可用性与默认勾选

默认只勾选账号元数据、当前 harness 的运行时目录或正常执行记录确认支持的组合；用户取消勾选仍优先遵守。配置文件中的模型名、Codex 内置目录和 benchmark 记录都不等于账号权限。无法确认时标记“账号支持情况未知”，不通过推理探测来验证。

Codex 使用当前连接对应的原生登录凭据读取固定官方 `GET https://api.openai.com/v1/models` 元数据，再与本机 harness 的非隐藏目录取交集；查询失败或 schema 不明确时保持未知。自定义 backend 不会将凭据转发到该端点。参考 [OpenAI 账号模型目录](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) 与 [app-server 目录限制](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

正常主会话、子任务或 harness 评估器遇到明确的模型不支持错误时，以连接/账号摘要和模型为范围保存不可用记录；推理档位错误只排除该档位。记录在 `memory/.routing/availability/`，不含密钥、完整错误或 prompt。刷新目录、重启和修改勾选不会绕过拒绝；账号切换后按新的范围重新判定。网络、额度、认证、一般 400 和用户取消不会当作模型不支持，也不会触发自动换模型重放。
