import test from "node:test";
import assert from "node:assert/strict";
import { evolutionActions, incrementLastNumber, nextVersionName } from "./evolution-actions.mjs";

test("the last number of a version name is incremented", () => {
  assert.equal(incrementLastNumber("0.5.18"), "0.5.19");
  assert.equal(incrementLastNumber("v1.9"), "v1.10");
  assert.equal(incrementLastNumber("界面 2 版"), "界面 3 版");
  assert.equal(incrementLastNumber("build-009"), "build-010");
  assert.equal(incrementLastNumber("99999999999999999999"), "100000000000000000000");
  assert.equal(incrementLastNumber("我的界面"), "我的界面.1");
  assert.equal(incrementLastNumber(""), "1");
});

test("default names follow the latest saved version, else the release the work is based on", () => {
  const official = { id: "official", kind: "official", version: "0.5.18" };
  assert.equal(nextVersionName({ builds: [official], active: "official" }), "0.5.19");
  assert.equal(nextVersionName({ builds: [{ ...official, version: "0.6.0-alpha" }], active: "official" }), "0.6.1");
  const saved = { id: "saved", kind: "local", version: "0.5.18", name: "0.5.21", savedAt: "2026-09-02T00:00:00Z" };
  const older = { id: "older", kind: "local", version: "0.5.18", name: "0.5.20", savedAt: "2026-09-01T00:00:00Z" };
  assert.equal(nextVersionName({ builds: [official, older, saved], latestSaved: "saved", active: "saved" }), "0.5.22");
  const unnamed = { ...saved, name: undefined };
  assert.equal(nextVersionName({ builds: [official, older, unnamed], latestSaved: "saved", active: "saved" }), "0.5.21");
  assert.equal(nextVersionName({ builds: [], currentVersion: "0.5.18" }), "0.5.19");
  assert.equal(nextVersionName(null), "0.0.1");
});

test("readiness mirrors the main panel: check, then apply, then save", () => {
  const base = { id: "base", kind: "official", version: "0.5.18" };
  const candidate = { id: "cand", kind: "local", version: "0.5.18", sourceHash: "h" };
  const iteration = { id: "it", base: "base" };
  const pending = evolutionActions({ phase: "idle", builds: [base], active: "base", iteration, validation: { status: "pending" } });
  assert.deepEqual([pending.needsCheck, pending.canApply, pending.canSave], [true, false, false]);
  const passed = { status: "passed", sourceHash: "h", candidate: "cand" };
  const ready = evolutionActions({ phase: "idle", builds: [base, candidate], active: "base", candidate: "cand", iteration, validation: passed });
  assert.deepEqual([ready.needsCheck, ready.canApply, ready.candidateId, ready.canSave], [false, true, "cand", false]);
  const dirty = evolutionActions({ phase: "idle", builds: [base, candidate], active: "base", candidate: "cand", iteration, validation: passed, draftDirty: true });
  assert.deepEqual([dirty.needsCheck, dirty.canApply], [true, false]);
  const applied = evolutionActions({ phase: "idle", builds: [base, candidate], active: "cand", candidate: "cand", iteration, validation: passed });
  assert.deepEqual([applied.canApply, applied.canSave, applied.suggestedName], [false, true, "0.5.19"]);
  const failed = evolutionActions({ phase: "idle", builds: [base], active: "base", iteration, validation: { status: "failed" } });
  assert.equal(failed.checkFailed, true);
  assert.equal(evolutionActions({ phase: "building", builds: [], iteration }).busy, true);
  assert.equal(evolutionActions({ phase: "idle", builds: [] }).busy, false);
});
