import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionAcceptance } from "../electron/evolution-acceptance.mjs";
import { EvolutionRequests } from "../electron/evolution-requests.mjs";
import { EvolutionInteractions } from "../electron/evolution-interactions.mjs";
import { readJson, writeJson } from "../electron/evolution-store.mjs";

test("the draft skill client method is registered at the desktop IPC boundary", async () => {
  const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const registered = /const allowedMethods = new Set\(\[([\s\S]*?)\]\)/.exec(main)?.[1];
  assert.ok(registered?.includes('"get_local_skills"'));
});

test("cancel without a build preserves evidence, never passes the case, and survives retry", async (t) => {
  const f = await setup(t);
  f.state.candidate = null;
  f.state.draftDirty = true;
  await f.acceptance.cancel(f.item.id);
  await f.acceptance.cancel(f.item.id);
  const status = await new EvolutionAcceptance(f.store).status(f.state);
  assert.equal(status.cases[0].enabled, false);
  assert.ok(status.cases[0].cancelledAt);
  assert.equal(status.cases[0].evidence, f.item.evidence);
  assert.equal(status.cases[0].expectation, f.item.expectation);
  assert.equal(status.interactions.completions.length, 0);
  assert.equal(status.report.results[0].after.status, "manual");
  assert.equal(status.fresh, false);
});

test("cancelling one case preserves fresh sibling reviews without reviving stale reports", async (t) => {
  const f = await setup(t);
  const other = await f.acceptance.create({ title: "other", expectation: "keep" });
  await f.acceptance.compare("new");
  await f.acceptance.review(other.id, "observed");
  await f.acceptance.cancel(f.item.id);
  const status = await f.acceptance.status(f.state);
  assert.equal(status.fresh, true);
  assert.equal(status.report.results.find((r) => r.id === other.id).after.status, "passed");
  await f.acceptance.requirePassed("new");
  await assert.rejects(f.acceptance.complete(f.item.id), /取消/);
});

test("continue uses the same case and its original context without model preparation or new cases", async (t) => {
  const f = await setup(t, () => { throw new Error("must not reanalyze"); });
  await f.acceptance.review(f.item.id, "old pass");
  const input = { id: "continue-1", threadId: "thread", caseId: f.item.id, body: "still broken" };
  const first = await f.requests.continueCase(input);
  const replay = await f.requests.continueCase(input);
  assert.equal(first.id, replay.id);
  assert.equal((await f.requests.suite()).length, 1);
  assert.equal(first.cases[0].item.id, f.item.id);
  assert.match(await f.requests.editingPrompt(first.id), /original evidence/);
  assert.match(await f.requests.editingPrompt(first.id), /still broken/);
  assert.equal((await f.acceptance.status(f.state)).report.results[0].after.status, "manual");
  await assert.rejects(f.requests.continueCase({ ...input, body: "different" }), /另一条/);
  await f.acceptance.cancel(f.item.id);
  await assert.rejects(f.requests.continueCase({ ...input, id: "next" }), /结束/);
});

test("compare and confirm the active saved version when no candidate exists", async (t) => {
  const f = await setup(t);
  f.state.candidate = null;
  f.state.builds[0].savedAt = "saved";
  await f.acceptance.compare("new");
  await f.acceptance.complete(f.item.id);
  assert.equal((await f.acceptance.status(f.state)).interactions.completions.length, 1);
  f.state.draftDirty = true;
  await assert.rejects(f.acceptance.compare("new"), /构建/);
});

test("partial cancellation keeps the remaining frozen request executable and protects automatic checks", async (t) => {
  const f = await setup(t);
  const other = await f.acceptance.create({ title: "remaining", expectation: "keep this" });
  const request = await f.requests.repair({ id: "repair", threadId: "thread", prompt: "finish" });
  await f.acceptance.cancel(f.item.id);
  const prompt = await f.requests.editingPrompt(request.id);
  assert.match(prompt, /keep this/);
  assert.doesNotMatch(prompt, /original expectation/);
  await f.acceptance.cancel(other.id);
  await assert.rejects(f.requests.editingPrompt(request.id), /全部取消/);
  const automatic = await f.acceptance.create({ title: "automatic", expectation: "recover", kind: "dream-format",
    fixture: { invalid: "bad", corrected: "good", prompt: "restore" } });
  await assert.rejects(f.acceptance.cancel(automatic.id), /只能取消人工/);
});

