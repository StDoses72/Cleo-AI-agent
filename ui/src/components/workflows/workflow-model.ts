import type { WorkflowDefinition, WorkflowEdge, WorkflowHarness, WorkflowNode, WorkflowNodeFields } from "../../workflow-types";

/** The two fixed ends of every workflow: the task going in and the result coming out. */
export const START = "start";
export const END = "end";

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 64;
export const TERMINAL_WIDTH = 64;
export const TERMINAL_HEIGHT = 30;
export const GRID = 8;
export const MAX_ROUNDS = 5;
export const MAX_ITEMS = 8;

export type WorkflowIssueCode =
  | "name_missing"
  | "no_nodes"
  | "start_unconnected"
  | "end_unconnected"
  | "role_missing"
  | "instructions_missing"
  | "runtime_unknown"
  | "runtime_unavailable"
  | "node_no_input"
  | "node_no_output"
  | "cycle"
  | "loop_target"
  | "loop_rounds"
  | "loop_leak"
  | "loop_overlap"
  | "tools_missing"
  | "each_predecessor"
  | "each_range";

export interface WorkflowIssue {
  code: WorkflowIssueCode;
  /** The node to select, when the problem is one node's. */
  nodeId?: string;
  /** The edge to select, when the problem is a loop's. */
  edgeId?: string;
  /** The node's role, or the two ends of a loop, for the message. */
  subject?: string;
}

export function newId() {
  return crypto.randomUUID();
}

export const snap = (value: number) => Math.round(value / GRID) * GRID;

export const blankFields: WorkflowNodeFields = { role: "", instructions: "", harness: null, model: null, effort: null, speed: null,
  access: "read", workspace: "shared", delegation: "default", approval: "auto", each: null };

export function newNode(x: number, y: number, fields: Partial<WorkflowNodeFields> = {}): WorkflowNode {
  return { id: newId(), ...blankFields, ...fields, x: snap(x), y: snap(y) };
}

/** A node's definition without its place on a canvas, as it is kept for reuse or copied. */
export function fieldsOf(node: WorkflowNode): WorkflowNodeFields {
  const { id: _id, x: _x, y: _y, drafted: _drafted, ...fields } = node;
  return fields;
}

/** Purpose: Choose a harness or model for a node and drop what the new choice does not offer.
 * Input: the node, the harnesses that exist and the change. Output: fields that hold together:
 * a model of that harness, a thinking level and a speed that model has. */
export function withRuntime(node: WorkflowNode, harnesses: readonly WorkflowHarness[],
  change: Partial<Pick<WorkflowNodeFields, "harness" | "model" | "effort" | "speed">>): WorkflowNode {
  const chosen = harnesses.find((item) => item.id === (change.harness ?? node.harness));
  // A harness that cannot hold a node to reading leaves no such node to set.
  const next = { ...node, ...change, ...(chosen && !chosen.readOnly ? { access: "write" as const } : {}) };
  const harness = harnesses.find((item) => item.id === next.harness);
  if (!harness) return { ...next, harness: change.harness === undefined ? next.harness : null, model: null, effort: null, speed: null };
  const model = harness.models.find((item) => item.id === next.model) ?? harness.models.find((item) => item.isDefault) ?? harness.models[0];
  if (!model) return { ...next, model: null, effort: null, speed: null };
  const effort = next.effort && model.supportedEfforts.includes(next.effort) ? next.effort
    : "model" in change || "harness" in change ? model.defaultEffort : null;
  const speed = next.speed && next.speed !== "default" && model.serviceTiers?.some((tier) => tier.id === next.speed) ? next.speed : null;
  return { ...next, model: model.id, effort, speed };
}

export function newWorkflow(name = ""): WorkflowDefinition {
  return { id: newId(), name, description: "", nodes: [], edges: [], start: { x: 296, y: 48 }, end: { x: 296, y: 408 }, origin: "user" };
}

