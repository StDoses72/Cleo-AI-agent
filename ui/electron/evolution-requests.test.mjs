import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionStore, readJson, writeJson } from "./evolution-store.mjs";
import { EvolutionAcceptance } from "./evolution-acceptance.mjs";
import { EvolutionRequests } from "./evolution-requests.mjs";
import { runPreparedEvolutionTurn } from "./evolution-editing.mjs";

const input = { id: "request-1", threadId: "thread-1", prompt: "给侧栏按钮显示文字" };
const plan = { intent: "change", cases: [{ title: "侧栏文字", requirement: input.prompt,
  current: "图标按钮", trigger: "打开侧栏", expectation: "按钮旁显示文字标签", evidence: "ui/src/Button.tsx:1: <button />" }] };

async function setup(t, analyze = async () => structuredClone(plan)) {
  const root = await mkdtemp(join(tmpdir(), "cleo-preparation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { active: "old", candidate: "new", builds: [
    { id: "old", kind: "local", sourceHash: "old-source", savedAt: "saved" },
    { id: "new", kind: "local", sourceHash: "new-source" },
  ] };
  const store = new EvolutionStore(root, join(root, "user-data"));
  store.read = async () => state;
  store.build = async (id) => state.builds.find((b) => b.id === id);
  const replayed = [];
  const acceptance = new EvolutionAcceptance(store, async (build) => {
    replayed.push(build.id); return { status: "passed", detail: "isolated fixture replay" };
  });
  const requests = new EvolutionRequests(acceptance, analyze);
  const calls = [];
  const evolution = { operation: (_phase, action) => store.exclusive(action),
    begin: async () => { calls.push("begin"); assert.equal((await requests.read()).requests[0].status, "frozen");
      assert.ok((await requests.suite()).length); },
    build: async () => { calls.push("build"); return "new"; } };
  const backend = { request: async (_method, _params, emit) => { calls.push("edit"); emit({ type: "done" }); } };
  const run = (params) => runPreparedEvolutionTurn({ evolution, requests, acceptance, backend, params, onEvent: () => {} });
  const prepare = (params = input) => evolution.operation("checking", () => requests.prepare(params));
  return { root, state, store, acceptance, requests, replayed, calls, evolution, backend, run, prepare };
}

test("original request and code evidence are durable before editing; generic cases stay manual after a successful build", async (t) => {
  const f = await setup(t, async () => {
    const saved = await readJson(f.requests.path);
    assert.equal(saved.requests[0].prompt, input.prompt);
    assert.equal(saved.requests[0].status, "analyzing");
    assert.deepEqual(f.calls, []);
    return structuredClone(plan);
  });
  const request = await f.prepare();
  assert.equal(request.status, "frozen");
  const item = (await f.requests.suite())[0];
  assert.equal(item.kind, "manual"); assert.equal(item.fixture, undefined);
  assert.match(item.evidence, /尚未验证/);
  await f.run({ thread_id: input.threadId, prompt: await f.requests.editingPrompt(input.id) });
  assert.deepEqual(f.calls, ["begin", "edit", "build"]);
  assert.equal((await f.acceptance.status(f.state)).report.results[0].after.status, "manual");
  await assert.rejects(f.acceptance.requirePassed("new"), /尚未通过/);
});

test("same request is idempotent across serialized concurrent retries and restart", async (t) => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; return structuredClone(plan); });
  const [a, b] = await Promise.all([f.prepare(), f.prepare()]);
  assert.deepEqual(a.cases, b.cases); assert.equal(calls, 1);
  const recovered = new EvolutionRequests(f.acceptance, () => { throw new Error("must not reanalyze"); });
  assert.deepEqual((await recovered.prepare(input)).cases, a.cases);
  assert.equal((await recovered.suite()).length, 1);
  await assert.rejects(recovered.prepare({ ...input, prompt: "different" }), /另一条/);
  const prompt = await recovered.editingPrompt(input.id);
  await f.run({ thread_id: input.threadId, prompt });
  await assert.rejects(f.run({ thread_id: input.threadId, prompt }), /已提交/);
  assert.equal(f.calls.filter((x) => x === "build").length, 1);
});

