import type {
  WorkflowAgentStep,
  WorkflowDefinition,
  WorkflowExecutor,
  WorkflowLoopStep,
  WorkflowParallelStep,
  WorkflowStep,
} from "../../workflow-types";

export const MAX_ROUNDS = 5;
export const MAX_ITEMS = 8;

export type WorkflowIssueCode =
  | "name_missing"
  | "no_steps"
  | "role_missing"
  | "instructions_missing"
  | "executor_unknown"
  | "executor_unavailable"
  | "branches_too_few"
  | "each_needs_previous"
  | "each_needs_template"
  | "loop_empty"
  | "judge_missing"
  | "rounds_out_of_range"
  | "items_out_of_range";

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  /** The top-level step to open; `null` for the workflow itself. */
  stepId: string | null;
  /** The agent inside that step, when the problem is one node's. */
  nodeId?: string;
  /** The node's role or the step's label, for the message. */
  subject?: string;
  /** The step's place in the sequence, counted from 1, for a node that has no name to go by. */
  position?: number;
}

export function newId() {
  return crypto.randomUUID();
}

export function newAgent(role = ""): WorkflowAgentStep {
  return { kind: "agent", id: newId(), role, executorId: null, instructions: "", access: "read", workspace: "shared", delegation: "default" };
}

export function newParallel(label: string, branches: WorkflowAgentStep[] = [newAgent(), newAgent()]): WorkflowParallelStep {
  return { kind: "parallel", id: newId(), label, fanOut: "branches", branches, maxItems: 4 };
}

export function newLoop(label: string, body: WorkflowAgentStep[] = [newAgent(), newAgent()]): WorkflowLoopStep {
  return { kind: "loop", id: newId(), label, body, maxRounds: 3, judgeId: body.at(-1)?.id ?? "", onExhausted: "stop" };
}

export function newWorkflow(name = ""): WorkflowDefinition {
  return { id: newId(), name, description: "", steps: [], origin: "user" };
}

/** Every agent node of a step, in the order it would run. */
export function agentsOf(step: WorkflowStep): WorkflowAgentStep[] {
  return step.kind === "agent" ? [step] : step.kind === "parallel" ? step.branches : step.body;
}

export function allAgents(definition: WorkflowDefinition): WorkflowAgentStep[] {
  return definition.steps.flatMap(agentsOf);
}

/** The name a phase goes by: an agent step is its role, a group its own label. */
export function stepLabel(step: WorkflowStep) {
  return step.kind === "agent" ? step.role : step.label;
}

/** Purpose: The most agent sessions one run can start, so the user can judge its cost before it runs.
 * Input: a definition. Output: loops count every round, "each" its item limit. */
export function agentBound(definition: WorkflowDefinition) {
  return definition.steps.reduce((total, step) => total + (
    step.kind === "agent" ? 1
      : step.kind === "parallel" ? (step.fanOut === "each" ? step.maxItems : step.branches.length)
      : step.body.length * step.maxRounds), 0);
}

/** Purpose: Everything that keeps a workflow from running, found before any agent starts.
 * Input: the definition and the executors that exist now. Output: issues in reading order. */
export function workflowIssues(definition: WorkflowDefinition, executors: readonly WorkflowExecutor[]): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (!definition.name.trim()) issues.push({ code: "name_missing", stepId: null });
  if (!definition.steps.length) issues.push({ code: "no_steps", stepId: null });
  const known = new Map(executors.map((executor) => [executor.id, executor]));
  definition.steps.forEach((step, index) => {
    const subject = stepLabel(step).trim();
    if (step.kind === "parallel") {
      if (step.fanOut === "branches" && step.branches.length < 2) issues.push({ code: "branches_too_few", stepId: step.id, subject });
      if (step.fanOut === "each") {
        if (!step.branches.length) issues.push({ code: "each_needs_template", stepId: step.id, subject });
        // The list comes from the step before; a loop hands on its last round's output, not a list.
        if (definition.steps[index - 1]?.kind !== "agent") issues.push({ code: "each_needs_previous", stepId: step.id, subject });
        if (!Number.isInteger(step.maxItems) || step.maxItems < 2 || step.maxItems > MAX_ITEMS) {
          issues.push({ code: "items_out_of_range", stepId: step.id, subject });
        }
      }
    }
    if (step.kind === "loop") {
      if (!step.body.length) issues.push({ code: "loop_empty", stepId: step.id, subject });
      else if (!step.body.some((node) => node.id === step.judgeId)) issues.push({ code: "judge_missing", stepId: step.id, subject });
      if (!Number.isInteger(step.maxRounds) || step.maxRounds < 1 || step.maxRounds > MAX_ROUNDS) {
        issues.push({ code: "rounds_out_of_range", stepId: step.id, subject });
      }
    }
    // An "each" step runs copies of its first branch only.
    const nodes = step.kind === "parallel" && step.fanOut === "each" ? step.branches.slice(0, 1) : agentsOf(step);
    for (const node of nodes) {
      const role = node.role.trim();
      // A node without a name is reported once; its other gaps show when it can be named in a message.
      if (!role) { issues.push({ code: "role_missing", stepId: step.id, nodeId: node.id, position: index + 1 }); continue; }
      if (!node.instructions.trim()) issues.push({ code: "instructions_missing", stepId: step.id, nodeId: node.id, subject: role });
      if (node.executorId !== null) {
        const executor = known.get(node.executorId);
        if (!executor) issues.push({ code: "executor_unknown", stepId: step.id, nodeId: node.id, subject: role });
        else if (!executor.available) issues.push({ code: "executor_unavailable", stepId: step.id, nodeId: node.id, subject: role });
      }
    }
  });
  return issues;
}

/** Purpose: Reorder the top-level sequence. Input: an index and a direction. Output: a new array,
 * unchanged when the move would leave the list. */
export function moveStep<T>(steps: readonly T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (target < 0 || target >= steps.length) return [...steps];
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** A copy that can be saved next to the original: fresh ids everywhere, the judge re-pointed. */
export function duplicateWorkflow(definition: WorkflowDefinition, name: string): WorkflowDefinition {
  const ids = new Map<string, string>();
  const fresh = (id: string) => { ids.set(id, newId()); return ids.get(id)!; };
  const agent = (node: WorkflowAgentStep): WorkflowAgentStep => ({ ...node, id: fresh(node.id) });
  const steps = definition.steps.map((step): WorkflowStep => step.kind === "agent" ? agent(step)
    : step.kind === "parallel" ? { ...step, id: fresh(step.id), branches: step.branches.map(agent) }
    : { ...step, id: fresh(step.id), body: step.body.map(agent) });
  for (const step of steps) if (step.kind === "loop") step.judgeId = ids.get(step.judgeId) ?? step.judgeId;
  return { ...definition, id: newId(), name, steps, origin: "user", updatedAt: undefined };
}
