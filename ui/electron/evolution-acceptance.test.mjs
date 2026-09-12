import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionAcceptance } from "./evolution-acceptance.mjs";
import { writeJson } from "./evolution-store.mjs";

async function setup(t, replay) {
  const root = await mkdtemp(join(tmpdir(), "cleo-case-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { active: "old", candidate: "new", builds: [
    { id: "old", kind: "local", sourceHash: "old-hash", savedAt: "saved" },
    { id: "new", kind: "local", sourceHash: "new-hash" },
  ] };
  const store = { root, read: async () => state, build: async (id) => {
    const build = state.builds.find((item) => item.id === id);
    if (!build) throw new Error("missing build");
    return build;
  } };
  return { acceptance: new EvolutionAcceptance(store, replay), state, root };
}
const manual = { title: "Remember scope", expectation: "Only use this project's preferences", evidence: "user: this project only" };
const automatic = { ...manual, kind: "dream-format", fixture: { prompt: "evidence", invalid: "{} }", corrected: "{}" } };

test("manual acceptance persists, requires observation, and is tied to one source hash", async (t) => {
  const { acceptance, state } = await setup(t);
  const item = await acceptance.create(manual);
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  await acceptance.compare("new");
  await assert.rejects(acceptance.review(item.id, "  "), /依据/);
  await acceptance.review(item.id, "Preview uses only the correct project's preference.");
  await acceptance.requirePassed("new");
  state.builds[1].sourceHash = "changed";
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  await assert.rejects(acceptance.review(item.id, "old result"), /版本已变化/);
});

test("automatic comparison replays identical fixture and reuses frozen baseline", async (t) => {
  const calls = [];
  const { acceptance } = await setup(t, async (build, fixture) => {
    calls.push({ id: build.id, fixture });
    return { status: build.id === "old" ? "failed" : "passed", detail: build.id };
  });
  await acceptance.create(automatic);
  await acceptance.compare("new");
  await acceptance.requirePassed("new");
  await acceptance.compare("new");
  assert.deepEqual(calls.map((call) => call.id), ["old", "new", "new"]);
  assert.ok(calls.every((call) => JSON.stringify(call.fixture) === JSON.stringify(automatic.fixture)));
});

test("regression and infrastructure failure both block application", async (t) => {
  for (const failure of [false, true]) {
    const { acceptance } = await setup(t, async (build) => {
      if (failure) throw new Error("missing interpreter");
      return { status: build.id === "old" ? "passed" : "failed", detail: "regression" };
    });
    await acceptance.create(automatic);
    await acceptance.compare("new");
    await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  }
});

test("new cases invalidate results and archiving preserves evidence", async (t) => {
  const { acceptance, state } = await setup(t);
  const first = await acceptance.create(manual);
  await acceptance.compare("new");
  await acceptance.review(first.id, "checked");
  const second = await acceptance.create({ ...manual, title: "another expectation" });
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  await acceptance.archive(second.id);
  assert.equal((await acceptance.status(state)).cases[1].evidence, manual.evidence);
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
});

test("draft changes block old results but saved-version rollback remains available", async (t) => {
  const { acceptance, state } = await setup(t);
  const item = await acceptance.create(manual);
  await acceptance.compare("new");
  await acceptance.review(item.id, "checked");
  state.draftDirty = true;
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  await acceptance.requirePassed("old");
});

test("corrupt state and missing results never count as acceptance", async (t) => {
  const { acceptance, root } = await setup(t);
  const item = await acceptance.create(manual);
  const report = await acceptance.compare("new");
  report.results = [];
  await writeJson(join(root, "acceptance/report.json"), report);
  await assert.rejects(acceptance.review(item.id, "checked"), /缺少/);
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
});

test("unsupported cases and oversized evidence are rejected before persistence", async (t) => {
  const { acceptance, state } = await setup(t);
  await assert.rejects(acceptance.create({ ...manual, kind: "shell" }), /不支持/);
  await assert.rejects(acceptance.create({ ...manual, evidence: "x".repeat(100001) }), /证据/);
  await assert.rejects(acceptance.create({ ...manual, kind: "dream-format" }), /回放需要/);
  assert.deepEqual((await acceptance.status(state)).cases, []);
});
