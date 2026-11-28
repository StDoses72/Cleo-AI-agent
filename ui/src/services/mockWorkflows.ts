import { END, START, autoLayout, forwardEdges, loopBody, loopEdges } from "../components/workflows/workflow-model";
import type { ReasoningEffort, TimelineItem } from "../types";
import type {
  WorkflowClient,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowHarness,
  WorkflowLibrary,
  WorkflowNode,
  WorkflowNodeFields,
  WorkflowRole,
  WorkflowRun,
  WorkflowSession,
} from "../workflow-types";

/** Deterministic demo data: saved workflows, the executors they bind and a simulated orchestrator. */

const clone = <T,>(value: T): T => structuredClone(value);
const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const efforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const fast = [{ id: "fast" as const, label: "Fast", description: "1.5x speed, increased usage" }];

/** The same harnesses and models the composer's picker offers in demo mode. */
export const mockHarnesses: WorkflowHarness[] = [
  { id: "codex", label: "Codex", available: true, readOnly: true, tools: true, permissions: ["ask", "review", "full"], models: [
    { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: "Frontier coding model", isDefault: true, defaultEffort: "medium", supportedEfforts: efforts, serviceTiers: fast },
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", description: "Balanced coding model", isDefault: false, defaultEffort: "medium", supportedEfforts: efforts, serviceTiers: fast },
  ] },
  { id: "claude", label: "Claude", available: true, readOnly: true, tools: true, permissions: ["ask", "review", "full"], models: [
    { id: "claude-opus-5", label: "Claude Opus 5", description: "Configured model", isDefault: true, defaultEffort: "high", supportedEfforts: efforts },
    { id: "claude-sonnet-demo", label: "Claude Sonnet (demo)", description: "Mock harness choice", isDefault: false, defaultEffort: null, supportedEfforts: [] },
  ] },
  // An ACP harness has approvals and no sandbox: nothing holds a node on it to reading.
  { id: "opencode", label: "OpenCode", available: true, readOnly: false, tools: true, permissions: [], models: [
    { id: "opencode-default", label: "OpenCode (demo)", description: "Mock harness choice", isDefault: true, defaultEffort: null, supportedEfforts: [] },
  ] },
  { id: "antigravity", label: "Antigravity", available: false, reason: "未登录", readOnly: true, tools: false, permissions: ["ask", "full"], models: [
    { id: "gemini-pro-demo", label: "Gemini Pro (demo)", description: "Mock harness choice", isDefault: true, defaultEffort: null, supportedEfforts: [] },
  ] },
];

type Runtime = Pick<WorkflowNodeFields, "harness" | "model" | "effort" | "speed">;
const SOL: Runtime = { harness: "codex", model: "gpt-5.6-sol", effort: "high", speed: null };
const TERRA: Runtime = { harness: "codex", model: "gpt-5.6-terra", effort: "medium", speed: "fast" };
const OPUS: Runtime = { harness: "claude", model: "claude-opus-5", effort: "high", speed: null };
const SONNET: Runtime = { harness: "claude", model: "claude-sonnet-demo", effort: null, speed: null };

function node(id: string, role: string, runtime: Runtime, instructions: string,
  options: Partial<Pick<WorkflowNode, "access" | "workspace" | "delegation" | "permission" | "each">> = {}): WorkflowNode {
  return { id, role, ...runtime, instructions, access: "read", workspace: "shared", delegation: "default", permission: "review", each: null, x: 0, y: 0, ...options };
}

const edge = (id: string, from: string, to: string, loop?: WorkflowEdge["loop"]): WorkflowEdge => ({ id, from, to, ...(loop ? { loop } : {}) });