test("generation failure preserves raw input and retries without editing or building", async (t) => {
  let fail = true;
  const f = await setup(t, async () => { if (fail) throw new Error("connection unavailable"); return structuredClone(plan); });
  await assert.rejects(f.prepare(), /connection unavailable/);
  const saved = (await f.requests.read()).requests[0];
  assert.equal(saved.status, "failed"); assert.equal(saved.prompt, input.prompt);
  assert.match(saved.error, /connection unavailable/); assert.deepEqual(f.calls, []);
  await assert.rejects(f.run({ thread_id: input.threadId, prompt: input.prompt }), /冻结/);
  assert.deepEqual(f.calls, []);
  fail = false; await f.prepare(); assert.equal((await f.requests.suite()).length, 1);
});

test("a pure question is answered read-only with no cases, iteration, edit, or build", async (t) => {
  const f = await setup(t, async () => ({ intent: "question", answer: "该按钮打开侧栏。" }));
  const question = { ...input, prompt: "解释这个按钮，不要修改代码" };
  const request = await f.prepare(question);
  assert.equal(request.status, "answered"); assert.equal(request.cases.length, 0);
  assert.deepEqual(await f.requests.suite(), []);
  await assert.rejects(f.requests.editingPrompt(request.id), /先完成/);
  assert.deepEqual(f.calls, []);
});

test("ambiguity waits for a recorded clarification; clear requests do not request confirmation", async (t) => {
  let calls = 0;
  const f = await setup(t, async (_thread, prompt) => {
    if (!calls++) return { intent: "clarification", answer: "所有按钮还是仅侧栏？" };
    assert.match(prompt, /仅侧栏/); return structuredClone(plan);
  });
  assert.equal((await f.prepare()).status, "clarification");
  await f.prepare(); assert.equal(calls, 1); assert.deepEqual(f.calls, []);
  const request = await f.prepare({ ...input, clarification: "仅侧栏" });
  assert.equal(request.status, "frozen"); assert.equal(request.clarifications[0].answer, "仅侧栏");
});

test("interrupted freeze replays journaled IDs without duplicate cases or a new model call", async (t) => {
  const f = await setup(t);
  const original = f.requests.save.bind(f.requests);
  let crash = true;
  f.requests.save = async (data) => {
    if (crash && data.requests[0].status === "frozen") { crash = false; throw new Error("simulated power loss"); }
    await original(data);
  };
  await assert.rejects(f.prepare(), /simulated/);
  assert.equal((await f.requests.read()).requests[0].status, "freezing");
  const ids = (await f.requests.suite()).map((c) => c.id);
  const recovered = new EvolutionRequests(f.acceptance, () => { throw new Error("unexpected analysis"); });
  assert.equal((await recovered.status())[0].interrupted, true);
  assert.equal((await recovered.prepare(input)).status, "frozen");
  assert.deepEqual((await recovered.suite()).map((c) => c.id), ids);
});

test("explicit revisions retain old expected results and reason and invalidate version-bound acceptance", async (t) => {
  const f = await setup(t);
  const original = await f.prepare();
  const old = original.cases[0].item;
  await f.acceptance.compare("new"); await f.acceptance.review(old.id, "actually inspected");
  await f.acceptance.requirePassed("new");
  const params = { id: "revision-1", caseId: old.id, expectation: "显示中文文字", trigger: "打开中文侧栏", reason: "用户要求中文" };
  const revised = await f.requests.revise(params);
  await f.requests.revise(params);
  const suite = await f.requests.suite();
  assert.equal(suite.length, 2); assert.equal(suite[0].enabled, false);
  assert.equal(suite[0].expectation, old.expectation); assert.equal(suite[1].expectation, params.expectation);
  assert.equal(revised.reason, params.reason); assert.equal(revised.replaces, old.id);
  await assert.rejects(f.acceptance.requirePassed("new"), /尚未通过/);
  await assert.rejects(f.requests.editingPrompt(input.id), /已修正/);
  assert.match(await f.requests.editingPrompt(params.id), /显示中文文字/);
});

