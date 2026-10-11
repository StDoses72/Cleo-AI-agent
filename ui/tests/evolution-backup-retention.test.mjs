import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionStore, exists, readJson, writeJson } from "../electron/evolution-store.mjs";

const backupId = (index) => `apply-${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`;

async function fixture(t, sameHome = false) {
  const root = await mkdtemp(join(tmpdir(), "cleo-backup-retention-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const data = join(root, "home");
  await mkdir(join(data, "data"), { recursive: true });
  await writeFile(join(data, "data/conversation.json"), "current user data");
  const store = new EvolutionStore(join(sameHome ? data : root, "evolution"), data);
  const executable = join(store.root, "builds/baseline/Cleo/app.exe");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "baseline");
  await store.update({ baseline: "baseline", active: "baseline",
    builds: [{ id: "baseline", kind: "official", executable: "Cleo/app.exe" }] });
  const parent = join(store.root, "backups");
  async function seed(index) {
    const id = backupId(index);
    await store.backup(id);
    const path = join(parent, id, "snapshot.json");
    await writeJson(path, { ...await readJson(path), createdAt: `2026-01-${String(index).padStart(2, "0")}T00:00:00.000Z` });
    return id;
  }
  return { root, data, store, parent, seed };
}

for (const sameHome of [false, true]) {
  test(`healthy startup trims accumulated snapshots to three (shared home: ${sameHome})`, async (t) => {
    const { data, store, parent, seed } = await fixture(t, sameHome);
    for (let index = 1; index <= 6; index++) await seed(index);
    // Directory access/copy times must not change which snapshots are newest.
    await utimes(join(parent, backupId(1)), new Date("2030-01-01"), new Date("2030-01-01"));
    await store.update({ lastApplication: { backup: backupId(6) } });

    await store.exclusive(() => store.healthy());

    assert.deepEqual((await readdir(parent)).sort(), [4, 5, 6].map(backupId));
    assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), "current user data");
    assert.equal((await store.read()).lastApplication.backup, backupId(6));
  });
}

test("activation journals its new backup before pruning and protects the last application", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  await store.update({ lastApplication: { backup: backupId(1) } });
  const tx = await store.stage("baseline");

  await store.exclusive(() => store.activate());

  const state = await store.read();
  assert.equal(state.transaction.backup, `apply-${tx.id}`);
  assert.deepEqual((await readdir(parent)).sort(), [backupId(1), backupId(5), `apply-${tx.id}`].sort());
  assert.equal(await readFile(join(parent, state.transaction.backup, "data/conversation.json"), "utf8"), "current user data");
});

test("repeated applications retain the last three snapshots without changing live data", async (t) => {
  const { store, data, parent } = await fixture(t);
  const backup = store.backup.bind(store);
  const applied = [];
  t.mock.method(store, "backup", async (id) => {
    await backup(id);
    const path = join(parent, id, "snapshot.json");
    await writeJson(path, { ...await readJson(path), createdAt: `2026-01-0${applied.length + 1}T00:00:00.000Z` });
    return id;
  });
  for (let index = 1; index <= 6; index++) {
    const tx = await store.stage("baseline");
    await store.activate();
    applied.push(`apply-${tx.id}`);
    await store.healthy(tx.id);
    assert.deepEqual((await readdir(parent)).sort(), applied.slice(-3).sort());
  }
  assert.equal(await readFile(join(data, "data/conversation.json"), "utf8"), "current user data");
});

test("a failed new backup does not remove the previous complete snapshots", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 3; index++) await seed(index);
  const failed = t.mock.method(store, "backup", async (id) => {
    await mkdir(join(parent, id));
    await writeFile(join(parent, id, "partial.txt"), "unfinished");
    throw new Error("copy failed");
  });
  const tx = await store.stage("baseline");
  await assert.rejects(store.activate(), /copy failed/);
  assert.deepEqual((await readdir(parent)).sort(), [...[1, 2, 3].map(backupId), `apply-${tx.id}`].sort());
  failed.mock.restore();
  await store.activate();
  assert.deepEqual((await readdir(parent)).sort(), [backupId(2), backupId(3), `apply-${tx.id}`].sort());
});

test("ordinary startup without any backups needs no cleanup directory", async (t) => {
  const { store, parent } = await fixture(t);
  await store.healthy();
  assert.equal(await exists(parent), false);
});

test("a missing historical reference does not consume a retained snapshot slot", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  await store.update({ lastApplication: { backup: backupId(9) } });
  await store.healthy();
  assert.deepEqual((await readdir(parent)).sort(), [3, 4, 5].map(backupId));
});

