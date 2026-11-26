import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { createServer } from "vite";

const server = await createServer({ root: resolve(import.meta.dirname, ".."), configFile: false,
  server: { middlewareMode: true, hmr: false } });
after(() => server.close());
const model = await server.ssrLoadModule("/src/components/workflows/workflow-model.ts");
const {
  END, NODE_HEIGHT, NODE_WIDTH, START, TERMINAL_HEIGHT,
  addNode, agentBound, autoLayout, connect, duplicateWorkflow, layers, loopBody, newNode, newWorkflow, removeNode, workflowIssues,
} = model;

const executors = [
  { id: "codex/a@high", harness: "Codex", model: "a", effort: "high", available: true },
  { id: "claude/b", harness: "Claude", model: "b", effort: null, available: false, reason: "signed out" },
];
const agent = (role, extra = {}) => newNode(0, 0, { role, instructions: `${role} instructions`, ...extra });
const codes = (definition) => workflowIssues(definition, executors).map((issue) => issue.code);
/** A workflow from nodes and "from>to" pairs written with roles; "start" and "end" are the two ends. */
function graph(nodes, links, name = "w") {
  let definition = nodes.reduce(addNode, newWorkflow(name));
  const id = (role) => role === START || role === END ? role : nodes.find((node) => node.role === role).id;
  for (const link of links) {
    const [from, to] = link.split(">");
    const linked = connect(definition, id(from), id(to));
    assert.ok("definition" in linked, `${link} was refused: ${linked.refused}`);
    definition = linked.definition;
  }
  return definition;
}
const planRefute = () => graph([agent("planner"), agent("refuter"), agent("executor", { access: "write" })],
  ["start>planner", "planner>refuter", "refuter>executor", "executor>end", "refuter>planner"]);

test("an edge back to an earlier node becomes that node's loop", () => {
  const definition = planRefute();
  const back = definition.edges.find((edge) => edge.loop);
  const role = (id) => definition.nodes.find((node) => node.id === id).role;
  assert.deepEqual([role(back.from), role(back.to), back.loop], ["refuter", "planner", { maxRounds: 3, onExhausted: "stop" }]);
  assert.deepEqual(loopBody(definition, back).map(role), ["planner", "refuter"]);
  assert.equal(definition.edges.filter((edge) => !edge.loop).length, 4);
  assert.deepEqual(codes(definition), []);
  assert.equal(agentBound(definition), 2 * 3 + 1, "the two nodes of the loop count once per round");
});

test("edges that cannot exist are refused with a reason", () => {
  const definition = planRefute();
  const [planner, refuter, executor] = definition.nodes.map((node) => node.id);
  const refusal = (from, to) => connect(definition, from, to).refused;
  assert.equal(refusal(planner, planner), "same");
  assert.equal(refusal(planner, refuter), "exists");
  assert.equal(refusal(END, planner), "direction");
  assert.equal(refusal(planner, START), "direction");
  assert.equal(refusal(START, END), "direction");
  // The refuter already judges one loop; the executor may still start its own.
  assert.equal(refusal(refuter, planner), "exists");
  const second = graph([agent("a"), agent("b"), agent("c")], ["start>a", "a>b", "b>c", "c>end", "c>a"]);
  const ids = second.nodes.map((node) => node.id);
  assert.equal(connect(second, ids[2], ids[1]).refused, "second_loop");
  assert.ok(connect(definition, executor, refuter).edge.loop);
});

test("an empty or unconnected workflow says what is missing", () => {
  assert.deepEqual(codes(newWorkflow()), ["name_missing", "no_nodes"]);
  assert.deepEqual(codes(graph([agent("alone")], [])), ["start_unconnected", "end_unconnected", "node_no_input", "node_no_output"]);
  assert.deepEqual(codes(graph([agent("a"), agent("b")], ["start>a", "a>end"])), ["node_no_input", "node_no_output"]);
});

test("a nameless node is reported once; a named one for each gap it has", () => {
  const blank = graph([newNode(0, 0)], []);
  assert.deepEqual(workflowIssues(blank, executors).filter((issue) => issue.nodeId).map((issue) => issue.code), ["role_missing"]);
  const definition = graph([newNode(0, 0, { role: "quiet" }), agent("gone", { executorId: "codex/removed" }), agent("offline", { executorId: "claude/b" })],
    ["start>quiet", "quiet>gone", "gone>offline", "offline>end"]);
  assert.deepEqual(codes(definition), ["instructions_missing", "executor_unknown", "executor_unavailable"]);
});

test("nodes started by the same node run side by side and are joined by the node they all lead to", () => {
  const definition = graph([agent("left"), agent("right"), agent("join")],
    ["start>left", "start>right", "left>join", "right>join", "join>end"]);
  assert.deepEqual(codes(definition), []);
  assert.deepEqual(layers(definition).map((row) => row.map((node) => node.role).sort()), [["left", "right"], ["join"]]);
  assert.equal(agentBound(definition), 3);
});

