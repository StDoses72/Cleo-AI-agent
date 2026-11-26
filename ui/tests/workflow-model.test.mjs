import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { createServer } from "vite";

const server = await createServer({ root: resolve(import.meta.dirname, ".."), configFile: false,
  server: { middlewareMode: true, hmr: false } });
after(() => server.close());
const model = await server.ssrLoadModule("/src/components/workflows/workflow-model.ts");
const { agentBound, duplicateWorkflow, moveStep, newAgent, newLoop, newParallel, newWorkflow, workflowIssues } = model;

const executors = [
  { id: "codex/a@high", harness: "Codex", model: "a", effort: "high", available: true },
  { id: "claude/b", harness: "Claude", model: "b", effort: null, available: false, reason: "signed out" },
];
const agent = (role, extra = {}) => ({ ...newAgent(role), instructions: `${role} instructions`, ...extra });
const codes = (definition) => workflowIssues(definition, executors).map((issue) => issue.code);

function planRefute() {
  const planner = agent("planner");
  const refuter = agent("refuter", { executorId: "codex/a@high" });
  return { ...newWorkflow("Plan and refute"), steps: [
    { ...newLoop("debate", [planner, refuter]), maxRounds: 3 },
    agent("executor", { access: "write" }),
  ] };
}

test("a complete workflow has no issues and counts every round of its loop", () => {
  const definition = planRefute();
  assert.deepEqual(codes(definition), []);
  assert.equal(definition.steps[0].judgeId, definition.steps[0].body[1].id, "the last node of a new loop judges it");
  assert.equal(agentBound(definition), 2 * 3 + 1);
});

test("an empty workflow needs a name and a step", () => {
  assert.deepEqual(codes(newWorkflow()), ["name_missing", "no_steps"]);
});

test("a nameless node is reported once, with the step it is in", () => {
  const definition = { ...newWorkflow("w"), steps: [agent("first"), newParallel("fan", [newAgent(), agent("second")])] };
  const issues = workflowIssues(definition, executors);
  assert.deepEqual(issues.map((issue) => issue.code), ["role_missing"]);
  assert.equal(issues[0].position, 2);
  assert.equal(issues[0].nodeId, definition.steps[1].branches[0].id);
});

test("a named node without instructions, or bound to a missing or unavailable model, cannot run", () => {
  const definition = { ...newWorkflow("w"), steps: [
    { ...newAgent("quiet") },
    agent("gone", { executorId: "codex/removed" }),
    agent("offline", { executorId: "claude/b" }),
  ] };
  assert.deepEqual(codes(definition), ["instructions_missing", "executor_unknown", "executor_unavailable"]);
});

test("a parallel group needs two branches, or a list from the single agent before it", () => {
  const one = { ...newWorkflow("w"), steps: [newParallel("fan", [agent("only")])] };
  assert.deepEqual(codes(one), ["branches_too_few"]);
  const each = (steps) => ({ ...newWorkflow("w"), steps });
  const fan = { ...newParallel("each", [agent("fixer")]), fanOut: "each", maxItems: 4 };
  assert.deepEqual(codes(each([fan])), ["each_needs_previous"]);
  assert.deepEqual(codes(each([newLoop("loop", [agent("a"), agent("b")]), fan])), ["each_needs_previous"]);
  assert.deepEqual(codes(each([agent("lister"), fan])), []);
  assert.equal(agentBound(each([agent("lister"), fan])), 1 + 4);
  assert.deepEqual(codes(each([agent("lister"), { ...fan, maxItems: 9 }])), ["items_out_of_range"]);
  assert.deepEqual(codes(each([agent("lister"), { ...fan, branches: [] }])), ["each_needs_template"]);
  // Only the template runs, so a second branch left over from "branches" mode is not checked.
  assert.deepEqual(codes(each([agent("lister"), { ...fan, branches: [agent("fixer"), newAgent()] }])), []);
});

test("a loop needs nodes, a judge among them and a bounded number of rounds", () => {
  const loop = newLoop("loop", [agent("a"), agent("b")]);
  const of = (step) => codes({ ...newWorkflow("w"), steps: [step] });
  assert.deepEqual(of({ ...loop, body: [] }), ["loop_empty"]);
  assert.deepEqual(of({ ...loop, judgeId: "elsewhere" }), ["judge_missing"]);
  assert.deepEqual(of({ ...loop, maxRounds: 0 }), ["rounds_out_of_range"]);
  assert.deepEqual(of({ ...loop, maxRounds: 6 }), ["rounds_out_of_range"]);
  assert.deepEqual(of({ ...loop, maxRounds: 1.5 }), ["rounds_out_of_range"]);
});

test("moving a step past either end leaves the order alone", () => {
  assert.deepEqual(moveStep(["a", "b", "c"], 0, 1), ["b", "a", "c"]);
  assert.deepEqual(moveStep(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveStep(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
  assert.deepEqual(moveStep(["a", "b", "c"], 2, 1), ["a", "b", "c"]);
});

test("a duplicate shares no id with its original and keeps its judge", () => {
  const original = { ...planRefute(), origin: "drafted", updatedAt: "2026-11-26T00:00:00.000Z" };
  const copy = duplicateWorkflow(original, "Copy");
  const ids = (definition) => [definition.id, ...definition.steps.flatMap((step) =>
    [step.id, ...(step.kind === "loop" ? step.body : step.kind === "parallel" ? step.branches : []).map((node) => node.id)])];
  assert.equal(ids(copy).filter((id) => ids(original).includes(id)).length, 0);
  assert.equal(copy.steps[0].judgeId, copy.steps[0].body[1].id);
  assert.equal(copy.name, "Copy");
  assert.equal(copy.origin, "user");
  assert.equal(copy.updatedAt, undefined);
  assert.deepEqual(codes(copy), []);
});
