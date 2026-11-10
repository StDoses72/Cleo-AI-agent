import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exists, writeJson } from "../electron/program-store.mjs";
import { ProgramVersions } from "../electron/program-versions.mjs";

/** Purpose: An isolated version manager over a disposable control directory.
 * Input: test context and optional registered builds. Output: manager with their executables on disk.
 */
async function fixture(t, builds = []) {
  const root = await mkdtemp(join(tmpdir(), "cleo-program-versions-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("cleo-program-versions-"));
    await rm(root, { recursive: true, force: true });
  });
  const manager = new ProgramVersions({ app: { isPackaged: false, getVersion: () => "0.3.9" },
    root: join(root, "controller"), dataHome: join(root, "home") });
  t.after(() => manager.close());
  const executable = `${manager.target.bundle}/${manager.target.executable}`;
  for (const build of builds) {
    build.executable = executable;
    await mkdir(dirname(join(manager.store.root, "builds", build.id, executable)), { recursive: true });
    await writeFile(join(manager.store.root, "builds", build.id, executable), build.id);
  }
  if (builds.length) await manager.store.update({ active: builds[0].id, baseline: builds[0].id, builds });
  return { root, manager };
}

test("failed operations retain existing registry and clear busy state for retry", async (t) => {
  const { manager } = await fixture(t);
  await manager.store.update({ active: "working", candidate: "previous" });
  await assert.rejects(manager.operation("downloading", async () => { throw new Error("download failed"); }), /download failed/);
  assert.equal(manager.phase, "idle");
  assert.equal(manager.error, "download failed");
  assert.equal((await manager.store.read()).active, "working");
  assert.equal((await manager.store.read()).candidate, "previous");
  await manager.operation("checking", async () => {});
  assert.equal(manager.error, null);
});

test("controller rejects concurrent operations", async (t) => {
  const { manager } = await fixture(t);
  let finish;
  let started;
  const ready = new Promise((done) => { started = done; });
  const first = manager.operation("downloading", () => new Promise((done) => { finish = done; started(); }));
  await ready;
  await assert.rejects(manager.operation("applying", async () => {}), /另一项版本操作/);
  finish();
  await first;
});

test("releases with the former data-rollback protocol are rejected before downloading", async (t) => {
  const { manager } = await fixture(t);
  manager.ensureBaseline = async () => {};
  await writeJson(join(manager.store.root, "releases.json"), [
    { tag: "v0.3.9", manifestUrl: "https://example.test/release.json" },
  ]);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response(JSON.stringify({ evolution_protocol: 1 }));
  await assert.rejects(manager.downloadRelease("v0.3.9"), /保留当前数据/);
  assert.equal((await manager.store.read()).builds.length, 0);
});

test("a baseline is only retained from a packaged program", async (t) => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.ensureBaseline(), /打包后的 Cleo/);
  assert.equal((await manager.store.read()).baseline, null);
  assert.equal(await exists(join(manager.store.root, "builds")), false);
});

test("local programs an earlier version saved stay selectable; unsaved ones are refused", async (t) => {
  const { manager } = await fixture(t, [
    { id: "base", kind: "official", version: "0.3.9", baseTag: "v0.3.9" },
    { id: "saved", kind: "local", savedAt: "2026-09-13T00:00:00.000Z", name: "0.3.10" },
    { id: "draft", kind: "local", sourceHash: "never-saved" },
  ]);
  await manager.store.update({ latestSaved: "saved", workspaceBase: "base" });
  await assert.rejects(manager.stage("draft"), /从未保存/);
  assert.equal((await manager.store.read()).transaction, null);
  const tx = await manager.stage("saved");
  assert.equal(tx.to, "saved");
  assert.equal(tx.officialSelection, undefined, "A local program is selected without touching the official source baseline");
  await manager.store.activate();
  await manager.store.healthy(tx.id);
  const state = await manager.store.read();
  assert.equal(state.active, "saved");
  // Retention keeps what a rollback needs, and still reclaims the build nobody saved.
  assert.deepEqual(state.builds.map(build => build.id), ["base", "saved"]);
  assert.equal(await readFile(join(manager.store.root, "builds/saved", state.builds[1].executable), "utf8"), "saved");
});

test("unfinished local work an earlier version recorded blocks an official switch without being touched", async (t) => {
  const { manager } = await fixture(t, [
    { id: "base", kind: "official", version: "0.3.9", baseTag: "v0.3.9" },
    { id: "next", kind: "official", version: "0.4.0", baseTag: "v0.4.0" },
    { id: "draft", kind: "local", sourceHash: "unsaved" },
  ]);
  const source = join(manager.store.root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "draft.txt"), "unfinished work");
  await manager.store.update({ iteration: { base: "base" }, draftDirty: true, candidate: "draft", threadId: "editing-thread" });
  const before = await readFile(manager.store.statePath);
  await assert.rejects(manager.stage("next"), /保存或放弃/);
  assert.deepEqual(await readFile(manager.store.statePath), before);
  assert.equal(await readFile(join(source, "draft.txt"), "utf8"), "unfinished work");
  await manager.store.build("draft");
});