test("legacy Dream regressions still replay beside new manual cases; repair keeps all expectations", async (t) => {
  const f = await setup(t);
  const dream = await f.acceptance.create({ title: "Dream recovery", expectation: "recovers",
    kind: "dream-format", fixture: { prompt: "fixed input", invalid: "bad", corrected: "{}" } });
  await f.prepare();
  await f.run({ thread_id: input.threadId, prompt: await f.requests.editingPrompt(input.id) });
  assert.deepEqual(f.replayed, ["old", "new"]);
  const report = (await f.acceptance.status(f.state)).report;
  assert.equal(report.results.find((c) => c.id === dream.id).after.status, "passed");
  assert.equal(report.results[1].after.status, "manual");
  const repair = await f.requests.repair({ ...input, id: "repair-1", prompt: "fix compiler diagnostic" });
  assert.equal(repair.cases[0].item.id, dream.id);
  assert.equal(repair.cases[1].item.expectation, plan.cases[0].expectation);
});

test("missing done, errors, and rejected transport never trigger a build", async (t) => {
  for (const mode of ["no-done", "error", "reject-after-done"]) {
    const f = await setup(t); await f.prepare();
    f.backend.request = async (_method, _params, emit) => {
      if (mode !== "no-done") emit({ type: "done" });
      if (mode === "error") emit({ type: "error" });
      if (mode === "reject-after-done") throw new Error("transport lost");
    };
    const run = f.run({ thread_id: input.threadId, prompt: await f.requests.editingPrompt(input.id) });
    if (mode === "reject-after-done") await assert.rejects(run, /transport lost/); else await run;
    assert.ok(!f.calls.includes("build"));
    assert.equal((await f.requests.read()).requests[0].execution.status, "interrupted");
  }
});

test("explicit continuation after restart reuses frozen cases and keeps the original request history", async (t) => {
  const f = await setup(t); await f.prepare();
  const prompt = await f.requests.editingPrompt(input.id);
  await f.requests.claim(input.threadId, prompt);
  const recovered = new EvolutionRequests(f.acceptance, () => { throw new Error("must not regenerate"); });
  const original = (await recovered.read()).requests[0];
  assert.equal(original.execution.status, "submitted");
  const resumed = await recovered.repair({ id: "continued-1", parent: input.id, threadId: input.threadId, prompt: input.prompt });
  assert.equal(resumed.parent, input.id);
  assert.deepEqual(resumed.cases.map((c) => c.item), original.cases.map((c) => c.item));
  await f.run({ thread_id: input.threadId, prompt: await recovered.editingPrompt(resumed.id) });
  assert.equal((await recovered.suite()).length, 1);
  assert.equal((await recovered.read()).requests[0].execution.status, "submitted");
  assert.equal((await recovered.read()).requests[1].execution.status, "completed");
});

test("unreadable/newer journals and suites are never replaced with defaults", async (t) => {
  const f = await setup(t);
  for (const content of ['{"schema":2,"requests":[],"future":{"keep":true}}', '{broken']) {
    await writeFile(f.requests.path, content).catch(async () => { await writeJson(f.requests.path, {}); await writeFile(f.requests.path, content); });
    await assert.rejects(f.prepare());
    assert.equal(await readFile(f.requests.path, "utf8"), content);
  }
  await writeJson(f.requests.path, { schema: 1, requests: [], unknown: { preserve: true } });
  const newerSuite = { schema: 99, entries: ["keep"] };
  await writeJson(f.acceptance.path, newerSuite);
  await assert.rejects(f.prepare(), /未覆盖/);
  assert.deepEqual(await readJson(f.acceptance.path), newerSuite);
  assert.deepEqual((await f.requests.read()).unknown, { preserve: true });
});
