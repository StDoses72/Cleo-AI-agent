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

/** A harness a node can run on, with the models it offers (each with its thinking levels and speeds). */
export interface WorkflowHarness {
  id: string;
  label: string;
  available: boolean;
  /** Why it cannot run now (signed out, not installed); shown next to the choice. */
  reason?: string | null;
  /** It can hold a node to reading: a node on a harness that cannot always may edit files. */
  readOnly: boolean;
  /** It receives Cleo's tools, which is how a node returns a verdict or a list. */
  tools: boolean;
  models: import("./types").RuntimeModelOption[];
}

export type WorkflowAccess = "read" | "write";
/** Where a node that may edit files works: the task's folder, or a git worktree of its own. */
export type WorkflowWorkspace = "shared" | "worktree";
/** Whether the node may hand subtasks to other models; "default" follows the routing switch. */
export type WorkflowDelegation = "default" | "on" | "off";
/** What a node does when an action needs approval: goes on within its limits, or asks in the
 * conversation that started the run. */
export type WorkflowApproval = "auto" | "ask";

/** What a node is, apart from where it sits: the part that can be kept and used again. */
export interface WorkflowNodeFields {
  role: string;
  /** What the node is responsible for, in one text: written by the user or drafted by Cleo. */
  instructions: string;
  /** `null` runs on the harness and model of the conversation that starts the workflow. */
  harness: string | null;
  model: string | null;
  effort: import("./types").ReasoningEffort | null;
  speed: import("./types").ServiceTier | null;
  access: WorkflowAccess;
  workspace: WorkflowWorkspace;
  delegation: WorkflowDelegation;
  approval: WorkflowApproval;
  /** Runs one copy per item of the list the node before it returned, up to this many; `null` runs once. */
  each: number | null;
}

export interface WorkflowNode extends WorkflowNodeFields {
  id: string;
  /** Cleo drafted the definition and the user has not opened it yet. */
  drafted?: boolean;
  /** Where the node sits on the canvas. Layout only: it never changes what runs. */
  x: number;
  y: number;
}

/** A node definition the user kept for reuse. Placing it on a canvas copies it. */
export interface WorkflowRole {
  id: string;
  fields: WorkflowNodeFields;
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
  /** The conversation that holds this session's own timeline, where it can be opened in full. */
  threadId?: string;
}

/** "paused": the app quit or crashed while it ran; it goes on from the nodes that had not finished. */
export type WorkflowRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

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

export interface WorkflowLibrary {
  workflows: WorkflowDefinition[];
  harnesses: WorkflowHarness[];
  roles: WorkflowRole[];
}

/** The library of workflows and node definitions. A workflow is started in a conversation, with
 * the `/workflow` command, and its run arrives there as a timeline item; nothing here runs one. */
export interface WorkflowClient {
  library(): Promise<WorkflowLibrary>;
  save(definition: WorkflowDefinition): Promise<WorkflowDefinition>;
  remove(workflowId: string): Promise<void>;
  /** Have Cleo write one node's definition from a sentence. It is shown the workflow the node
   * sits in, so it knows what comes before and after. Nothing is saved. */
  draftNode(intent: string, definition: WorkflowDefinition, nodeId: string): Promise<Partial<WorkflowNodeFields>>;
  saveRole(fields: WorkflowNodeFields): Promise<WorkflowRole>;
  removeRole(roleId: string): Promise<void>;
}