/** A chain of nodes from the task to the result, laid out left to right. */
function workflow(fields: Pick<WorkflowDefinition, "id" | "name" | "description" | "origin"> & { updatedAt?: string },
  nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowDefinition {
  return autoLayout({ ...fields, nodes, edges, start: { x: 0, y: 0 }, end: { x: 0, y: 0 } });
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const seedWorkflows: WorkflowDefinition[] = [
  workflow({ id: "wf-plan-refute", name: "规划 · 反驳 · 执行", origin: "user", updatedAt: hoursAgo(26),
    description: "规划者出方案，反驳者审过才能动手；通过后执行并验收。" }, [
    node("s1-planner", "规划者", OPUS, "把任务拆成可验证的步骤：列出要改的文件、每一步的验收方式和风险。收到反驳意见时逐条回应并修订方案。"),
    node("s1-refuter", "反驳者", SOL, "找出方案里会失败的地方：遗漏的调用方、没有覆盖的边界、无法验证的步骤。没有阻断问题时判定通过。"),
    node("s1-executor", "执行者", TERRA, "按通过的方案修改代码，不扩大范围；每完成一步运行对应的检查。", { access: "write" }),
    node("s1-acceptance", "验收者", OPUS, "对照方案里的验收方式逐项核对改动，给出通过或未通过的结论和证据。"),
  ], [
    edge("s1-e1", START, "s1-planner"), edge("s1-e2", "s1-planner", "s1-refuter"),
    edge("s1-back", "s1-refuter", "s1-planner", { maxRounds: 3, onExhausted: "stop" }),
    edge("s1-e3", "s1-refuter", "s1-executor"), edge("s1-e4", "s1-executor", "s1-acceptance"), edge("s1-e5", "s1-acceptance", END),
  ]),
  workflow({ id: "wf-cross-review", name: "多模型交叉评审", origin: "user", updatedAt: hoursAgo(72),
    description: "三个模型各看一个维度，全部完成后汇总成一份结论。" }, [
    node("s2-correct", "正确性审查", SOL, "只看逻辑是否正确：边界条件、错误处理、与测试描述是否一致。"),
    node("s2-security", "安全审查", OPUS, "只看安全：输入校验、路径与权限、敏感信息是否外泄。"),
    node("s2-maintain", "可维护性审查", SONNET, "只看可维护性：重复、命名、缺失的说明。"),
    node("s2-summary", "汇总者", TERRA, "把三份审查合成一份结论：先列必须处理的问题，再列建议。不新增自己的意见。"),
  ], [
    edge("s2-e1", START, "s2-correct"), edge("s2-e2", START, "s2-security"), edge("s2-e3", START, "s2-maintain"),
    edge("s2-e4", "s2-correct", "s2-summary"), edge("s2-e5", "s2-security", "s2-summary"), edge("s2-e6", "s2-maintain", "s2-summary"),
    edge("s2-e7", "s2-summary", END),
  ]),
  workflow({ id: "wf-fix-each", name: "缺陷逐项修复", origin: "user", updatedAt: hoursAgo(5),
    description: "审查者列出缺陷，每个缺陷由一个修复者在独立 worktree 里处理，最后复核。" }, [
    node("s3-reviewer", "审查者", OPUS, "列出当前改动中的缺陷，每条写明位置、现象和期望行为。以清单形式输出。"),
    node("s3-fixer", "修复者", SOL, "只修复分配给你的这一个缺陷，并补一条能复现它的测试。", { access: "write", workspace: "worktree", each: 4 }),
    node("s3-confirm", "复核者", OPUS, "逐项确认清单里的缺陷都已修复，并检查各修复之间有没有冲突。"),
  ], [
    edge("s3-e1", START, "s3-reviewer"), edge("s3-e2", "s3-reviewer", "s3-fixer"), edge("s3-e3", "s3-fixer", "s3-confirm"), edge("s3-e4", "s3-confirm", END),
  ]),
];

interface Handoff {
  text: string;
  items: string[];
  verdict?: "pass" | "revise";
}

interface ScriptContext {
  task: string;
  node: WorkflowNode;
  round?: number;
  item?: string;
  /** The node has a way back: its output carries a verdict. */
  judge: boolean;
  /** A node after this one runs once per list item, so this one returns a list. */
  listForNext: boolean;
}

const defectFixes: Record<string, string> = {
  "登录页在 375px 宽度下提交按钮溢出容器": "按钮改为随容器收缩，并补了 375px 视口的布局测试。",
  "重置密码邮件没有写明链接的有效期": "邮件模板加入「链接 30 分钟内有效」，并补了模板快照测试。",
  "连续点击提交会重复创建会话": "提交期间禁用按钮，服务端按请求键去重；补了重复提交的测试。",
};

const scripts: Record<string, (context: ScriptContext) => Handoff> = {
  "s1-planner": ({ task, round = 1 }) => ({ items: [], text: round === 1
    ? `针对「${task}」的方案（第 1 版）：\n1. 梳理入口：读相关模块和它的调用方，确认改动影响的范围。\n2. 实现改动：只改这次任务需要的文件，保持现有接口不变。\n3. 验证：为新行为补一条测试，并运行受影响模块的现有测试。\n风险：调用方可能依赖旧行为，第 1 步要列出全部调用点。`
    : `方案（第 ${round} 版），逐条回应反驳意见：\n· 旧数据：第 2 步增加兼容分支，旧记录按原逻辑处理，并在读取处补一条断言。\n· 回归检查：第 3 步改为先运行调用方的现有测试并记录结果，再补新行为的测试。\n其余步骤不变；改动范围仍限于这次任务涉及的文件。` }),
  "s1-refuter": ({ round = 1 }) => round === 1
    ? { items: [], verdict: "revise", text: "结论：需要修改。\n1. 第 2 步没有说明旧数据怎么处理，已有记录在新逻辑下会走到未定义的分支。\n2. 第 3 步只验证了新行为，缺少「旧行为不变」的回归检查，无法证明没有破坏调用方。" }
    : { items: [], verdict: "pass", text: "结论：通过。\n两条意见都已处理：兼容分支有断言可以验证，回归检查先于新测试。没有新的阻断问题。" },
  "s1-executor": () => ({ items: [], text: "已按通过的方案完成：\n· 修改 3 个文件（+86 −21），新增兼容分支和 1 条断言。\n· 调用方现有测试 14 项全部通过；新增测试 2 项通过。\n没有扩大范围，也没有改动公共接口。" }),
  "s1-acceptance": ({ task }) => ({ items: [], text: `「${task}」验收结论：通过。\n· 方案第 1 步：4 处调用点均已列出并检查。\n· 方案第 2 步：兼容分支存在，旧记录路径有断言。\n· 方案第 3 步：回归 14 项、新增 2 项测试的运行记录齐全。\n可以进入审查与提交。` }),
  "s2-correct": () => ({ items: [], text: "正确性：发现 1 个问题。\n· 分页游标在最后一页返回空字符串而不是 null，严格比较的调用方会多请求一次。\n其余逻辑与测试描述一致。" }),
  "s2-security": () => ({ items: [], text: "安全：没有阻断问题。\n· 新增的路径参数已规范化并限制在工作目录内。\n· 建议：错误信息不要回显完整的本地路径（低风险）。" }),
  "s2-maintain": () => ({ items: [], text: "可维护性：2 条建议。\n· loadPage 与 loadMore 有约 30 行重复，可以提取公共函数。\n· 新增常量缺少说明取值来源的注释。" }),
  "s2-summary": ({ task }) => ({ items: [], text: `「${task}」评审结论：可以合并，建议先处理 1 个问题。\n必须处理：分页游标在末页应返回 null（正确性）。\n建议处理：错误信息不回显完整路径（安全）；提取重复的分页逻辑（可维护性）。\n三个维度均已完成审查。` }),
  "s3-reviewer": ({ task }) => {
    const items = Object.keys(defectFixes);
    return { items, text: `在「${task}」涉及的改动中发现 ${items.length} 个缺陷：\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}` };
  },
  "s3-fixer": ({ item = "" }) => ({ items: [], text: `已修复：${item}\n· ${defectFixes[item] ?? "修改了相关文件并补充了复现测试。"}\n· 改动已提交到这个 worktree 的分支，相关测试通过。` }),
  "s3-confirm": () => ({ items: [], text: "复核结论：3 个缺陷全部修复。\n· 逐项核对了各修复分支的改动与测试记录。\n· 三个 worktree 的改动互不冲突，可以依次合并。" }),
};

const genericItems = ["梳理现状与影响范围", "实现核心改动", "补充测试与回归检查"];

/** Output for a node the user built: shaped by what its role sounds like. */
function genericScript({ task, node: current, round = 1, item, judge, listForNext }: ScriptContext): Handoff {
  const role = current.role.trim() || "节点";
  if (judge) {
    return round >= 2
      ? { items: [], verdict: "pass", text: "结论：通过。\n上一轮提出的问题都已处理，没有新的阻断问题。" }
      : { items: [], verdict: "revise", text: "结论：需要修改。\n1. 有一步没有说明怎样验证结果。\n2. 没有考虑改动对现有调用方的影响。" };
  }
  if (listForNext) {
    return { items: genericItems, text: `针对「${task}」整理出 ${genericItems.length} 项：\n${genericItems.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}` };
  }
  if (item) return { items: [], text: `已完成：${item}\n· 按指令处理了这一项，并记录了验证结果。` };
  if (/规划|计划|方案|plan/i.test(role)) {
    return { items: [], text: round > 1
      ? `方案（第 ${round} 版）：已逐条回应上一轮的意见，补充了验证方式与对调用方的影响说明。`
      : `针对「${task}」的方案：\n1. 确认范围与现状。\n2. 分步实现，每步可单独验证。\n3. 运行检查并整理结果。` };
  }
  if (/复核|确认|confirm/i.test(role)) return { items: [], text: `「${task}」复核结论：清单里的各项都已完成。\n· 逐项核对了每一项的改动与验证记录。\n· 各项改动互不冲突，可以依次合并。` };
  if (/审查|评审|反驳|review|critic|refut/i.test(role)) return { items: [], text: `${role}：没有发现阻断问题。\n· 提出 1 条改进建议，已写入结论。` };
  if (/执行|实现|修复|开发|implement|fix|build|execut/i.test(role)) return { items: [], text: "已完成改动：\n· 修改 2 个文件（+41 −9）。\n· 受影响的测试全部通过。" };
  if (/验收|测试|test|accept|verify/i.test(role)) return { items: [], text: `「${task}」验收结论：通过。\n· 逐项核对了上一步的产出与验证记录。` };
  if (/汇总|总结|summar/i.test(role)) return { items: [], text: `「${task}」汇总：各步骤均已完成，结论一致，没有未解决的分歧。` };
  return { items: [], text: `${role}已完成「${task}」中自己的部分，产出已交给下一步。` };
}

function hash(text: string) {
  let value = 7;
  for (const char of text) value = (value * 31 + char.codePointAt(0)!) % 100_003;
  return value;
}

class Stopped extends Error {}
/** The app went away under the run: it waits to be continued. */
class Paused extends Error {}

/** A node that fails is tried again this many times before the run gives up on it. */
const RETRIES = 3;

function excerpt(text: string, length: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

/** What a run has finished so far; kept between attempts so a retry resumes instead of starting over. */
interface Progress {
  done: Set<string>;
  outputs: Map<string, Handoff>;
  rounds: Map<string, number>;
  /** A replayed run keeps its own clock, so its durations add up in the past. */
  clock: number;
}

export class MockWorkflowClient implements WorkflowClient {
  private workflows = clone(seedWorkflows);
  private roles: WorkflowRole[] = [{ id: "role-security", fields: {
    role: "安全审查", ...OPUS, access: "read", workspace: "shared", delegation: "off", permission: "review", each: null,
    instructions: "做什么：只看安全，包括输入校验、路径与权限、敏感信息是否外泄。\n交回：按严重程度排列的问题清单，没有问题时明确说没有。\n不做：不评价风格，不修改代码。",
  } }];
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly progress = new Map<string, Progress>();
  private readonly versions = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly stopRequests = new Set<string>();
  /** Runs replayed without waiting: what a conversation already holds when the demo opens. */
  private readonly instant = new Set<string>();
  /** Replayed runs that go on in real time once this many sessions are behind them, at this pace. */
  private readonly live = new Map<string, { after: number; pace: number }>();
  /** Runs left under way that wait, at the session they are in, until someone looks at them. */
  private readonly held = new Set<string>();
  /** The demo's failure path: this reviewer hits a usage limit on its first attempt and on every
   * retry the run makes by itself. A replayed run names its own failure as `runId:nodeId` and
   * leaves this one for the user's first run. */
  private readonly failures = new Map([["s2-maintain", 1 + RETRIES]]);
  /** Runs that were under way when the app quit: they stop in the session they reach after this many. */
  private readonly quitAfter = new Map<string, number>();
  private readonly replayed = new Set<string>();
  /** What each session was handed when it started: the outputs it builds on, by who produced them. */
  private readonly given = new Map<string, { from: string; text: string }[]>();

  async library(): Promise<WorkflowLibrary> {
    await delay(180);
    return { workflows: clone(this.workflows), harnesses: clone(mockHarnesses), roles: clone(this.roles) };
  }

  async saveRole(fields: WorkflowNodeFields): Promise<WorkflowRole> {
    await delay(140);
    if (!fields.role.trim()) throw new Error("节点需要名称。");
    const role: WorkflowRole = { id: crypto.randomUUID(), fields: clone(fields) };
    // Saving under a name that is already kept replaces that definition.
    this.roles = [role, ...this.roles.filter((item) => item.fields.role !== fields.role)];
    return clone(role);
  }

  async removeRole(roleId: string): Promise<void> {
    await delay(100);
    this.roles = this.roles.filter((item) => item.id !== roleId);
  }

  /** The demo's stand-in for the drafting agent: a definition shaped by what the sentence asks for
   * and by the nodes around the one being written. */
  async draftNode(intent: string, definition: WorkflowDefinition, nodeId: string): Promise<Partial<WorkflowNodeFields>> {
    const text = intent.trim();
    if (!text) throw new Error("需要一句描述。");
    await delay(1100);
    const forward = forwardEdges(definition);
    const roleOf = (id: string) => id === START ? "任务" : id === END ? "结果" : definition.nodes.find((item) => item.id === id)?.role || "上一个节点";
    const before = forward.filter((link) => link.to === nodeId).map((link) => roleOf(link.from));
    const after = forward.filter((link) => link.from === nodeId).map((link) => roleOf(link.to));
    const source = before.length ? `${before.join("、")}的产出` : "任务描述";
    const target = after.length ? `交给${after.join("、")}` : "作为这一步的结果";
    // What the sentence asks to be done decides the role; the first kind that fits wins.
    const kinds: [RegExp, string, string, string, Partial<WorkflowNodeFields>][] = [
      [/实现|修改代码|改代码|修复|开发|写代码|implement|fix|build/i, "执行者", "改动的摘要和检查结果", "不扩大范围，不改无关文件", { ...TERRA, access: "write" }],
      [/反驳|审查|评审|把关|挑错|review|critic/i, "审查者", "通过或不通过的结论，不通过时逐条列出问题", "不替对方改，只指出问题", SOL],
      [/规划|计划|拆成|拆解|出方案|plan/i, "规划者", "一份分步骤的方案，每一步写明怎样验证", "不修改任何文件", OPUS],
      [/测试|验收|核对|test|verify|accept/i, "验收者", "逐项核对的结论和证据", "不修改代码", OPUS],
      [/汇总|总结|合并|整理|summar/i, "汇总者", "一份合并后的结论，先列必须处理的", "不新增自己的意见", TERRA],
    ];
    const [, role, returns, limits, runtime] = kinds.find(([pattern]) => pattern.test(text)) ?? [/./, excerpt(text, 8).replace(/…$/, ""), "这一步的产出，写明依据", "不做这句话以外的事", {}];
    return { role, ...runtime,
      instructions: `做什么：${text.replace(/[。.]$/, "")}。依据${source}。\n交回：${returns}，${target}。\n不做：${limits}。` };
  }

  async save(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    await delay(160);
    if (!definition.name.trim()) throw new Error("工作流需要一个名称。");
    const saved = { ...clone(definition), name: definition.name.trim(), updatedAt: new Date().toISOString() };
    const index = this.workflows.findIndex((item) => item.id === saved.id);
    if (index >= 0) this.workflows[index] = saved; else this.workflows.unshift(saved);
    return clone(saved);
  }

  async remove(workflowId: string): Promise<void> {
    await delay(120);
    this.workflows = this.workflows.filter((item) => item.id !== workflowId);
  }

  async draft(task: string): Promise<WorkflowDefinition> {
    const text = task.trim();
    if (!text) throw new Error("先描述要完成的任务。");
    await delay(1500);
    const id = crypto.randomUUID();
    const part = (name: string) => `${id}-${name}`;
    const chain = (...ids: string[]) => ids.slice(0, -1).map((from, index) => edge(part(`e${index}`), from, ids[index + 1]));
    if (/修复|缺陷|bug|报错|fix/i.test(text)) {
      return workflow({ id, origin: "drafted", name: "审查 · 逐项修复 · 复核",
        description: `任务提到修复问题，所以先由审查者列出清单，再逐项并行修复，最后复核。任务：${excerpt(text, 40)}` }, [
        node(part("reviewer"), "审查者", OPUS, "列出与任务有关的缺陷，每条写明位置、现象和期望行为。以清单形式输出。"),
        node(part("fixer"), "修复者", SOL, "只修复分配给你的这一项，并补一条能复现它的测试。", { access: "write", workspace: "worktree", each: 4 }),
        node(part("confirm"), "复核者", OPUS, "逐项确认清单里的问题都已修复，并检查各修复之间有没有冲突。"),
      ], chain(START, part("reviewer"), part("fixer"), part("confirm"), END));
    }
    if (/审查|评审|检查|review|audit/i.test(text)) {
      return workflow({ id, origin: "drafted", name: "分维度评审 · 汇总",
        description: `任务是评审，所以让两个模型各看一个维度，再合成一份结论。任务：${excerpt(text, 40)}` }, [
        node(part("correct"), "正确性审查", SOL, "只看逻辑是否正确：边界条件、错误处理、与测试描述是否一致。"),
        node(part("risk"), "风险审查", OPUS, "只看风险：安全、数据兼容、对现有调用方的影响。"),
        node(part("summary"), "汇总者", TERRA, "把各份审查合成一份结论：先列必须处理的问题，再列建议。不新增自己的意见。"),
      ], [
        edge(part("e0"), START, part("correct")), edge(part("e1"), START, part("risk")),
        edge(part("e2"), part("correct"), part("summary")), edge(part("e3"), part("risk"), part("summary")), edge(part("e4"), part("summary"), END),
      ]);
    }
    return workflow({ id, origin: "drafted", name: "规划 · 反驳 · 执行",
      description: `这是一项需要先想清楚再动手的改动，所以方案要先过反驳者，再执行和验收。任务：${excerpt(text, 40)}` }, [
      node(part("planner"), "规划者", OPUS, "把任务拆成可验证的步骤：列出要改的文件、每一步的验收方式和风险。收到反驳意见时逐条回应并修订方案。"),
      node(part("refuter"), "反驳者", SOL, "找出方案里会失败的地方。没有阻断问题时判定通过。"),
      node(part("executor"), "执行者", TERRA, "按通过的方案修改代码，不扩大范围；每完成一步运行对应的检查。", { access: "write" }),
      node(part("acceptance"), "验收者", OPUS, "对照方案里的验收方式逐项核对改动，给出结论和证据。"),
    ], [
      ...chain(START, part("planner"), part("refuter"), part("executor"), part("acceptance"), END),
      edge(part("back"), part("refuter"), part("planner"), { maxRounds: 3, onExhausted: "stop" }),
    ]);
  }

  /** A saved workflow by id, as a conversation names it when it starts one. */
  definition(workflowId: string): WorkflowDefinition | null {
    const found = this.workflows.find((item) => item.id === workflowId);
    return found ? clone(found) : null;
  }

  // What follows runs a workflow. It is not part of the library contract: a conversation's turn
  // drives it, as the backend's orchestrator would be driven by the `/workflow` command.
  async start(definition: WorkflowDefinition, task: string, projectId: string): Promise<WorkflowRun> {
    await delay(240);
    if (!task.trim()) throw new Error("需要一个任务。");
    const run = this.createRun(definition, task.trim(), projectId, Date.now());
    void this.execute(run.id);
    return clone(run);
  }

  /** Purpose: A run that already happened, or is under way, when the demo opens. It is replayed
   * without waiting so its sessions and times read as real. `liveAfter` leaves it running: after
   * that many sessions it is in real time, where it waits in the session it reached until
   * `release`, then goes on `pace` times slower than a run the user starts. Nothing about it
   * changes while nobody looks. `failed` names a node that fails until the run gives up on it;
   * `retried` then resumes it once. `quitAfter` leaves it paused in the session after that many. */
  seed(workflowId: string, task: string, projectId: string,
    options: { startedAt: number; liveAfter?: number; pace?: number; failed?: string; retried?: boolean; quitAfter?: number }): string {
    const run = this.createRun(seedWorkflows.find((item) => item.id === workflowId)!, task, projectId, options.startedAt);
    this.instant.add(run.id);
    this.replayed.add(run.id);
    if (options.liveAfter !== undefined) { this.live.set(run.id, { after: options.liveAfter, pace: options.pace ?? 1 }); this.held.add(run.id); }
    if (options.failed) this.failures.set(`${run.id}:${options.failed}`, 1 + RETRIES);
    if (options.quitAfter !== undefined) this.quitAfter.set(run.id, options.quitAfter);
    void this.execute(run.id).then(() => {
      if (run.status !== "failed" || !options.retried) return;
      // The retry came a while after the failure.
      this.progress.get(run.id)!.clock += 13 * 60_000;
      void this.restart(run.id);
    });
    return run.id;
  }

  /** Lets a run that was left waiting go on. */
  release(runId: string) {
    this.held.delete(runId);
  }

  /** The run as it is now. */
  run(runId: string): WorkflowRun | null {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }

  /** Purpose: One session of a run as a conversation of its own: what the node was handed, what
   * it did, and what it handed back. This is what opening a node in full shows. */
  sessionConversation(run: WorkflowRun, session: WorkflowSession): { title: string; items: TimelineItem[] } {
    const node = run.definition.nodes.find((item) => item.id === session.nodeId);
    const at = (time: number) => new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const started = session.startedAt ?? run.startedAt;
    const handed = this.given.get(session.id) ?? [];
    // Read as Markdown, like any message: bullets become list items, other lines paragraphs.
    const prose = (text: string) => text.replace(/^· /gm, "- ").replace(/\n(?!- |\d+\. |\n)/g, "\n\n");
    const brief = [
      node?.instructions ?? "",
      `任务：${run.task}`,
      ...(session.item ? [`分配给你的这一项：${session.item}`] : []),
      ...(session.round && session.round > 1 ? [`这是第 ${session.round} 轮。`] : []),
      ...handed.flatMap((input) => [`**${input.from}交来的产出**`, prose(input.text)]),
    ].filter(Boolean).join("\n\n");
    const work = /执行|实现|修复|开发|implement|fix|build|execut/i.test(session.role)
      ? { thought: "按交来的方案修改代码，并运行受影响的测试", command: "npm test -- export", output: "✓ export pagination (6)\n✓ export legacy records (3)\n9 passed" }
      : /验收|测试|复核|确认|test|accept|verify|confirm/i.test(session.role)
        ? { thought: "对照交来的产出逐项核对改动和运行记录", command: "git diff --stat main", output: " src/api/export.ts        | 61 ++++++++----\n tests/export.test.ts     | 46 ++++++++\n 2 files changed, 86 insertions(+), 21 deletions(-)" }
        : { thought: "阅读相关模块和它的调用方，确认范围", command: "rg -n \"exportNotes|pageCursor\" src", output: "src/api/export.ts:14:export async function exportNotes(\nsrc/api/export.ts:52:  const pageCursor = next ?? null;\nsrc/routes/notes.ts:88:  return exportNotes(request.query);" };
    const id = (part: string) => `${session.id}-${part}`;
    const items: TimelineItem[] = [{ id: id("brief"), type: "message", role: "user", content: brief, time: at(started) }];
    items.push({ id: id("thought"), type: "thought", content: work.thought, status: session.status === "running" ? "running" : "done" });
    if (session.status === "done") items.push(
      { id: id("tool"), type: "tool", name: "shell", command: work.command, status: "done", exitCode: 0, durationMs: 300 + (hash(session.id) % 2400), output: work.output },
      { id: id("reply"), type: "message", role: "assistant", content: prose(session.output ?? ""), time: at(started + (session.elapsedMs ?? 0)) });
    else if (session.status === "failed") items.push({ id: id("failed"), type: "notice", tone: "warning", title: "没有完成", detail: session.error ?? "" });
    else if (session.status === "cancelled") items.push({ id: id("stopped"), type: "notice", tone: "info", title: "已取消", detail: "" });
    // A node that was tried again has one session per attempt.
    const attempts = run.sessions.filter((other) => other.nodeId === session.nodeId && other.round === session.round && other.item === session.item);
    const attempt = attempts.findIndex((other) => other.id === session.id);
    const title = [session.role, session.round ? `第 ${session.round} 轮` : "", session.item ? excerpt(session.item, 12) : "",
      attempt > 0 ? `重试${attempt > 1 ? ` ${attempt}` : ""}` : ""].filter(Boolean).join(" · ");
    return { title, items };
  }

  async *watch(runId: string): AsyncGenerator<WorkflowRun> {
    for (;;) {
      const run = this.runs.get(runId);
      if (!run) throw new Error("没有找到这次运行。");
      const seen = this.versions.get(runId) ?? 0;
      const snapshot = clone(run);
      yield snapshot;
      // Decided on what the reader was given: the run may have moved on while it was being read.
      if (snapshot.status !== "running") return;
      if ((this.versions.get(runId) ?? 0) !== seen) continue;
      await new Promise<void>((resolve) => {
        const waiting = this.waiters.get(runId) ?? new Set();
        waiting.add(resolve);
        this.waiters.set(runId, waiting);
      });
    }
  }

  /** Stops every agent of a run and returns once they have stopped. */
  async stop(runId: string): Promise<void> {
    if (this.runs.get(runId)?.status !== "running") return;
    this.stopRequests.add(runId);
    for (let waited = 0; waited < 1500 && this.runs.get(runId)?.status === "running"; waited += 40) await delay(40);
    // One more beat, so whoever watches the run has read how it ended.
    await delay(60);
  }

  /** Runs again from where it failed or was left, keeping what the finished nodes produced. */
  async resume(runId: string): Promise<boolean> {
    const status = this.runs.get(runId)?.status;
    if (status !== "failed" && status !== "paused") return false;
    this.quitAfter.delete(runId);
    // A retry the user asks for happens now, whenever the run it continues took place.
    this.instant.delete(runId);
    void this.restart(runId);
    return true;
  }

  private restart(runId: string) {
    const run = this.runs.get(runId)!;
    const progress = this.progress.get(runId)!;
    // A loop that ran out of rounds starts counting again.
    for (const back of loopEdges(run.definition)) {
      if (!progress.done.has(back.from) && (progress.rounds.get(back.id) ?? 0) >= back.loop!.maxRounds) {
        progress.rounds.delete(back.id);
        delete run.rounds[back.id];
      }
    }
    run.status = "running";
    run.error = undefined;
    run.finishedAt = undefined;
    this.changed(runId);
    return this.execute(runId);
  }

  private createRun(definition: WorkflowDefinition, task: string, projectId: string, startedAt: number): WorkflowRun {
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId: this.workflows.some((item) => item.id === definition.id) ? definition.id : null,
      definition: clone(definition), task, projectId, status: "running", sessions: [], rounds: {}, startedAt,
    };
    this.runs.set(run.id, run);
    this.progress.set(run.id, { done: new Set(), outputs: new Map(), rounds: new Map(), clock: startedAt });
    return run;
  }

  private changed(runId: string) {
    this.versions.set(runId, (this.versions.get(runId) ?? 0) + 1);
    const waiting = this.waiters.get(runId);
    this.waiters.delete(runId);
    for (const resolve of waiting ?? []) resolve();
  }

  /** Purpose: Push the task along the edges. A node starts once every node before it has
   * finished; nodes that are ready together run together. A judge that does not pass sends the
   * stretch it judges round again; after a failure nothing new starts, and what is running finishes. */
  private async execute(runId: string) {
    const run = this.runs.get(runId)!;
    const progress = this.progress.get(runId)!;
    const definition = run.definition;
    const forward = forwardEdges(definition);
    const sources = (id: string) => forward.filter((link) => link.to === id).map((link) => link.from);
    const finished = (id: string) => id === START || progress.done.has(id);
    const running = new Map<string, Promise<{ id: string; error?: unknown }>>();
    let failure: unknown = null;
    for (;;) {
      if (!failure) {
        for (const current of definition.nodes) {
          if (progress.done.has(current.id) || running.has(current.id)) continue;
          const before = sources(current.id);
          if (!before.length || !before.every(finished)) continue;
          running.set(current.id, this.runNode(run, progress, current)
            .then(() => ({ id: current.id }), (error: unknown) => ({ id: current.id, error })));
        }
      }
      if (!running.size) break;
      const settled = await Promise.race(running.values());
      running.delete(settled.id);
      if (settled.error) { failure ??= settled.error; continue; }
      progress.done.add(settled.id);
      const back = definition.edges.find((link) => link.loop && link.from === settled.id);
      if (back && progress.outputs.get(settled.id)?.verdict !== "pass") {
        const round = progress.rounds.get(back.id) ?? 1;
        const body = loopBody(definition, back);
        if (round < back.loop!.maxRounds) {
          progress.rounds.set(back.id, round + 1);
          run.rounds[back.id] = round + 1;
          for (const id of body) progress.done.delete(id);
          this.changed(runId);
        } else if (back.loop!.onExhausted === "stop") {
          // Nothing after the loop may start: the work was never passed.
          for (const id of body) progress.done.delete(id);
          const judge = definition.nodes.find((item) => item.id === back.from)?.role ?? "";
          failure ??= new Error(`${judge}在 ${back.loop!.maxRounds} 轮后仍未通过，需要你决定怎样继续。`);
        }
      }
    }
    const last = sources(END);
    if (failure instanceof Stopped) run.status = "cancelled";
    else if (failure instanceof Paused) run.status = "paused";
    else if (failure) { run.status = "failed"; run.error = failure instanceof Error ? failure.message : String(failure); }
    else if (!last.length || !last.every(finished)) { run.status = "failed"; run.error = "流程没有到达结果：有节点没有接到前面的输出。"; }
    else {
      run.status = "completed";
      const outputs = last.filter((id) => id !== START).map((id) => progress.outputs.get(id)!);
      run.result = outputs.length === 1 ? outputs[0].text
        : last.filter((id) => id !== START).map((id, index) => `【${definition.nodes.find((item) => item.id === id)?.role ?? ""}】\n${outputs[index].text}`).join("\n\n");
    }
    run.finishedAt = this.instant.has(runId) ? progress.clock : Date.now();
    this.stopRequests.delete(runId);
    this.changed(runId);
  }

  /** One node: a single session, or one per item of the list the node before it returned. */
  private async runNode(run: WorkflowRun, progress: Progress, current: WorkflowNode) {
    const definition = run.definition;
    const forward = forwardEdges(definition);
    const loop = loopEdges(definition).find((back) => loopBody(definition, back).includes(current.id));
    let round: number | undefined;
    if (loop) {
      round = progress.rounds.get(loop.id) ?? 1;
      progress.rounds.set(loop.id, round);
      run.rounds[loop.id] = round;
    }
    const judge = definition.edges.some((link) => link.loop && link.from === current.id);
    const listForNext = forward.some((link) => link.from === current.id
      && definition.nodes.find((item) => item.id === link.to)?.each != null);
    const session = (item?: string) => this.runSession(run, progress, current, { round, item, judge, listForNext });
    if (current.each === null) { progress.outputs.set(current.id, await session()); return; }
    const before = forward.find((link) => link.to === current.id)?.from ?? "";
    const items = (progress.outputs.get(before)?.items ?? []).slice(0, current.each);
    if (!items.length) throw new Error(`${current.role}没有可以展开的清单：上一个节点没有返回列表。`);
    const results = await Promise.allSettled(items.map((item) => session(item)));
    const reasons = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    const cause = reasons.find((reason) => reason instanceof Stopped || reason instanceof Paused) ?? reasons[0];
    if (cause) throw cause;
    progress.outputs.set(current.id, { items: [],
      text: results.map((result, index) => `【${items[index]}】\n${result.status === "fulfilled" ? result.value.text : ""}`).join("\n\n") });
  }

  /** One piece of a node's work: a session, and a new one for each time it has to be tried again. */
  private async runSession(run: WorkflowRun, progress: Progress, current: WorkflowNode,
    options: { round?: number; item?: string; judge: boolean; listForNext: boolean }): Promise<Handoff> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.runAttempt(run, progress, current, options); }
      catch (error) { if (error instanceof Stopped || error instanceof Paused || attempt >= RETRIES) throw error; }
    }
  }

  private async runAttempt(run: WorkflowRun, progress: Progress, current: WorkflowNode,
    options: { round?: number; item?: string; judge: boolean; listForNext: boolean }): Promise<Handoff> {
    // A run seeded as under way has replayed what is behind it: from here it goes on in real
    // time, and what was replayed moves so that it ends now.
    const live = this.live.get(run.id);
    if (live && run.sessions.length >= live.after && this.instant.delete(run.id)) {
      const shift = Date.now() - progress.clock;
      run.startedAt += shift;
      for (const earlier of run.sessions) if (earlier.startedAt !== undefined) earlier.startedAt += shift;
    }
    const replay = this.instant.has(run.id);
    const now = () => replay ? progress.clock : Date.now();
    const harness = mockHarnesses.find((item) => item.id === current.harness);
    const model = harness?.models.find((item) => item.id === current.model);
    const record: WorkflowSession = {
      id: crypto.randomUUID(), nodeId: current.id, role: current.role,
      executor: harness && model ? `${harness.label} · ${model.label}` : "",
      access: current.access, workspace: current.workspace, status: "running",
      round: options.round, item: options.item, startedAt: now(),
    };
    record.threadId = `node-${record.id}`;
    // A node reads what the nodes before it produced; one a loop came back to also reads the verdict.
    const role = (id: string) => run.definition.nodes.find((item) => item.id === id)?.role ?? "";
    const back = loopEdges(run.definition).find((link) => link.to === current.id && (options.round ?? 1) > 1);
    this.given.set(record.id, [
      ...forwardEdges(run.definition).filter((link) => link.to === current.id && link.from !== START).map((link) => link.from),
      ...(back ? [back.from] : []),
    ].flatMap((id) => { const text = progress.outputs.get(id)?.text; return text ? [{ from: role(id), text }] : []; }));
    run.sessions.push(record);
    this.changed(run.id);
    const seed = hash(`${current.id}:${options.round ?? 0}:${options.item ?? ""}`);
    const duration = (1000 + (seed % 1400)) * (replay ? 1 : live?.pace ?? 1);
    const finish = (status: WorkflowSession["status"]) => {
      record.status = status;
      record.elapsedMs = now() - record.startedAt!;
      this.changed(run.id);
    };
    if ((this.quitAfter.get(run.id) ?? Infinity) < run.sessions.length) {
      progress.clock += duration * 12;
      finish("cancelled");
      throw new Paused();
    }
    if (replay) progress.clock += duration * 40;
    else {
      // Left waiting: the time that passes meanwhile is not part of the run.
      const since = Date.now();
      while (this.held.has(run.id)) {
        await delay(120);
        if (this.stopRequests.has(run.id)) { finish("cancelled"); throw new Stopped(); }
      }
      const waited = Date.now() - since;
      if (waited > 200) {
        run.startedAt += waited;
        for (const other of run.sessions) if (other.startedAt !== undefined) other.startedAt += waited;
        this.changed(run.id);
      }
      const started = Date.now();
      while (Date.now() - started < duration) {
        await delay(80);
        if (this.stopRequests.has(run.id)) { finish("cancelled"); throw new Stopped(); }
      }
    }
    const failing = this.failures.has(`${run.id}:${current.id}`) ? `${run.id}:${current.id}` : this.replayed.has(run.id) ? "" : current.id;
    const left = this.failures.get(failing) ?? 0;
    if (left > 0) {
      this.failures.set(failing, left - 1);
      record.error = "Claude 的用量窗口已满，约 12 分钟后重置。";
      finish("failed");
      throw new Error(`${current.role}没有完成：${record.error}`);
    }
    const script = (scripts[current.id] ?? genericScript)({
      task: excerpt(run.task, 28), node: current, round: options.round, item: options.item, judge: options.judge, listForNext: options.listForNext,
    });
    record.output = script.text;
    record.verdict = options.judge ? script.verdict ?? "pass" : undefined;
    record.tokens = 1800 + (seed % 5200);
    finish("done");
    return { ...script, verdict: record.verdict };
  }
}
