import { stepLabel } from "../components/workflows/workflow-model";
import type {
  WorkflowAgentStep,
  WorkflowClient,
  WorkflowDefinition,
  WorkflowExecutor,
  WorkflowLibrary,
  WorkflowLoopStep,
  WorkflowNodeRun,
  WorkflowParallelStep,
  WorkflowPhaseRun,
  WorkflowRun,
} from "../workflow-types";

/** Deterministic demo data: saved workflows, the executors they bind and a simulated orchestrator. */

const clone = <T,>(value: T): T => structuredClone(value);
const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export const mockExecutors: WorkflowExecutor[] = [
  { id: "codex/gpt-5.6-sol@high", harness: "Codex", model: "gpt-5.6-sol", effort: "high", available: true },
  { id: "codex/gpt-5.6-terra@medium", harness: "Codex", model: "gpt-5.6-terra", effort: "medium", available: true },
  { id: "claude/claude-opus-5@high", harness: "Claude", model: "claude-opus-5", effort: "high", available: true },
  { id: "claude/claude-sonnet-demo", harness: "Claude", model: "claude-sonnet-demo", effort: null, available: true },
  { id: "antigravity/gemini-pro-demo", harness: "Antigravity", model: "gemini-pro-demo", effort: null, available: false, reason: "未登录" },
];

const SOL = "codex/gpt-5.6-sol@high";
const TERRA = "codex/gpt-5.6-terra@medium";
const OPUS = "claude/claude-opus-5@high";
const SONNET = "claude/claude-sonnet-demo";