test("unavailable live-data paths suspend cleanup without preventing startup", async (t) => {
  const { store, data, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  const realpath = fs.realpath;
  let deny = true;
  t.mock.method(fs, "realpath", async (path, ...options) => {
    if (resolve(path) === data && deny) throw Object.assign(new Error("temporarily inaccessible"), { code: "EACCES" });
    return realpath(path, ...options);
  });

  await store.healthy();
  assert.equal((await readdir(parent)).length, 5);
  deny = false;
  await store.healthy();
  assert.deepEqual((await readdir(parent)).sort(), [3, 4, 5].map(backupId));
});

test("a completed but not yet journaled transaction backup counts toward the three kept", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  await store.update({ transaction: { id: backupId(2).slice(6), backup: null, phase: "staged" },
    lastApplication: { backup: backupId(1) } });

  await store.exclusive(() => store.pruneBackups());

  assert.deepEqual((await readdir(parent)).sort(), [1, 2, 5].map(backupId));
});

test("unconfirmed startup does not prune snapshots", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  await store.update({ transaction: { id: "starting", backup: backupId(5), phase: "starting" } });

  await store.healthy("other-transaction");
  await store.healthy();
  assert.equal((await readdir(parent)).length, 5);
  await store.healthy("starting");
  assert.deepEqual((await readdir(parent)).sort(), [3, 4, 5].map(backupId));
});

test("partial deletion is retried after reopening even when its completion marker is gone", async (t) => {
  const { data, store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  const blocked = join(parent, backupId(1));
  let deny = true;
  t.mock.method(fs, "rm", async (path, options) => {
    if (resolve(path) === blocked && deny) {
      assert.ok((await store.read()).backupCleanupPending.includes(backupId(1)));
      await rm(join(blocked, "snapshot.json"), { force: true });
      throw Object.assign(new Error("temporarily locked"), { code: "EBUSY" });
    }
    return rm(path, options);
  });

  await store.pruneBackups();
  assert.deepEqual((await store.read()).backupCleanupPending, [backupId(1)]);
  assert.equal(await exists(join(blocked, "snapshot.json")), false);
  deny = false;
  const reopened = new EvolutionStore(store.root, data);
  await reopened.pruneBackups();
  assert.deepEqual((await readdir(parent)).sort(), [3, 4, 5].map(backupId));
  assert.deepEqual((await reopened.read()).backupCleanupPending, []);
});

test("incomplete, malformed, and unrelated backup folders are left alone", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  const incomplete = backupId(10), malformed = backupId(11);
  await mkdir(join(parent, incomplete));
  await writeFile(join(parent, incomplete, "partial.txt"), "unfinished");
  await mkdir(join(parent, malformed));
  await writeFile(join(parent, malformed, "snapshot.json"), "{broken");
  await store.backup("manual-copy");
  await store.update({ backupCleanupPending: ["../home", "manual-copy", backupId(5)] });

  await store.pruneBackups();

  assert.deepEqual((await readdir(parent)).sort(), [...[3, 4, 5].map(backupId), incomplete, malformed, "manual-copy"].sort());
  assert.equal(await readFile(join(parent, incomplete, "partial.txt"), "utf8"), "unfinished");
  assert.equal(await readFile(join(parent, malformed, "snapshot.json"), "utf8"), "{broken");
  assert.ok(await exists(join(parent, "manual-copy/snapshot.json")));
});

test("a linked backup cannot delete external files", async (t) => {
  const { root, store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "important.txt"), "keep");
  await symlink(outside, join(parent, backupId(9)), process.platform === "win32" ? "junction" : "dir");
  await store.update({ backupCleanupPending: [backupId(9)] });

  await store.pruneBackups();

  assert.equal(await readFile(join(outside, "important.txt"), "utf8"), "keep");
  assert.ok(await exists(join(parent, backupId(9))));
  assert.ok(await exists(join(parent, backupId(5), "snapshot.json")));
});

test("a relocated backups parent is not traversed", async (t) => {
  const { root, store, parent } = await fixture(t);
  const outside = join(root, "outside");
  for (let index = 1; index <= 5; index++) {
    await writeJson(join(outside, backupId(index), "snapshot.json"), {
      entries: [], createdAt: `2026-01-0${index}T00:00:00.000Z`,
    });
  }
  await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");

  await store.pruneBackups();

  assert.equal((await readdir(outside)).length, 5);
});

test("cleanup cannot remove a backup that is now the live data home", async (t) => {
  const { store, parent, seed } = await fixture(t);
  for (let index = 1; index <= 5; index++) await seed(index);
  const live = join(parent, backupId(1));
  const redirected = new EvolutionStore(store.root, live);

  await redirected.pruneBackups();

  assert.equal(await readFile(join(live, "data/conversation.json"), "utf8"), "current user data");
});
