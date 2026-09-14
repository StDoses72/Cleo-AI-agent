import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionStore, readJson, writeJson, ownedPath } from "../electron/evolution-store.mjs";

/** Purpose: Provide isolated program/data records. Input: test context. Output: disposable store. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-evolution-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes("cleo-evolution-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const data = join(root, "home");
  await mkdir(join(data, "data"), { recursive: true });
  await writeFile(join(data, "data", "conversation.json"), '{"turn":1}');
  const store = new EvolutionStore(join(root, "control"), data);
  const builds = ["baseline", "local"].map((id) => ({ id, executable: "Cleo/app.exe", kind: id === "local" ? "local" : "official" }));
  for (const build of builds) {
    const executable = join(store.root, "builds", build.id, build.executable);
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, build.id);
  }
  await store.update({ baseline: "baseline", active: "baseline", builds });
  return { root, data, store };
}

test("staging leaves the current app and data untouched; activation backs up before switching", async (t) => {
  const { data, store } = await fixture(t);
  const tx = await store.stage("local");
  assert.equal((await store.read()).active, "baseline");
  assert.equal((await store.read()).transaction.phase, "staged");
  await store.activate();
  const starting = await store.read();
  assert.equal(starting.active, "local");
  assert.equal(starting.transaction.phase, "starting");
  assert.equal(await readFile(join(store.root, "backups", starting.transaction.backup, "data/conversation.json"), "utf8"), '{"turn":1}');
  assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), '{"turn":1}');
  await store.healthy("wrong-id");
  assert.ok((await store.read()).transaction);
  await store.healthy(tx.id);
  assert.equal((await store.read()).transaction, null);
  assert.equal((await store.read()).lastApplication.from, "baseline");
});

test("repeated version switches preserve the latest data instead of replaying snapshots", async (t) => {
  const { data, store } = await fixture(t);
  const initial = await store.stage("local");
  await store.activate();
  await store.healthy(initial.id);
  const latest = {
    "data/conversation.json": '{"turn":2,"messages":["new message"]}',
    "memory/MEMORY.md": "new memory",
    "config/cleo.json": '{"theme":"light","futureField":true}',
    "skills/new.txt": "new skill",
    "PERSONA.md": "updated persona",
    "AGENTS.md": "user guidance",
  };
  for (const [name, value] of Object.entries(latest)) {
    await mkdir(dirname(join(data, name)), { recursive: true });
    await writeFile(join(data, name), value);
  }
  for (const target of ["baseline", "local", "baseline"]) {
    const tx = await store.stage(target);
    await store.activate();
    await store.healthy(tx.id);
    assert.equal((await store.read()).active, target);
    for (const [name, value] of Object.entries(latest)) {
      assert.equal(await readFile(join(data, name), "utf8"), value);
    }
  }
});

test("an interrupted backup is never promoted; restarting activation completes it", async (t) => {
  const { store } = await fixture(t);
  const tx = await store.stage("local");
  const partial = join(store.root, "backups", `apply-${tx.id}`);
  await mkdir(partial, { recursive: true });
  await writeFile(join(partial, "partial"), "incomplete");
  await store.activate();
  assert.ok(await readJson(join(partial, "snapshot.json")));
  await assert.rejects(readFile(join(partial, "partial")), { code: "ENOENT" });
});

test("missing executable never replaces a working selection", async (t) => {
  const { store } = await fixture(t);
  await rm(join(store.root, "builds/local/Cleo/app.exe"));
  await assert.rejects(store.stage("local"), /文件缺失/);
  assert.equal((await store.read()).active, "baseline");
  assert.equal((await store.read()).transaction, null);
});

test("failed-start recovery keeps new data even when the old backup is missing", async (t) => {
  const { data, store } = await fixture(t);
  await store.stage("local");
  await store.activate();
  await writeFile(join(data, "data/conversation.json"), '{"turn":3}');
  const state = await store.read();
  await rm(join(store.root, "backups", state.transaction.backup), { recursive: true });
  await store.recover("baseline");
  assert.equal((await store.read()).active, "baseline");
  assert.equal((await store.read()).transaction, null);
  assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), '{"turn":3}');
});

test("path traversal and unregistered executables are rejected", async (t) => {
  const { store } = await fixture(t);
  assert.throws(() => ownedPath(store.root, "..", "outside"), /Invalid/);
  await assert.rejects(store.recover("../outside"), /找不到/);
  await assert.rejects(store.stage("unregistered"), /找不到/);
  await store.update({ builds: [{ id: "escape", executable: "../../outside.exe" }] });
  await assert.rejects(store.build("escape"), /Invalid/);
});

test("linked data cannot make backups read outside the owned home", async (t) => {
  const { root, data, store } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(data, "memory"), process.platform === "win32" ? "junction" : "dir");
  await store.stage("local");
  await assert.rejects(store.activate(), /链接/);
  assert.equal((await store.read()).active, "baseline");
});

test("legacy restore requests and journals never overwrite current data during activation", async (t) => {
  const { data, store } = await fixture(t);
  await store.backup("before");
  await writeFile(join(data, "data/conversation.json"), '{"turn":2}');
  const tx = await store.stage("local");
  await store.update({ transaction: { ...tx, restore: "before" } });
  await writeJson(join(store.root, "restore.json"), { id: "before", completed: [] });
  await store.activate();
  assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), '{"turn":2}');
  assert.equal((await store.read()).transaction.restore, undefined);
  await store.healthy(tx.id);
  assert.equal((await store.read()).lastApplication.restore, undefined);
});

test("a missing recovery executable leaves selection and current data unchanged", async (t) => {
  const { data, store } = await fixture(t);
  await rm(join(store.root, "builds/baseline/Cleo/app.exe"));
  await assert.rejects(store.recover("baseline"), /文件缺失/);
  assert.equal((await store.read()).active, "baseline");
  assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), '{"turn":1}');
});

test("saving an applied local version makes it the next iteration base without changing data", async (t) => {
  const { data, store } = await fixture(t);
  await store.beginIteration();
  await assert.rejects(store.saveVersion(), /先应用/);
  const tx = await store.stage("local");
  await store.activate();
  await assert.rejects(store.saveVersion(), /启动完成/);
  await store.healthy(tx.id);
  await writeFile(join(data, "data/conversation.json"), '{"turn":9}');
  const saved = await store.saveVersion("我的界面");
  assert.equal(saved.name, "我的界面");
  assert.ok(saved.savedAt);
  assert.equal((await store.read()).iteration, null);
  assert.equal((await store.beginIteration()).base, "local");
  assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), '{"turn":9}');
});

test("repeated applications keep the original iteration base", async (t) => {
  const { store } = await fixture(t);
  assert.equal((await store.beginIteration()).base, "baseline");
  const tx = await store.stage("local");
  await store.activate();
  await store.healthy(tx.id);
  assert.equal((await store.beginIteration()).base, "baseline");
});

test("only one staged application can be outstanding", async (t) => {
  const { store } = await fixture(t);
  await store.stage("local");
  await assert.rejects(store.stage("baseline"), /尚未完成/);
});
