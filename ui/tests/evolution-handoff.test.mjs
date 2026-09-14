import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { EvolutionStore } from "../electron/evolution-store.mjs";
import { runHandoff } from "../electron/evolution-handoff.mjs";

/** Purpose: Run real activation journals with deterministic startup outcomes. Input: test and healthy ids. Output: fixture and hooks. */
async function fixture(t, healthy) {
  const root = await mkdtemp(join(tmpdir(), "cleo-handoff-test-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(root.includes("cleo-handoff-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const store = new EvolutionStore(join(root, "control"), join(root, "home"));
  await mkdir(join(store.dataHome, "data"), { recursive: true });
  await writeFile(join(store.dataHome, "data/latest.txt"), "latest");
  const builds = ["base", "saved", "draft"].map((id) => ({ id, kind: id === "base" ? "official" : "local",
    executable: "Cleo/app.exe", ...(id === "saved" ? { savedAt: "2026-01-01" } : {}) }));
  for (const build of builds) {
    await mkdir(join(store.root, "builds", build.id, "Cleo"), { recursive: true });
    await writeFile(join(store.root, "builds", build.id, build.executable), build.id);
  }
  await store.update({ builds, active: "saved", baseline: "base", workspaceBase: "base", latestSaved: "saved",
    candidate: "draft", iteration: { base: "saved" } });
  await store.stage("draft");
  const events = [];
  const hooks = {
    withLock: (action) => action(),
    progress: async (title) => { events.push(title); },
    launch: async (build) => { events.push("launch:" + build.id); return { id: build.id }; },
    waitHealthy: async (child, tx) => {
      if (!healthy.includes(child.id)) {
        await writeFile(join(store.dataHome, "data/latest.txt"), "newer data");
        return false;
      }
      await store.healthy(tx);
      return true;
    },
    stop: async (child) => { events.push("stop:" + child.id); },
  };
  return { store, hooks, events };
}

test("successful startup completes the requested application", async (t) => {
  const { store, hooks } = await fixture(t, ["draft"]);
  assert.deepEqual(await runHandoff(store, hooks), { ok: true, recovered: false, active: "draft" });
  assert.equal((await store.read()).transaction, null);
});

test("failed application stops before rollback and preserves the newest user data", async (t) => {
  const { store, hooks, events } = await fixture(t, ["saved"]);
  assert.deepEqual(await runHandoff(store, hooks), { ok: true, recovered: true, active: "saved" });
  assert.ok(events.indexOf("stop:draft") < events.indexOf("launch:saved"));
  assert.equal(await readFile(join(store.dataHome, "data/latest.txt"), "utf8"), "newer data");
  assert.ok((await store.read()).lastRestartError.includes("自动回到"));
});

test("all startup failures return to the interactive recovery owner", async (t) => {
  const { store, hooks, events } = await fixture(t, []);
  assert.equal((await runHandoff(store, hooks)).ok, false);
  assert.deepEqual(events.filter((event) => event.startsWith("launch:")), ["launch:draft", "launch:saved", "launch:base"]);
  assert.equal(await readFile(join(store.dataHome, "data/latest.txt"), "utf8"), "newer data");
});

test("a process that cannot be stopped prevents another app using the same data", async (t) => {
  const { store, hooks, events } = await fixture(t, []);
  hooks.stop = async () => { throw new Error("still alive"); };
  assert.equal((await runHandoff(store, hooks)).ok, false);
  assert.deepEqual(events.filter((event) => event.startsWith("launch:")), ["launch:draft"]);
});
