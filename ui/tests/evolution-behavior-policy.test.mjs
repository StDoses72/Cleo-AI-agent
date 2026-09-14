import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionAcceptance } from "../electron/evolution-acceptance.mjs";
import { requireApplicable, reviewApplied } from "../electron/evolution-behavior-policy.mjs";

/** Purpose: Exercise existing receipts in isolated storage without touching live data. */
async function fixture(t, replay) {
  const root = await mkdtemp(join(tmpdir(), "cleo-post-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { active: "base", candidate: "new", builds: [
    { id: "base", kind: "local", savedAt: "saved", sourceHash: "base-hash" },
    { id: "new", kind: "local", sourceHash: "new-hash" },
  ] };
  const store = { root, read: async () => state, build: async (id) => state.builds.find((b) => b.id === id) };
  return { state, acceptance: new EvolutionAcceptance(store, replay) };
}

test("pending manual cases allow application, but only explicit applied confirmation permits saving", async (t) => {
  const { state, acceptance } = await fixture(t);
  const item = await acceptance.create({ title: "specific bug", evidence: "trigger and old problem", expectation: "new result" });
  await requireApplicable(acceptance, "new");
  await acceptance.compare("new");
  await requireApplicable(acceptance, "new");
  await assert.rejects(reviewApplied(acceptance, item.id, "read the expectation"), /先应用/);
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  state.active = "new";
  await assert.rejects(acceptance.requirePassed("new"), /尚未通过/);
  await reviewApplied(acceptance, item.id);
  assert.equal((await acceptance.status(state)).report.results[0].after.detail, "");
  await reviewApplied(acceptance, item.id, "Observed the expected result after application");
  await acceptance.requirePassed("new");
  state.builds.push({ id: "next", kind: "local", sourceHash: "next-hash" });
  state.candidate = "next";
  await requireApplicable(acceptance, "next");
  state.active = "next";
  await assert.rejects(acceptance.requirePassed("next"), /尚未通过/);
  await assert.rejects(reviewApplied(acceptance, item.id, "reuse old observation"), /先应用/);
  await acceptance.compare("next");
  await reviewApplied(acceptance, item.id, "Observed the new build separately");
  await acceptance.requirePassed("next");
  state.draftDirty = true;
  await assert.rejects(reviewApplied(acceptance, item.id, "stale draft"), /先应用/);
  await assert.rejects(acceptance.requirePassed("next"), /尚未通过/);
});

test("automatic failures and stale results still block application", async (t) => {
  let outcome = "failed";
  const { state, acceptance } = await fixture(t, async () => ({ status: outcome, detail: "fixture" }));
  await acceptance.create({ title: "regression", expectation: "pass", kind: "dream-format",
    fixture: { invalid: "invalid", corrected: "valid", prompt: "input" } });
  await assert.rejects(requireApplicable(acceptance, "new"), /自动行为回归/);
  await acceptance.compare("new");
  await assert.rejects(requireApplicable(acceptance, "new"), /自动行为回归/);
  outcome = "passed";
  await acceptance.compare("new");
  await requireApplicable(acceptance, "new");
  state.draftDirty = true;
  await assert.rejects(requireApplicable(acceptance, "new"), /自动行为回归/);
  await requireApplicable(acceptance, "base");
});
