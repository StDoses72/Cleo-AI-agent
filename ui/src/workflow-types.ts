/**
 * Custom workflows: an orchestration the user owns. It says who must take part and in what
 * order; the agent inside a node cannot start or skip an edge. A node receives its input (the
 * task and what the step before it produced) and returns its output, and never sees the graph.
 *
 * Only three control structures exist: the top-level sequence, a bounded loop and a parallel
 * fan-out that joins before the next step.
 */

/** One execution choice from the shared candidate catalog: connection + harness + model + effort. */
export interface WorkflowExecutor {
  id: string;
  harness: string;
  model: string;
  effort: import("./types").ReasoningEffort | null;
  available: boolean;
  /** Why it cannot run now (signed out, not installed); shown next to the choice. */
  reason?: string | null;
}

export type WorkflowAccess = "read" | "write";
/** Where a node that may edit files works: the task's folder, or a git worktree of its own. */
export type WorkflowWorkspace = "shared" | "worktree";
/** Whether the node may hand subtasks to other models; "default" follows the routing switch. */
export type WorkflowDelegation = "default" | "on" | "off";

export interface WorkflowAgentStep {
  kind: "agent";
  id: string;
  role: string;
  /** `null` runs on the model of the conversation that starts the workflow. */
  executorId: string | null;
  instructions: string;
  access: WorkflowAccess;
  workspace: WorkflowWorkspace;
  delegation: WorkflowDelegation;
}

export interface WorkflowParallelStep {
  kind: "parallel";
  id: string;
  label: string;
  /** "branches": every branch runs once, side by side. "each": one copy of the first branch
   * per item of the list the previous step returned. */
  fanOut: "branches" | "each";
  branches: WorkflowAgentStep[];
  /** Upper bound on copies for "each". */
  maxItems: number;
}

export interface WorkflowLoopStep {
  kind: "loop";
  id: string;
  label: string;
  /** Run in order every round. */
  body: WorkflowAgentStep[];
  maxRounds: number;
  /** The body step whose verdict ends the loop. */
  judgeId: string;
  /** When the rounds run out without a pass: stop for the user, or carry on with what there is. */
  onExhausted: "stop" | "continue";
}

export type WorkflowStep = WorkflowAgentStep | WorkflowParallelStep | WorkflowLoopStep;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** Who wrote it first: the user, or Cleo from a task description. */
  origin: "user" | "drafted";
  /** Absent until it has been saved. */
  updatedAt?: string;
}

export type WorkflowNodeStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** One agent session a run started. A loop step has one per round, an "each" branch one per item. */
export interface WorkflowNodeRun {
  id: string;
  stepId: string;
  role: string;
  executor: string;
  access: WorkflowAccess;
  workspace: WorkflowWorkspace;
  status: WorkflowNodeStatus;
  round?: number;
  item?: string;
  startedAt?: number;
  elapsedMs?: number;
  tokens?: number;
  output?: string;
  /** A judge's decision in a loop. */
  verdict?: "pass" | "revise";
  error?: string;
}

export interface WorkflowPhaseRun {
  stepId: string;
  kind: WorkflowStep["kind"];
  label: string;
  status: WorkflowNodeStatus;
  round?: number;
  maxRounds?: number;
  nodes: WorkflowNodeRun[];
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  /** The saved workflow it came from; `null` for a draft that was run without saving. */
  workflowId: string | null;
  /** What ran, as it was when the run started. */
  definition: WorkflowDefinition;
  task: string;
  projectId: string;
  status: WorkflowRunStatus;
  phases: WorkflowPhaseRun[];
  startedAt: number;
  finishedAt?: number;
  /** The last step's output, once the run completes. */
  result?: string;
  error?: string;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string | null;
  name: string;
  task: string;
  projectId: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
}

export interface WorkflowLibrary {
  workflows: WorkflowDefinition[];
  executors: WorkflowExecutor[];
  runs: WorkflowRunSummary[];
}

export interface WorkflowClient {
  library(): Promise<WorkflowLibrary>;
  save(definition: WorkflowDefinition): Promise<WorkflowDefinition>;
  remove(workflowId: string): Promise<void>;
  /** Have Cleo propose a workflow for a task. Nothing is saved and nothing runs. */
  draft(task: string): Promise<WorkflowDefinition>;
  start(definition: WorkflowDefinition, task: string, projectId: string): Promise<WorkflowRun>;
  /** A run as it advances: the current state first, then every change until it stops. */
  watch(runId: string): AsyncGenerator<WorkflowRun>;
  /** Stops every agent the run started. */
  cancel(runId: string): Promise<void>;
  /** Run again from the phase that failed, keeping what the earlier phases produced. */
  retry(runId: string): Promise<void>;
}
