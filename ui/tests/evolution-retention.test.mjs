import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionStore, exists } from "../electron/evolution-store.mjs";

/** Purpose: Exercise retention with actual disposable directories.
 * Input: test context. Output: store, build-registration and apply helpers; fixtures are removed afterward.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-retention-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("cleo-retention-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const store = new EvolutionStore(join(root, "control"), join(root, "home"));
  await mkdir(join(root, "home/data"), { recursive: true });
  await writeFile(join(root, "home/data/latest.json"), "latest user data");
  const add = async (id, extra = {}) => {
    const build = { id, executable: "Cleo/app.exe", kind: "local", ...extra };
    const file = join(store.root, "builds", id, build.executable);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, id);
    const state = await store.read();
    await store.update({ builds: [...state.builds, build], candidate: id });
  };
  const apply = async (id) => {
    const tx = await store.stage(id);
    await store.activate();
    await store.healthy(tx.id);
  };
  await add("baseline", { kind: "official" });
  await store.update({ baseline: "baseline", active: "baseline", candidate: null });
  return { store, root, add, apply };
}

test("repeated saves replace the previous save while keeping the original base and latest data", async (t) => {
  const { store, add, apply } = await fixture(t);
  for (const id of ["first", "second", "third"]) {
    await store.beginIteration();
    await add(id);
    await apply(id);
    await store.saveVersion(id);
    const state = await store.read();
    assert.deepEqual(state.builds.map((build) => build.id).sort(), ["baseline", id].sort());
    assert.equal(state.workspaceBase, "baseline");
    assert.equal(state.latestSaved, id);
  }
  assert.equal(await exists(join(store.root, "builds/first")), false);
  assert.equal(await exists(join(store.root, "builds/second")), false);
  assert.equal(await readFile(join(store.dataHome, "data/latest.json"), "utf8"), "latest user data");
});

test("new candidates replace unused builds; applied drafts survive until successful startup", async (t) => {
  const { store, add, apply } = await fixture(t);
  await store.beginIteration();
  await add("saved");
  await apply("saved");
  await store.saveVersion();
  await store.beginIteration();
  await add("unused");
  await add("draft-one");
  await store.pruneBuilds();
  assert.equal(await exists(join(store.root, "builds/unused")), false);
  await apply("draft-one");
  await add("draft-two");
  const tx = await store.stage("draft-two");
  await store.activate();
  await store.pruneBuilds();
  assert.ok(await exists(join(store.root, "builds/draft-one")));
  await store.healthy("wrong-id");
  assert.ok(await exists(join(store.root, "builds/draft-one")));
  await store.healthy(tx.id);
  assert.equal(await exists(join(store.root, "builds/draft-one")), false);
  assert.deepEqual((await store.read()).builds.map((build) => build.id), ["baseline", "saved", "draft-two"]);
  assert.equal((await store.read()).iteration.base, "saved");
  await store.saveVersion();
  assert.equal(await exists(join(store.root, "builds/saved")), false);
});

test("failed startup leaves both last saved version and iteration base available for recovery", async (t) => {
  const { store, add, apply } = await fixture(t);
  await store.beginIteration();
  await add("saved");
  await apply("saved");
  await store.saveVersion();
  await store.beginIteration();
  await add("broken");
  await store.stage("broken");
  await store.activate();
  await store.pruneBuilds();
  await store.recover("saved");
  await store.update({ iteration: null, selectedBase: "saved", candidate: null });
  await store.pruneBuilds();
  assert.equal(await exists(join(store.root, "builds/broken")), false);
  assert.equal((await store.read()).active, "saved");
  assert.ok(await store.build("baseline"));
  assert.equal(await readFile(join(store.dataHome, "data/latest.json"), "utf8"), "latest user data");
});

test("new bundle import does not retire the previous program before it reports healthy", async (t) => {
  const { store, add } = await fixture(t);
  await add("old", { savedAt: "2026-01-01" });
  await add("new", { savedAt: "2026-02-01" });
  await store.update({ active: "new", workspaceBase: "new", latestSaved: "new",
    candidate: null, pendingImport: { from: "old", to: "new" } });
  await store.pruneBuilds();
  assert.ok(await exists(join(store.root, "builds/old")));
  await store.healthy();
  assert.equal(await exists(join(store.root, "builds/old")), false);
  assert.ok(await store.build("baseline"));
});

test("linked obsolete directories cannot delete external data and cleanup can be retried", async (t) => {
  const { store, root, add } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "important.txt"), "keep");
  const linked = join(store.root, "builds/linked");
  await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
  await store.update({ candidate: null, cleanupPending: ["linked", "../home"] });
  await store.pruneBuilds();
  assert.equal(await readFile(join(outside, "important.txt"), "utf8"), "keep");
  assert.deepEqual((await store.read()).cleanupPending, ["linked"]);
  await rm(linked);
  await store.pruneBuilds();
  assert.deepEqual((await store.read()).cleanupPending, []);
  await add("obsolete");
  await store.update({ candidate: null });
  await rm(join(store.root, "builds/baseline/Cleo/app.exe"));
  await store.pruneBuilds();
  assert.ok(await exists(join(store.root, "builds/obsolete")), "A missing recovery base suspends cleanup.");
});

test("startup and UI mutations sharing a registry cannot overlap cleanup", async (t) => {
  const { store } = await fixture(t);
  const other = new EvolutionStore(store.root, store.dataHome);
  const order = [];
  let release;
  const first = store.exclusive(async () => {
    order.push("startup");
    await new Promise((done) => { release = done; });
    order.push("cleaned");
  });
  await new Promise((done) => setImmediate(done));
  const second = other.exclusive(async () => { order.push("build"); });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(order, ["startup"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["startup", "cleaned", "build"]);
  await assert.rejects(store.exclusive(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await other.exclusive(async () => "recovered"), "recovered");
});

test("an unregistered failed copy is reclaimed but unrelated folders are not", async (t) => {
  const { store } = await fixture(t);
  const abandoned = "baseline-00000000-0000-0000-0000-000000000000";
  await mkdir(join(store.root, "builds", abandoned));
  await mkdir(join(store.root, "builds/notes"));
  await store.pruneBuilds();
  assert.equal(await exists(join(store.root, "builds", abandoned)), false);
  assert.ok(await exists(join(store.root, "builds/notes")));
});