function agent(id: string, role: string, executorId: string | null, instructions: string,
  options: Partial<Pick<WorkflowAgentStep, "access" | "workspace" | "delegation">> = {}): WorkflowAgentStep {
  return { kind: "agent", id, role, executorId, instructions, access: "read", workspace: "shared", delegation: "default", ...options };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const seedWorkflows: WorkflowDefinition[] = [
  {
    id: "wf-plan-refute",
    name: "规划 · 反驳 · 执行",
    description: "规划者出方案，反驳者审过才能动手；通过后执行并验收。",
    origin: "user",
    updatedAt: hoursAgo(26),
    steps: [
      {
        kind: "loop", id: "s1-debate", label: "方案对抗", maxRounds: 3, judgeId: "s1-refuter", onExhausted: "stop",
        body: [
          agent("s1-planner", "规划者", OPUS, "把任务拆成可验证的步骤：列出要改的文件、每一步的验收方式和风险。收到反驳意见时逐条回应并修订方案。"),
          agent("s1-refuter", "反驳者", SOL, "找出方案里会失败的地方：遗漏的调用方、没有覆盖的边界、无法验证的步骤。没有阻断问题时判定通过。"),
        ],
      },
      agent("s1-executor", "执行者", TERRA, "按通过的方案修改代码，不扩大范围；每完成一步运行对应的检查。", { access: "write" }),
      agent("s1-acceptance", "验收者", OPUS, "对照方案里的验收方式逐项核对改动，给出通过或未通过的结论和证据。"),
    ],
  },
  {
    id: "wf-cross-review",
    name: "多模型交叉评审",
    description: "三个模型各看一个维度，全部完成后汇总成一份结论。",
    origin: "user",
    updatedAt: hoursAgo(72),
    steps: [
      {
        kind: "parallel", id: "s2-review", label: "分维度审查", fanOut: "branches", maxItems: 4,
        branches: [
          agent("s2-correct", "正确性审查", SOL, "只看逻辑是否正确：边界条件、错误处理、与测试描述是否一致。"),
          agent("s2-security", "安全审查", OPUS, "只看安全：输入校验、路径与权限、敏感信息是否外泄。"),
          agent("s2-maintain", "可维护性审查", SONNET, "只看可维护性：重复、命名、缺失的说明。"),
        ],
      },
      agent("s2-summary", "汇总者", TERRA, "把三份审查合成一份结论：先列必须处理的问题，再列建议。不新增自己的意见。"),
    ],
  },
  {
    id: "wf-fix-each",
    name: "缺陷逐项修复",
    description: "审查者列出缺陷，每个缺陷由一个修复者在独立 worktree 里处理，最后复核。",
    origin: "user",
    updatedAt: hoursAgo(5),
    steps: [
      agent("s3-reviewer", "审查者", OPUS, "列出当前改动中的缺陷，每条写明位置、现象和期望行为。以清单形式输出。"),
      {
        kind: "parallel", id: "s3-fix", label: "逐项修复", fanOut: "each", maxItems: 4,
        branches: [agent("s3-fixer", "修复者", SOL, "只修复分配给你的这一个缺陷，并补一条能复现它的测试。", { access: "write", workspace: "worktree" })],
      },
      agent("s3-confirm", "复核者", OPUS, "逐项确认清单里的缺陷都已修复，并检查各修复之间有没有冲突。"),
    ],
  },
];

interface Handoff {
  text: string;
  items: string[];
  verdict?: "pass" | "revise";
}

interface ScriptContext {
  task: string;
  step: WorkflowAgentStep;
  round?: number;
  item?: string;
  judge: boolean;
  /** The next step starts one agent per list item, so this one returns a list. */
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
function genericScript({ task, step, round = 1, item, judge, listForNext }: ScriptContext): Handoff {
  const role = step.role.trim() || "节点";
  const verdict = judge ? (round >= 2 ? "pass" : "revise") : undefined;
  if (judge) {
    return { items: [], verdict, text: verdict === "pass"
      ? "结论：通过。\n上一轮提出的问题都已处理，没有新的阻断问题。"
      : "结论：需要修改。\n1. 有一步没有说明怎样验证结果。\n2. 没有考虑改动对现有调用方的影响。" };
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
  if (/审查|评审|反驳|review|critic/i.test(role)) return { items: [], text: `${role}：没有发现阻断问题。\n· 提出 1 条改进建议，已写入结论。` };
  if (/执行|实现|修复|开发|implement|fix|build/i.test(role)) return { items: [], text: "已完成改动：\n· 修改 2 个文件（+41 −9）。\n· 受影响的测试全部通过。" };
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
/** A sibling in the same parallel group failed, so this branch was cancelled. */
class Aborted extends Error {}

function excerpt(text: string, length: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

export class MockWorkflowClient implements WorkflowClient {
  private workflows = clone(seedWorkflows);
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly versions = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly stopRequests = new Set<string>();
  /** Output handed on after each phase, kept so a retry can resume from the failed one. */
  private readonly handoffs = new Map<string, Handoff[]>();
  /** Runs replayed without waiting, to seed the history. */
  private readonly instant = new Set<string>();
  /** The demo's failure path: this reviewer's first attempt hits a usage limit. */
  private readonly failOnce = new Set(["s2-maintain"]);

  constructor() {
    // The history starts with one finished run, so the page has something to reopen.
    const past: WorkflowRun = this.createRun(seedWorkflows[0], "给导出接口加上分页", "cleo-agent", Date.now() - 2 * 3_600_000);
    this.instant.add(past.id);
    void this.execute(past.id, 0);
  }

  async library(): Promise<WorkflowLibrary> {
    await delay(180);
    const runs = [...this.runs.values()].sort((left, right) => right.startedAt - left.startedAt).map((run) => ({
      id: run.id, workflowId: run.workflowId, name: run.definition.name, task: run.task, projectId: run.projectId,
      status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
    }));
    return { workflows: clone(this.workflows), executors: clone(mockExecutors), runs };
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
    if (/修复|缺陷|bug|报错|fix/i.test(text)) {
      return { id, origin: "drafted", name: "审查 · 逐项修复 · 复核",
        description: `任务提到修复问题，所以先由审查者列出清单，再逐项并行修复，最后复核。任务：${excerpt(text, 40)}`,
        steps: [
          agent(part("reviewer"), "审查者", OPUS, "列出与任务有关的缺陷，每条写明位置、现象和期望行为。以清单形式输出。"),
          { kind: "parallel", id: part("fix"), label: "逐项修复", fanOut: "each", maxItems: 4,
            branches: [agent(part("fixer"), "修复者", SOL, "只修复分配给你的这一项，并补一条能复现它的测试。", { access: "write", workspace: "worktree" })] },
          agent(part("confirm"), "复核者", OPUS, "逐项确认清单里的问题都已修复，并检查各修复之间有没有冲突。"),
        ] };
    }
    if (/审查|评审|检查|review|audit/i.test(text)) {
      return { id, origin: "drafted", name: "分维度评审 · 汇总",
        description: `任务是评审，所以让两个模型各看一个维度，再合成一份结论。任务：${excerpt(text, 40)}`,
        steps: [
          { kind: "parallel", id: part("review"), label: "分维度审查", fanOut: "branches", maxItems: 4,
            branches: [
              agent(part("correct"), "正确性审查", SOL, "只看逻辑是否正确：边界条件、错误处理、与测试描述是否一致。"),
              agent(part("risk"), "风险审查", OPUS, "只看风险：安全、数据兼容、对现有调用方的影响。"),
            ] },
          agent(part("summary"), "汇总者", TERRA, "把各份审查合成一份结论：先列必须处理的问题，再列建议。不新增自己的意见。"),
        ] };
    }
    const planner = agent(part("planner"), "规划者", OPUS, "把任务拆成可验证的步骤：列出要改的文件、每一步的验收方式和风险。收到反驳意见时逐条回应并修订方案。");
    const refuter = agent(part("refuter"), "反驳者", SOL, "找出方案里会失败的地方。没有阻断问题时判定通过。");
    return { id, origin: "drafted", name: "规划 · 反驳 · 执行",
      description: `这是一项需要先想清楚再动手的改动，所以方案要先过反驳者，再执行和验收。任务：${excerpt(text, 40)}`,
      steps: [
        { kind: "loop", id: part("debate"), label: "方案对抗", body: [planner, refuter], maxRounds: 3, judgeId: refuter.id, onExhausted: "stop" },
        agent(part("executor"), "执行者", TERRA, "按通过的方案修改代码，不扩大范围；每完成一步运行对应的检查。", { access: "write" }),
        agent(part("acceptance"), "验收者", OPUS, "对照方案里的验收方式逐项核对改动，给出结论和证据。"),
      ] };
  }

  async start(definition: WorkflowDefinition, task: string, projectId: string): Promise<WorkflowRun> {
    await delay(240);
    if (!task.trim()) throw new Error("先写下这次要完成的任务。");
    const run = this.createRun(definition, task.trim(), projectId, Date.now());
    void this.execute(run.id, 0);
    return clone(run);
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

  async cancel(runId: string): Promise<void> {
    if (this.runs.get(runId)?.status === "running") this.stopRequests.add(runId);
  }

  async retry(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "failed") return;
    const from = run.phases.findIndex((phase) => phase.status === "failed");
    if (from < 0) return;
    run.status = "running";
    run.error = undefined;
    run.finishedAt = undefined;
    this.changed(runId);
    void this.execute(runId, from);
  }

  private createRun(definition: WorkflowDefinition, task: string, projectId: string, startedAt: number): WorkflowRun {
    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId: this.workflows.some((item) => item.id === definition.id) ? definition.id : null,
      definition: clone(definition), task, projectId, status: "running", startedAt,
      phases: definition.steps.map((step): WorkflowPhaseRun => ({
        stepId: step.id, kind: step.kind, label: stepLabel(step), status: "pending", nodes: [],
        ...(step.kind === "loop" ? { round: 0, maxRounds: step.maxRounds } : {}),
      })),
    };
    this.runs.set(run.id, run);
    this.handoffs.set(run.id, []);
    return run;
  }

  private changed(runId: string) {
    this.versions.set(runId, (this.versions.get(runId) ?? 0) + 1);
    const waiting = this.waiters.get(runId);
    this.waiters.delete(runId);
    for (const resolve of waiting ?? []) resolve();
  }

  private async execute(runId: string, from: number) {
    const run = this.runs.get(runId)!;
    const handoffs = this.handoffs.get(runId)!;
    // A replayed run keeps its own clock so its durations add up in the past.
    let clock = run.startedAt;
    const now = () => this.instant.has(runId) ? clock : Date.now();
    const spend = (milliseconds: number) => { clock += milliseconds; };
    let handoff: Handoff = from > 0 ? handoffs[from - 1] : { text: run.task, items: [] };
    try {
      for (let index = from; index < run.phases.length; index += 1) {
        const step = run.definition.steps[index];
        const phase = run.phases[index];
        phase.status = "running";
        phase.nodes = [];
        if (phase.kind === "loop") phase.round = 0;
        this.changed(runId);
        const next = run.definition.steps[index + 1];
        const listForNext = next?.kind === "parallel" && next.fanOut === "each";
        const context = { run, phase, now, spend, listForNext };
        handoff = step.kind === "agent" ? await this.runAgent(context, step, {})
          : step.kind === "parallel" ? await this.runParallel(context, step, handoff)
          : await this.runLoop(context, step);
        handoffs[index] = handoff;
        phase.status = "done";
        this.changed(runId);
      }
      run.status = "completed";
      run.result = handoff.text;
    } catch (error) {
      const stopped = error instanceof Stopped;
      for (const phase of run.phases) if (phase.status === "running") phase.status = stopped ? "cancelled" : "failed";
      run.status = stopped ? "cancelled" : "failed";
      run.error = stopped ? undefined : error instanceof Error ? error.message : String(error);
    }
    run.finishedAt = now();
    this.stopRequests.delete(runId);
    this.changed(runId);
  }

  private async runAgent(
    context: { run: WorkflowRun; phase: WorkflowPhaseRun; now: () => number; spend: (milliseconds: number) => void; listForNext: boolean },
    step: WorkflowAgentStep,
    options: { round?: number; item?: string; judge?: boolean; group?: { aborted: boolean } },
  ): Promise<Handoff> {
    const { run, phase } = context;
    const executor = mockExecutors.find((item) => item.id === step.executorId);
    const node: WorkflowNodeRun = {
      id: crypto.randomUUID(), stepId: step.id, role: step.role,
      executor: executor ? `${executor.harness} · ${executor.model}` : "",
      access: step.access, workspace: step.workspace, status: "running",
      round: options.round, item: options.item, startedAt: context.now(),
    };
    phase.nodes.push(node);
    this.changed(run.id);
    const seed = hash(`${step.id}:${options.round ?? 0}:${options.item ?? ""}`);
    const duration = 1000 + (seed % 1400);
    const finish = (status: WorkflowNodeRun["status"]) => {
      node.status = status;
      node.elapsedMs = context.now() - node.startedAt!;
      this.changed(run.id);
    };
    if (this.instant.has(run.id)) context.spend(duration * 40);
    else {
      const started = Date.now();
      while (Date.now() - started < duration) {
        await delay(80);
        if (this.stopRequests.has(run.id)) { finish("cancelled"); throw new Stopped(); }
        if (options.group?.aborted) { finish("cancelled"); throw new Aborted(); }
      }
    }
    if (this.failOnce.delete(step.id)) {
      node.error = "Claude 的用量窗口已满，约 12 分钟后重置。";
      finish("failed");
      throw new Error(`${step.role}没有完成：${node.error}`);
    }
    const script = (scripts[step.id] ?? genericScript)({
      task: excerpt(run.task, 28), step, round: options.round, item: options.item,
      judge: Boolean(options.judge), listForNext: context.listForNext,
    });
    node.output = script.text;
    node.verdict = script.verdict;
    node.tokens = 1800 + (seed % 5200);
    finish("done");
    return script;
  }

  private async runParallel(
    context: Parameters<MockWorkflowClient["runAgent"]>[0], step: WorkflowParallelStep, input: Handoff,
  ): Promise<Handoff> {
    const targets = step.fanOut === "each"
      ? input.items.slice(0, step.maxItems).map((item) => ({ node: step.branches[0], item }))
      : step.branches.map((node) => ({ node, item: undefined }));
    if (!targets.length) throw new Error(`「${step.label}」没有可以展开的清单：上一步没有返回列表。`);
    // One failure cancels the branches that are still running.
    const group = { aborted: false };
    const results = await Promise.allSettled(targets.map((target) =>
      this.runAgent({ ...context, listForNext: false }, target.node, { item: target.item, group }).catch((error: unknown) => {
        if (!(error instanceof Aborted)) group.aborted = true;
        throw error;
      })));
    const reasons = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    const stop = reasons.find((reason) => reason instanceof Stopped) ?? reasons.find((reason) => !(reason instanceof Aborted));
    if (stop) throw stop;
    const texts = results.map((result, index) =>
      `【${targets[index].item ?? targets[index].node.role}】\n${result.status === "fulfilled" ? result.value.text : ""}`);
    return { text: texts.join("\n\n"), items: [] };
  }

  private async runLoop(context: Parameters<MockWorkflowClient["runAgent"]>[0], step: WorkflowLoopStep): Promise<Handoff> {
    let work: Handoff = { text: "", items: [] };
    for (let round = 1; round <= step.maxRounds; round += 1) {
      context.phase.round = round;
      this.changed(context.run.id);
      let verdict: Handoff["verdict"];
      for (const node of step.body) {
        const judge = node.id === step.judgeId;
        const output = await this.runAgent({ ...context, listForNext: false }, node, { round, judge });
        if (judge) verdict = output.verdict;
        // The loop hands on what was judged, not the verdict; a lone judge hands on its own output.
        if (!judge || step.body.length === 1) work = output;
      }
      if (verdict === "pass") return work;
    }
    if (step.onExhausted === "stop") throw new Error(`「${step.label}」${step.maxRounds} 轮后仍未通过，需要你决定怎样继续。`);
    return work;
  }
}