test("a loop must be closed, bounded and apart from other loops", () => {
  const of = (definition) => codes(definition).filter((code) => code.startsWith("loop"));
  const rounds = (definition, maxRounds) => ({ ...definition, edges: definition.edges.map((edge) => edge.loop ? { ...edge, loop: { ...edge.loop, maxRounds } } : edge) });
  assert.deepEqual(of(rounds(planRefute(), 0)), ["loop_rounds"]);
  assert.deepEqual(of(rounds(planRefute(), 6)), ["loop_rounds"]);
  assert.deepEqual(of(rounds(planRefute(), 1.5)), ["loop_rounds"]);
  // Work leaves the loop from the planner, before the refuter has judged it.
  assert.deepEqual(of(graph([agent("planner"), agent("refuter"), agent("executor")],
    ["start>planner", "planner>refuter", "refuter>executor", "planner>executor", "executor>end", "refuter>planner"])), ["loop_leak"]);
  // Work enters the loop at the refuter, past the planner.
  assert.deepEqual(of(graph([agent("scout"), agent("planner"), agent("refuter")],
    ["start>scout", "scout>planner", "planner>refuter", "scout>refuter", "refuter>end", "refuter>planner"])), ["loop_leak"]);
  assert.deepEqual(of(graph([agent("a"), agent("b"), agent("c")],
    ["start>a", "a>b", "b>c", "c>end", "b>a", "c>b"])), ["loop_overlap"]);
  // The edge that put the planner before the refuter is gone, so the way back leads nowhere earlier.
  const cut = planRefute();
  const [planner, refuter] = cut.nodes.map((node) => node.id);
  const broken = { ...cut, edges: cut.edges.filter((edge) => !(edge.from === planner && edge.to === refuter)) };
  assert.deepEqual(of(broken), ["loop_target"]);
});

test("a node that runs per item needs one node before it that returns the list", () => {
  const each = (links, extra = {}) => codes(graph([agent("lister"), agent("other"), agent("fixer", { each: 4, ...extra })], links));
  assert.deepEqual(each(["start>lister", "lister>fixer", "fixer>end", "start>other", "other>end"]), []);
  assert.deepEqual(each(["start>fixer", "fixer>end", "start>lister", "lister>end", "start>other", "other>end"]), ["each_predecessor"]);
  assert.deepEqual(each(["start>lister", "start>other", "lister>fixer", "other>fixer", "fixer>end"]), ["each_predecessor"]);
  assert.deepEqual(each(["start>lister", "lister>fixer", "fixer>end", "start>other", "other>end"], { each: 9 }), ["each_range"]);
  const definition = graph([agent("lister"), agent("fixer", { each: 4 })], ["start>lister", "lister>fixer", "fixer>end"]);
  assert.equal(agentBound(definition), 1 + 4);
});

test("removing a node removes its edges; a new node never lands on the result", () => {
  const definition = planRefute();
  const refuter = definition.nodes[1].id;
  const without = removeNode(definition, refuter);
  assert.equal(without.nodes.length, 2);
  assert.ok(without.edges.every((edge) => edge.from !== refuter && edge.to !== refuter));
  assert.equal(without.edges.some((edge) => edge.loop), false);
  const empty = newWorkflow("w");
  const placed = addNode(empty, newNode(empty.end.x - 60, empty.end.y - 20));
  assert.ok(placed.end.y >= placed.nodes[0].y + NODE_HEIGHT + 40, "the result moves below the node");
  assert.equal(placed.nodes[0].x % 8, 0, "positions snap to the grid");
});

test("tidying lays the rows out top to bottom without overlap", () => {
  const tidy = autoLayout(graph([agent("a"), agent("left"), agent("right"), agent("z")],
    ["start>a", "a>left", "a>right", "left>z", "right>z", "z>end"]));
  const at = (role) => tidy.nodes.find((node) => node.role === role);
  assert.ok(tidy.start.y + TERMINAL_HEIGHT < at("a").y);
  assert.ok(at("a").y + NODE_HEIGHT < at("left").y);
  assert.equal(at("left").y, at("right").y);
  assert.ok(Math.abs(at("left").x - at("right").x) >= NODE_WIDTH);
  assert.ok(at("z").y + NODE_HEIGHT < tidy.end.y);
  assert.deepEqual(tidy.edges, tidy.edges.map((edge) => ({ ...edge })), "only positions change");
});

test("a duplicate shares no id with its original and keeps its shape", () => {
  const original = { ...planRefute(), origin: "drafted", updatedAt: "2026-11-26T00:00:00.000Z" };
  const copy = duplicateWorkflow(original, "Copy");
  const ids = (definition) => [definition.id, ...definition.nodes.map((node) => node.id), ...definition.edges.map((edge) => edge.id)];
  assert.equal(ids(copy).filter((id) => ids(original).includes(id)).length, 0);
  const known = new Set([START, END, ...copy.nodes.map((node) => node.id)]);
  assert.ok(copy.edges.every((edge) => known.has(edge.from) && known.has(edge.to)));
  assert.deepEqual([copy.name, copy.origin, copy.updatedAt], ["Copy", "user", undefined]);
  assert.deepEqual(codes(copy), []);
  assert.equal(agentBound(copy), agentBound(original));
});