export function forwardEdges(definition: WorkflowDefinition) {
  return definition.edges.filter((edge) => !edge.loop);
}

export function loopEdges(definition: WorkflowDefinition) {
  return definition.edges.filter((edge) => edge.loop);
}

function successors(definition: WorkflowDefinition) {
  const next = new Map<string, string[]>();
  for (const edge of forwardEdges(definition)) next.set(edge.from, [...next.get(edge.from) ?? [], edge.to]);
  return next;
}

/** Everything `from` leads to along forward edges, itself included. */
function reachable(next: Map<string, string[]>, from: string) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) for (const id of next.get(queue.pop()!) ?? []) if (!seen.has(id)) { seen.add(id); queue.push(id); }
  return seen;
}

/** Whether `to` comes after `from` (or is it) along forward edges. */
export function reaches(definition: WorkflowDefinition, from: string, to: string) {
  return reachable(successors(definition), from).has(to);
}

/** Purpose: The stretch a loop repeats. Input: an edge back from a judge to an earlier node.
 * Output: every node on a path from that node to the judge, both ends included; empty when the
 * edge does not point backwards. */
export function loopBody(definition: WorkflowDefinition, edge: WorkflowEdge): string[] {
  const next = successors(definition);
  const after = reachable(next, edge.to);
  if (!after.has(edge.from)) return [];
  return definition.nodes.filter((node) => after.has(node.id) && reachable(next, node.id).has(edge.from)).map((node) => node.id);
}

export type ConnectRefusal = "same" | "exists" | "direction" | "second_loop";

/** Purpose: Draw an edge. An edge to a node that already comes before its source would close a
 * circle, so it becomes that source's way back: a loop with a round limit.
 * Input: the two ends. Output: the new definition and edge, or why the edge cannot exist. */
export function connect(definition: WorkflowDefinition, from: string, to: string):
  { definition: WorkflowDefinition; edge: WorkflowEdge } | { refused: ConnectRefusal } {
  if (from === to) return { refused: "same" };
  if (from === END || to === START || (from === START && to === END)) return { refused: "direction" };
  if (definition.edges.some((edge) => edge.from === from && edge.to === to)) return { refused: "exists" };
  const back = from !== START && to !== END && reaches(definition, to, from);
  // One node judges one loop: a second way back would leave two verdicts to obey.
  if (back && definition.edges.some((edge) => edge.loop && edge.from === from)) return { refused: "second_loop" };
  const edge: WorkflowEdge = { id: newId(), from, to, ...(back ? { loop: { maxRounds: 3, onExhausted: "stop" as const } } : {}) };
  return { definition: { ...definition, edges: [...definition.edges, edge] }, edge };
}

export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.filter((node) => node.id !== nodeId),
    edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId) };
}

export function removeEdge(definition: WorkflowDefinition, edgeId: string): WorkflowDefinition {
  return { ...definition, edges: definition.edges.filter((edge) => edge.id !== edgeId) };
}

/** Purpose: Put a new node on the canvas. The flow runs top to bottom, so the result end moves
 * down when the node would sit on it. */
export function addNode(definition: WorkflowDefinition, node: WorkflowNode): WorkflowDefinition {
  const covers = node.y + NODE_HEIGHT + 16 > definition.end.y && node.y < definition.end.y + TERMINAL_HEIGHT
    && Math.abs(node.x + NODE_WIDTH / 2 - (definition.end.x + TERMINAL_WIDTH / 2)) < NODE_WIDTH;
  return { ...definition, nodes: [...definition.nodes, node],
    end: covers ? { ...definition.end, y: snap(node.y + NODE_HEIGHT + 48) } : definition.end };
}

/** Where a node added without pointing lands: under what is there. */
export function freeSpot(definition: WorkflowDefinition) {
  if (!definition.nodes.length) return { x: definition.start.x + TERMINAL_WIDTH / 2 - NODE_WIDTH / 2, y: definition.start.y + TERMINAL_HEIGHT + 40 };
  const last = definition.nodes.reduce((lowest, node) => node.y > lowest.y ? node : lowest);
  return { x: last.x, y: last.y + NODE_HEIGHT + 40 };
}