async function setup(t, analyze) {
  const root = await mkdtemp(join(tmpdir(), "cleo-interactions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { active: "new", candidate: "new", builds: [{ id: "new", kind: "local", sourceHash: "hash" }] };
  const store = { root, read: async () => state, build: async () => state.builds[0] };
  const acceptance = new EvolutionAcceptance(store);
  const requests = new EvolutionRequests(acceptance, analyze || (async (_thread, prompt) => ({ intent: "change", cases: [{
    title: "updated behavior", requirement: prompt, current: "static", trigger: "open", expectation: "latest expected result", evidence: "source:1",
  }] })));
  const item = await acceptance.create({ title: "original", expectation: "original expectation", evidence: "original evidence" });
  await acceptance.compare("new");
  return { root, state, store, acceptance, requests, item };
}

test("feedback preserves history, freezes latest expectations and never inherits human passes", async (t) => {
  const f = await setup(t);
  await f.acceptance.review(f.item.id, "previous observation");
  const first = await f.requests.feedback({ id: "feedback-1", caseId: f.item.id, body: "change color", threadId: "thread" });
  let status = await f.acceptance.status(f.state);
  assert.equal(status.fresh, false);
  assert.equal(status.cases[0].expectation, f.item.expectation);
  assert.equal(status.cases[0].enabled, false);
  assert.equal(first.replaces, f.item.id);
  const second = await f.requests.feedback({ id: "feedback-2", caseId: first.cases[0].item.id, body: "also change size", threadId: "thread" });
  assert.match(await f.requests.editingPrompt(second.id), /also change size/);
  assert.match(await f.requests.editingPrompt(second.id), /change color/);
  await f.acceptance.compare("new");
  status = await f.acceptance.status(f.state);
  assert.equal(status.cases.filter((c) => c.enabled).length, 1);
  assert.equal(status.report.results[0].after.status, "manual");
  assert.equal(status.interactions.feedback.length, 2);
  await assert.rejects(f.acceptance.requirePassed("new"), /尚未通过/);
});

test("feedback ambiguity pauses editing; skip is durable, separate from user answers, and passed into execution", async (t) => {
  let calls = 0;
  const f = await setup(t, async (_thread, prompt) => {
    if (!calls++) return { intent: "clarification", answer: "放在哪个页面？" };
    assert.match(prompt, /用户选择跳过确认，未提供具体答案/);
    return { intent: "change", answer: "假设：放在当前侧栏。", cases: [{ title: "移动入口", requirement: "move", current: "static", trigger: "open sidebar", expectation: "入口在侧栏", evidence: "file:1" }] };
  });
  await f.acceptance.review(f.item.id, "earlier pass");
  const request = await f.requests.feedback({ id: "feedback", caseId: f.item.id, body: "move", threadId: "thread" });
  assert.equal(request.status, "clarification");
  await assert.rejects(f.requests.editingPrompt(request.id), /先完成/);
  await assert.rejects(f.acceptance.complete(f.item.id, "pass"), /进一步反馈/);
  assert.equal((await f.acceptance.status(f.state)).report.results[0].after.status, "manual");
  const resumed = await f.requests.prepare({ id: request.id, threadId: request.threadId, prompt: request.prompt, skipClarification: true });
  assert.equal(resumed.status, "frozen");
  assert.deepEqual(resumed.clarifications, []);
  assert.match(await f.requests.editingPrompt(request.id), /假设：放在当前侧栏/);
  const reopened = new EvolutionInteractions(f.store);
  assert.equal((await reopened.read()).confirmations[0].skipped, true);
});

test("one user answer permits one bounded model correction without another user clarification", async (t) => {
  let calls = 0;
  const f = await setup(t, async () => {
    if (++calls < 3) return { intent: "clarification", answer: "which page?" };
    return { intent: "change", cases: [{ title: "page", requirement: "move", current: "static", trigger: "open", expectation: "sidebar", evidence: "file:1" }] };
  });
  const input = { id: "request", threadId: "thread", prompt: "move" };
  await f.requests.prepare(input);
  const result = await f.requests.prepare({ ...input, clarification: "sidebar" });
  assert.equal(result.status, "frozen"); assert.equal(calls, 3);
  assert.equal(result.clarifications.length, 1);
});

test("a failed analysis retries an already recorded skip without asking again", async (t) => {
  let calls = 0;
  const f = await setup(t, async () => {
    if (++calls === 1) return { intent: "clarification", answer: "which page?" };
    if (calls === 2) throw new Error("temporary connection failure");
    return { intent: "change", cases: [{ title: "page", requirement: "move", current: "static", trigger: "open", expectation: "sidebar", evidence: "file:1" }] };
  });
  const input = { id: "request", threadId: "thread", prompt: "move" };
  await f.requests.prepare(input);
  await assert.rejects(f.requests.prepare({ ...input, skipClarification: true }), /temporary/);
  assert.equal((await f.requests.prepare({ ...input, skipClarification: true })).status, "frozen");
  assert.equal((await f.acceptance.interactions.read()).confirmations.length, 1);
});

test("feedback cannot retire an automatic regression", async (t) => {
  const f = await setup(t);
  const automatic = await f.acceptance.create({ title: "automatic", expectation: "recover", kind: "dream-format",
    fixture: { invalid: "bad", corrected: "good", prompt: "restore" } });
  await f.requests.feedback({ id: "feedback", caseId: automatic.id, body: "also improve status", threadId: "thread" });
  assert.equal((await f.requests.suite()).find((c) => c.id === automatic.id).enabled, true);
  assert.equal((await f.requests.suite()).find((c) => c.id === automatic.id).expectation, "recover");
});

test("direct confirmation requires the applied build, ends only that item and survives reopen without notes", async (t) => {
  const f = await setup(t);
  const other = await f.acceptance.create({ title: "other", expectation: "keep pending" });
  await f.acceptance.compare("new");
  f.state.active = "old";
  await assert.rejects(f.acceptance.complete(f.item.id, "observed"), /应用/);
  f.state.active = "new";
  await assert.rejects(f.acceptance.requirePassed("new"), /尚未通过/);
  await f.acceptance.complete(f.item.id);
  let status = await f.acceptance.status(f.state);
  assert.equal(status.fresh, true);
  assert.deepEqual(status.cases.filter((c) => c.enabled).map((c) => c.id), [other.id]);
  assert.equal(status.report.results.find((r) => r.id === other.id).after.status, "manual");
  const confirmed = status.report.results.find((r) => r.id === f.item.id).after;
  assert.equal(confirmed.status, "passed");
  assert.equal(confirmed.detail, "");
  assert.equal(confirmed.manual, true);
  assert.ok(confirmed.reviewedAt);
  await f.acceptance.compare("new");
  status = await new EvolutionAcceptance(f.store).status(f.state);
  assert.equal(status.interactions.completions[0].note, "");
  assert.equal(status.interactions.completions[0].candidate, "new");
  assert.equal(status.report.results.some((r) => r.id === f.item.id), false);
  await assert.rejects(f.acceptance.requirePassed("new"), /尚未通过/);
  await f.acceptance.complete(other.id, "");
  await f.acceptance.requirePassed("new");
  await f.acceptance.complete(other.id);
  assert.equal((await f.acceptance.interactions.read()).completions.length, 2);
});

test("direct completion preserves a previous written observation and unknown result fields", async (t) => {
  const f = await setup(t);
  await f.acceptance.review(f.item.id, "Previously written observation");
  const report = await readJson(f.acceptance.reportPath);
  report.results[0].after.future = { keep: ["nonempty"] };
  await writeJson(f.acceptance.reportPath, report);
  await f.acceptance.complete(f.item.id);
  const status = await f.acceptance.status(f.state);
  assert.equal(status.interactions.completions[0].note, "Previously written observation");
  assert.deepEqual(status.report.results[0].after.future, { keep: ["nonempty"] });
});

test("sidecar preserves unknown fields and refuses unreadable or newer data", async (t) => {
  const f = await setup(t);
  const journal = f.acceptance.interactions;
  await journal.append("feedback", { id: "one", caseId: f.item.id, body: "nonempty", unknown: { keep: [1] } });
  const data = await journal.read(); data.future = ["preserve"];
  await writeJson(journal.path, data);
  await journal.append("confirmations", { id: "request", skipped: true });
  assert.deepEqual((await journal.read()).feedback[0].unknown, { keep: [1] });
  assert.deepEqual((await journal.read()).future, ["preserve"]);
  for (const content of ['{"schema":2,"feedback":[]}', '{"schema":1,"feedback":[]}','{invalid']) {
    await writeFile(journal.path, content);
    await assert.rejects(journal.append("feedback", { id: "other", caseId: "id", body: "text" }));
    assert.equal(await readFile(journal.path, "utf8"), content);
  }
});

test("feedback and request writes preserve optional/missing/unknown legacy fields", async (t) => {
  const f = await setup(t);
  const suite = await readJson(f.acceptance.path);
  suite[0].future = { ids: ["stable"] }; delete suite[0].sourceThread;
  await writeJson(f.acceptance.path, suite);
  await f.requests.feedback({ id: "feedback", caseId: f.item.id, body: "new requirement", threadId: "thread" });
  const requests = await f.requests.read(); requests.future = ["nonempty"]; requests.requests[0].unknown = { keep: true };
  await writeJson(f.requests.path, requests);
  await f.requests.finish("feedback", "completed");
  const result = await readJson(f.requests.path);
  assert.deepEqual(result.future, ["nonempty"]);
  assert.deepEqual(result.requests[0].unknown, { keep: true });
  assert.deepEqual((await readJson(f.acceptance.path))[0], { ...suite[0], enabled: false });
});
