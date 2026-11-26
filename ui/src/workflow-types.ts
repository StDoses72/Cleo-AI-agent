/**
 * Custom workflows: an orchestration the user owns. It says who must take part and in what
 * order; the agent inside a node cannot start or skip an edge. A node receives its input (the
 * task and what the nodes before it produced) and returns its output, and never sees the graph.
 *
 * A workflow is drawn as a graph of agent nodes between two fixed ends, the task going in and
 * the result coming out. Its edges are the only control structures there are: a node follows
 * another (sequence), a node with several edges out starts them side by side and a node with
 * several edges in waits for all of them (parallel and join), and an edge back to an earlier
 * node repeats the stretch between them a bounded number of times (loop).
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

export interface WorkflowNode {
  id: string;
  role: string;
  /** `null` runs on the model of the conversation that starts the workflow. */
  executorId: string | null;
  instructions: string;
  access: WorkflowAccess;
  workspace: WorkflowWorkspace;
  delegation: WorkflowDelegation;
  /** Runs one copy per item of the list the node before it returned, up to this many; `null` runs once. */
  each: number | null;
  /** Where the node sits on the canvas. Layout only: it never changes what runs. */
  x: number;
  y: number;
}

export interface WorkflowEdge {
  id: string;
  /** A node id, or "start" for the task. */
  from: string;
  /** A node id, or "end" for the result. */
  to: string;
  /** Set on an edge back to an earlier node: taken while `from` judges the work as not passing,
   * until the stretch between the two has run `maxRounds` times. */
  loop?: {
    maxRounds: number;
    /** When the rounds run out without a pass: stop for the user, or carry on with what there is. */
    onExhausted: "stop" | "continue";
  };
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Canvas positions of the two fixed ends. */
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Who wrote it first: the user, or Cleo from a task description. */
  origin: "user" | "drafted";
  /** Absent until it has been saved. */
  updatedAt?: string;
}

export type WorkflowNodeStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** One agent session a run started. A node inside a loop has one per round, a node that runs
 * per item one per item, and a retried node one per attempt. */
export interface WorkflowSession {
  id: string;
  nodeId: string;
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
  /** The decision of a node that judges a loop. */
  verdict?: "pass" | "revise";
  error?: string;
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
  /** Every agent session the run started, oldest first. */
  sessions: WorkflowSession[];
  /** The round each loop is in, by the id of its edge back; absent before the loop is entered. */
  rounds: Record<string, number>;
  startedAt: number;
  finishedAt?: number;
  /** What reached the result, once the run completes. */
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
  /** Run again from where it failed, keeping what the finished nodes produced. */
  retry(runId: string): Promise<void>;
}