/** Purpose: The nodes in the order they can run: a row per step away from the task, counted
 * along the longest path. A node nothing leads to sits in the first row. */
export function layers(definition: WorkflowDefinition): WorkflowNode[][] {
  const next = successors(definition);
  const depth = new Map<string, number>();
  const walk = (id: string, level: number, trail: Set<string>) => {
    if (trail.has(id) || (depth.get(id) ?? -1) >= level) return;
    depth.set(id, level);
    trail.add(id);
    for (const follower of next.get(id) ?? []) if (follower !== END) walk(follower, level + 1, trail);
    trail.delete(id);
  };
  walk(START, 0, new Set());
  for (const node of definition.nodes) if (!depth.has(node.id)) walk(node.id, 1, new Set());
  const columns: WorkflowNode[][] = [];
  for (const node of definition.nodes) (columns[depth.get(node.id)! - 1] ??= []).push(node);
  return columns.filter(Boolean).map((column) => column.sort((left, right) => left.x - right.x || left.y - right.y));
}

/** Purpose: The most agent sessions one run can start, so the user can judge its cost before it runs.
 * A node inside a loop counts once per round, a node that runs per item once per item. */
export function agentBound(definition: WorkflowDefinition) {
  const rounds = new Map<string, number>();
  for (const edge of loopEdges(definition)) {
    for (const id of loopBody(definition, edge)) rounds.set(id, Math.max(rounds.get(id) ?? 1, edge.loop!.maxRounds));
  }
  return definition.nodes.reduce((total, node) => total + (node.each ?? 1) * (rounds.get(node.id) ?? 1), 0);
}

function hasCycle(definition: WorkflowDefinition) {
  const next = successors(definition);
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string): boolean => {
    if (state.get(id) === "open") return true;
    if (state.get(id) === "closed") return false;
    state.set(id, "open");
    const found = (next.get(id) ?? []).some(visit);
    state.set(id, "closed");
    return found;
  };
  return [START, ...definition.nodes.map((node) => node.id)].some(visit);
}

/** Purpose: Everything that keeps a workflow from running, found before any agent starts.
 * Input: the definition and the harnesses that exist now. Output: issues in reading order. */
export function workflowIssues(definition: WorkflowDefinition, harnesses: readonly WorkflowHarness[]): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (!definition.name.trim()) issues.push({ code: "name_missing" });
  if (!definition.nodes.length) { issues.push({ code: "no_nodes" }); return issues; }
  const forward = forwardEdges(definition);
  if (!forward.some((edge) => edge.from === START)) issues.push({ code: "start_unconnected" });
  if (!forward.some((edge) => edge.to === END)) issues.push({ code: "end_unconnected" });
  if (hasCycle(definition)) issues.push({ code: "cycle" });
  const known = new Map(harnesses.map((harness) => [harness.id, harness]));
  const roles = new Map(definition.nodes.map((node) => [node.id, node.role.trim()]));
  for (const node of definition.nodes) {
    const subject = roles.get(node.id)!;
    // A node without a name is reported once; its other gaps show when it can be named in a message.
    if (!subject) { issues.push({ code: "role_missing", nodeId: node.id }); continue; }
    if (!node.instructions.trim()) issues.push({ code: "instructions_missing", nodeId: node.id, subject });
    if (node.harness !== null) {
      const harness = known.get(node.harness);
      if (!harness || !harness.models.some((model) => model.id === node.model)) issues.push({ code: "runtime_unknown", nodeId: node.id, subject });
      else if (!harness.available) issues.push({ code: "runtime_unavailable", nodeId: node.id, subject });
    }
    // A verdict or a list comes back through a tool; a node that follows the conversation is checked when it starts.
    const returns = definition.edges.some((edge) => edge.from === node.id
      && (edge.loop || definition.nodes.some((other) => other.id === edge.to && other.each !== null)));
    if (returns && known.get(node.harness ?? "")?.tools === false) issues.push({ code: "tools_missing", nodeId: node.id, subject });
    const sources = forward.filter((edge) => edge.to === node.id);
    if (!sources.length) issues.push({ code: "node_no_input", nodeId: node.id, subject });
    if (!forward.some((edge) => edge.from === node.id)) issues.push({ code: "node_no_output", nodeId: node.id, subject });
    if (node.each !== null) {
      // The list comes from one node; the task itself is not a list, and a join has no single list.
      if (sources.length !== 1 || sources[0].from === START) issues.push({ code: "each_predecessor", nodeId: node.id, subject });
      if (!Number.isInteger(node.each) || node.each < 2 || node.each > MAX_ITEMS) issues.push({ code: "each_range", nodeId: node.id, subject });
    }
  }
  const bodies: string[][] = [];
  for (const edge of loopEdges(definition)) {
    const subject = `${roles.get(edge.to) ?? ""} ⇄ ${roles.get(edge.from) ?? ""}`;
    const rounds = edge.loop!.maxRounds;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) issues.push({ code: "loop_rounds", edgeId: edge.id, subject });
    const body = loopBody(definition, edge);
    if (!body.length) { issues.push({ code: "loop_target", edgeId: edge.id, subject }); continue; }
    const inside = new Set(body);
    // What repeats must be closed: work leaves it only through the judge and enters only at its first node.
    const leaks = forward.some((link) => (inside.has(link.from) && link.from !== edge.from && !inside.has(link.to))
      || (inside.has(link.to) && link.to !== edge.to && !inside.has(link.from)));
    if (leaks) issues.push({ code: "loop_leak", edgeId: edge.id, subject });
    if (bodies.some((other) => other.some((id) => inside.has(id)))) issues.push({ code: "loop_overlap", edgeId: edge.id, subject });
    bodies.push(body);
  }
  return issues;
}

/** Purpose: Lay the graph out top to bottom, a row per layer, so a drafted or tangled workflow
 * reads in running order. Only positions change. */
export function autoLayout(definition: WorkflowDefinition): WorkflowDefinition {
  const rows = layers(definition);
  const widest = Math.max(1, ...rows.map((row) => row.length));
  const pitch = NODE_WIDTH + 32;
  const drop = NODE_HEIGHT + 40;
  const middle = 48 + (widest * pitch - 32) / 2;
  const top = 48 + TERMINAL_HEIGHT + 40;
  const placed = new Map<string, { x: number; y: number }>();
  rows.forEach((row, index) => row.forEach((node, column) => placed.set(node.id, {
    x: snap(middle - (row.length * pitch - 32) / 2 + column * pitch),
    y: snap(top + index * drop),
  })));
  return { ...definition,
    nodes: definition.nodes.map((node) => ({ ...node, ...placed.get(node.id) })),
    start: { x: snap(middle - TERMINAL_WIDTH / 2), y: 48 },
    end: { x: snap(middle - TERMINAL_WIDTH / 2), y: snap(top + Math.max(1, rows.length) * drop) } };
}

/** A copy that can be saved next to the original: fresh ids everywhere, edges re-pointed. */
export function duplicateWorkflow(definition: WorkflowDefinition, name: string): WorkflowDefinition {
  const ids = new Map<string, string>(definition.nodes.map((node) => [node.id, newId()]));
  const end = (id: string) => ids.get(id) ?? id;
  return { ...definition, id: newId(), name, origin: "user", updatedAt: undefined,
    nodes: definition.nodes.map((node) => ({ ...node, id: end(node.id) })),
    edges: definition.edges.map((edge) => ({ ...edge, id: newId(), from: end(edge.from), to: end(edge.to),
      ...(edge.loop ? { loop: { ...edge.loop } } : {}) })),
    start: { ...definition.start }, end: { ...definition.end } };
}
