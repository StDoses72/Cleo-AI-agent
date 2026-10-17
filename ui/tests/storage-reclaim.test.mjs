import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as nativeFs from "node:fs/promises";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionStore, exists } from "../electron/evolution-store.mjs";
import { desktopPlatform } from "../electron/platform.mjs";
import { namespaceKey, planKey, reclaimStorage, storageInventory, venvHome, versionKey } from "../electron/storage-reclaim.mjs";

const target = desktopPlatform();
const hex = length => randomUUID().replaceAll("-", "").padEnd(length, "0").slice(0, length);

/** Purpose: Build a disposable data home and evolution control root shaped like a real Windows installation. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-storage-test-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const dataHome = join(root, "home");
  const store = new EvolutionStore(join(root, "control"), dataHome);
  await mkdir(join(dataHome, "memory"), { recursive: true });
  await writeFile(join(dataHome, "memory", "notes.md"), "real memory".repeat(10));
  await mkdir(join(dataHome, "data"), { recursive: true });
  await writeFile(join(dataHome, "data", "sessions.json"), "{}");
  const runtimes = join(dataHome, "runtimes");
  const online = join(runtimes, "online");
  await mkdir(online, { recursive: true });

  /** Register a program bundle; `plan` writes a runtime-plan so it owns an online runtime. */
  const addBuild = async (kind, version, { plan = null, register = true } = {}) => {
    const id = `${kind}-${randomUUID()}`;
    const resources = join(store.root, "builds", id, target.bundle, target.resources);
    await mkdir(join(resources, "python"), { recursive: true });
    await writeFile(join(store.root, "builds", id, target.bundle, target.executable), "exe");
    await writeFile(join(resources, "app.asar"), "bundle ".repeat(100));
    if (plan) await writeFile(join(resources, "runtime-plan.json"), JSON.stringify({ schema: 1, plan }));
    if (register) {
      const state = await store.read();
      await store.update({ builds: [...state.builds, { id, kind, version, executable: `${target.bundle}/${target.executable}` }] });
    }
    return { id, resources };
  };
  /** Create a dependency namespace whose snapshot venv points at `home`. */
  const addNamespace = async (key, home, { snapshots = 1, version = hex(24) } = {}) => {
    const namespace = join(runtimes, key);
    const versionRoot = join(namespace, version);
    for (let index = 0; index < snapshots; index++) {
      const snapshot = join(versionRoot, hex(32));
      await mkdir(join(snapshot, "python", "Lib"), { recursive: true });
      await writeFile(join(snapshot, "python", "pyvenv.cfg"), `home = ${home}\nversion = 3.12.4\n`);
      await writeFile(join(snapshot, "python", "Lib", "big.bin"), "x".repeat(4096));
    }
    await writeFile(join(namespace, "state.json"), "{}");
    return namespace;
  };
  const addOnlineRuntime = async (key, version = "0.8.0") => {
    const directory = join(online, key);
    await mkdir(join(directory, "python"), { recursive: true });
    await writeFile(join(directory, "ready.json"), JSON.stringify({ key, version }));
    await writeFile(join(directory, "python", "python.bin"), "y".repeat(2048));
    return directory;
  };
  const addArchive = async (version, { partial = false, legacy = false } = {}) => {
    if (legacy) {
      const path = join(store.root, "downloads", `v${version}-${target.archive}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "zip".repeat(50));
      return path;
    }
    const directory = join(store.root, "downloads", target.id, version, hex(64));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, partial ? `${target.archive}.${randomUUID()}.partial` : target.archive), "zip".repeat(50));
    return directory;
  };
  const inventory = (options = {}) => storageInventory({ dataHome, store, ...options });
  return { root, dataHome, store, runtimes, online, addBuild, addNamespace, addOnlineRuntime, addArchive, inventory };
}

const byId = (result, prefix) => result.entries.filter(entry => entry.id.startsWith(prefix));

test("pyvenv.cfg home parsing tolerates Windows paths and spacing", () => {
  assert.equal(venvHome("home = C:\\Program Files\\Cleo\\resources\\python\r\ninclude-system-site-packages = false\r\n"), "C:\\Program Files\\Cleo\\resources\\python");
  assert.equal(venvHome("version = 3.12\n"), null);
});

test("dependency namespaces survive while their program exists and are reclaimed once it is gone", async t => {
  const f = await fixture(t);
  const live = await f.addBuild("official", "0.8.2");
  const liveNamespace = await f.addNamespace(namespaceKey(live.resources), join(live.resources, "python"), { version: versionKey("0.8.2") });
  // Deleted program: the namespace key matches nothing and the venv home no longer exists.
  const orphan = await f.addNamespace(hex(24), join(f.store.root, "builds", "official-gone", target.bundle, target.resources, "python"), { snapshots: 2 });
  // Unregistered but present program (for example a copy the user installed by hand): keep.
  const foreign = join(f.root, "elsewhere", target.resources);
  await mkdir(join(foreign, "python"), { recursive: true });
  const foreignNamespace = await f.addNamespace(hex(24), join(foreign, "python"));
  const empty = join(f.runtimes, hex(24));
  await mkdir(empty); await writeFile(join(empty, "state.json"), "{}");

  const result = await f.inventory();
  const namespaces = byId(result, "runtime-namespace:");
  assert.equal(namespaces.length, 4);
  const liveEntry = namespaces.find(e => e.path.startsWith(liveNamespace));
  assert.equal(liveEntry.action, "keep");
  assert.match(liveEntry.reason, /程序 0\.8\.2/);
  assert.equal(namespaces.find(e => e.path === orphan).action, "reclaim");
  assert.equal(namespaces.find(e => e.path === orphan).snapshots, 2);
  assert.equal(namespaces.find(e => e.path === foreignNamespace).action, "keep");
  assert.match(namespaces.find(e => e.path === foreignNamespace).reason, /未登记/);
  assert.equal(namespaces.find(e => e.path === empty).action, "reclaim");
  assert.ok(result.reclaimableBytes > 0 && result.reclaimableBytes < result.totalBytes);
  assert.ok(byId(result, "user-data:").every(entry => entry.action === "keep"));
});

test("in-place upgrades leave old version snapshots that are reclaimed while the current version stays", async t => {
  const f = await fixture(t);
  // Installed launcher outside the evolution store: its release.json says which version runs now.
  const launcherRoot = join(f.root, "Program Files", "Cleo");
  const resources = join(launcherRoot, target.resources);
  await mkdir(join(resources, "python"), { recursive: true });
  const executable = join(launcherRoot, target.executable);
  await writeFile(executable, "exe");
  await writeFile(join(target.platform === "darwin" ? resources : launcherRoot, "release.json"), JSON.stringify({ app: "Cleo", version: "0.9.0" }));
  await f.store.update({ installedReleases: { [executable]: "0.7.0" } });
  const key = namespaceKey(resources);
  const current = join(await f.addNamespace(key, join(resources, "python"), { version: versionKey("0.9.0") }), versionKey("0.9.0"));
  const stale = join(await f.addNamespace(key, join(resources, "python"), { version: versionKey("0.7.0"), snapshots: 2 }), versionKey("0.7.0"));
  // A registered local build without a version keeps every version directory.
  const local = await f.addBuild("local", null);
  const localNamespace = await f.addNamespace(namespaceKey(local.resources), join(local.resources, "python"), { version: versionKey("0.5.0") });

  let result = await f.inventory();
  assert.equal(result.entries.find(e => e.path === current).action, "keep");
  assert.equal(result.entries.find(e => e.path === stale).action, "reclaim");
  assert.match(result.entries.find(e => e.path === stale).reason, /原地升级/);
  assert.equal(result.entries.find(e => e.path === stale).snapshots, 2);
  assert.ok(result.entries.filter(e => e.path.startsWith(localNamespace)).every(e => e.action === "keep"));

  // The running process protects its own version even without release.json.
  result = await f.inventory({ currentResources: join(f.root, "dev", target.resources), currentVersion: "0.7.0",
    currentRuntimeNamespace: join(f.runtimes, key) });
  assert.equal(result.entries.find(e => e.path === stale).action, "keep");
  await reclaimStorage({ dataHome: f.dataHome, store: f.store });
  assert.equal(await exists(stale), false);
  assert.equal(await exists(current), true);
});

test("a startup pass measures only what it reclaims", async t => {
  const f = await fixture(t);
  const live = await f.addBuild("official", "0.8.2");
  await f.addNamespace(namespaceKey(live.resources), join(live.resources, "python"));
  const orphan = await f.addNamespace(hex(24), join(f.root, "gone", "python"));
  const result = await f.inventory({ measure: "reclaim" });
  assert.ok(result.entries.find(e => e.path === orphan).bytes > 0);
  assert.ok(result.entries.filter(e => e.action === "keep").every(e => e.bytes === 0));
  assert.equal(result.totalBytes, result.reclaimableBytes);
});

test("the running program's namespace and runtime are protected even when unregistered", async t => {
  const f = await fixture(t);
  const current = join(f.root, "installed", target.resources);
  await mkdir(join(current, "python"), { recursive: true });
  await writeFile(join(current, "runtime-plan.json"), JSON.stringify({ schema: 1, plan: "current" }));
  const namespace = await f.addNamespace(namespaceKey(current), join(f.root, "nowhere", "python"));
  const key = await planKey(current);
  const runtime = await f.addOnlineRuntime(key, "0.7.0");
  const other = await f.addOnlineRuntime(hex(64), "0.8.1");
  const result = await f.inventory({ currentResources: current, currentRuntimeNamespace: namespace, currentBaseResources: runtime });
  assert.equal(result.entries.find(e => e.path.startsWith(namespace)).action, "keep");
  assert.equal(result.entries.find(e => e.path === runtime).action, "keep");
  assert.equal(result.entries.find(e => e.path === other).action, "reclaim");
  assert.match(result.entries.find(e => e.path === other).reason, /0\.8\.1/);
});

test("online runtimes are kept for retained builds, retiring builds and kept namespaces, otherwise reclaimed", async t => {
  const f = await fixture(t);
  const retained = await f.addBuild("official", "0.8.2", { plan: "0.8.2" });
  const retiring = await f.addBuild("official", "0.7.1", { plan: "0.7.1", register: false });
  await f.store.update({ cleanupPending: [retiring.id] });
  const retainedRuntime = await f.addOnlineRuntime(await planKey(retained.resources), "0.8.2");
  const retiringRuntime = await f.addOnlineRuntime(await planKey(retiring.resources), "0.7.1");
  const unreferenced = await f.addOnlineRuntime(hex(64), "0.8.0");
  // A hand-installed program derives its snapshots from a runtime no registered build names.
  const handInstalled = join(f.root, "hand", target.resources);
  await mkdir(handInstalled, { recursive: true });
  const derived = await f.addOnlineRuntime(hex(64), "0.8.1");
  await f.addNamespace(hex(24), join(derived, "python"));
  const incomplete = join(f.online, hex(64));
  await mkdir(join(incomplete, "python"), { recursive: true });

  const result = await f.inventory();
  const find = path => result.entries.find(e => e.path === path);
  assert.equal(find(retainedRuntime).action, "keep");
  assert.match(find(retiringRuntime).reason, /等待退役/);
  assert.equal(find(retiringRuntime).action, "keep");
  assert.equal(find(unreferenced).action, "reclaim");
  assert.equal(find(derived).action, "keep");
  assert.equal(find(incomplete).action, "reclaim");
  assert.match(find(incomplete).reason, /未完成/);
});

test("package caches follow the size policy and an active installation suspends them", async t => {
  const f = await fixture(t);
  for (const name of ["pip-cache", "npm-cache", "downloads"]) {
    await mkdir(join(f.online, name), { recursive: true });
    await writeFile(join(f.online, name, "blob"), "c".repeat(1000));
  }
  let result = await f.inventory();
  let caches = byId(result, "package-cache:");
  assert.equal(caches.length, 3);
  assert.ok(caches.every(e => e.action === "reclaim" && e.policy === "manual"));
  assert.equal(result.automaticBytes, 0);
  assert.equal(result.reclaimableBytes, 3000);

  result = await f.inventory({ cacheLimit: 1000 });
  assert.ok(byId(result, "package-cache:").every(e => e.policy === "automatic"));
  assert.equal(result.automaticBytes, 3000);

  const scratch = join(f.online, `.install-${hex(6)}`);
  await mkdir(scratch); await writeFile(join(scratch, "partial"), "p");
  result = await f.inventory({ cacheLimit: 1000 });
  assert.ok(byId(result, "package-cache:").every(e => e.action === "keep"));
  assert.equal(result.entries.find(e => e.path === scratch).action, "keep");
  // The same scratch directory a day later is a crash leftover.
  result = await f.inventory({ now: Date.now() + 25 * 60 * 60 * 1000 });
  assert.equal(result.entries.find(e => e.path === scratch).action, "reclaim");
  assert.ok(byId(result, "package-cache:").every(e => e.action === "reclaim"));
});

test("release archives keep the newest, protected and in-progress downloads and reclaim superseded ones", async t => {
  const f = await fixture(t);
  const old = await f.addArchive("0.5.6");
  const current = await f.addArchive("0.7.0");
  const pending = await f.addArchive("0.8.1");
  const newest = await f.addArchive("0.9.0");
  const partial = await f.addArchive("0.8.2", { partial: true });
  const legacy = await f.addArchive("0.6.0", { legacy: true });
  const options = { currentVersion: "0.7.0", protectedVersions: ["0.8.1"] };
  let result = await f.inventory(options);
  const find = path => result.entries.find(e => e.path === path);
  assert.equal(find(old).action, "reclaim");
  assert.equal(find(current).action, "keep");
  assert.equal(find(pending).action, "keep");
  assert.equal(find(newest).action, "keep");
  assert.equal(find(partial).action, "keep");
  assert.equal(find(legacy).action, "reclaim");
  result = await f.inventory({ ...options, downloadsBusy: () => true });
  assert.ok(byId(result, "release-download:").every(e => e.action === "keep"));
});

test("retained builds and backups are listed with reasons but never reclaimed here", async t => {
  const f = await fixture(t);
  const base = await f.addBuild("official", "0.4.1");
  const active = await f.addBuild("official", "0.8.2");
  await f.store.update({ baseline: base.id, active: active.id, lastApplication: { backup: "apply-11111111-1111-1111-1111-111111111111" } });
  for (const id of ["apply-11111111-1111-1111-1111-111111111111", "apply-22222222-2222-2222-2222-222222222222", "manual-copy"]) {
    await mkdir(join(f.store.root, "backups", id), { recursive: true });
    await writeFile(join(f.store.root, "backups", id, "snapshot.json"), "{}");
  }
  const result = await f.inventory();
  assert.ok(byId(result, "build:").every(e => e.action === "keep"));
  assert.match(result.entries.find(e => e.id === `build:${base.id}`).reason, /初始可用版本/);
  assert.match(result.entries.find(e => e.id === `build:${active.id}`).reason, /当前程序/);
  const backups = byId(result, "backup:");
  assert.equal(backups.length, 3);
  assert.ok(backups.every(e => e.action === "keep"));
  assert.match(backups.find(e => e.id.endsWith("1111")).reason, /恢复所需/);
  assert.match(backups.find(e => e.id.endsWith("manual-copy")).reason, /未知/);
  assert.equal(result.reclaimableBytes, 0);
});

test("reclaim journals intent, removes only reclaimable entries and retries failures later", async t => {
  const f = await fixture(t);
  const live = await f.addBuild("official", "0.8.2", { plan: "0.8.2" });
  const liveNamespace = await f.addNamespace(namespaceKey(live.resources), join(live.resources, "python"), { version: versionKey("0.8.2") });
  const orphanA = await f.addNamespace(hex(24), join(f.root, "gone-a", "python"));
  const orphanB = await f.addNamespace(hex(24), join(f.root, "gone-b", "python"));
  const liveRuntime = await f.addOnlineRuntime(await planKey(live.resources), "0.8.2");
  const deadRuntime = await f.addOnlineRuntime(hex(64), "0.8.0");
  await mkdir(join(f.online, "pip-cache")); await writeFile(join(f.online, "pip-cache", "blob"), "c".repeat(100));
  const oldArchive = await f.addArchive("0.5.6");
  await f.addArchive("0.9.0");

  let locked = true;
  const fs = { ...nativeFs, rm: async (path, options) => {
    if (locked && resolve(path) === resolve(orphanB)) { const error = new Error("locked"); error.code = "EPERM"; throw error; }
    return nativeFs.rm(path, options);
  } };
  const options = { dataHome: f.dataHome, store: f.store, fs };
  const first = await reclaimStorage(options);
  assert.deepEqual(first.failed.map(item => item.id), [`runtime-namespace:${orphanB.split(/[\\/]/).pop()}`]);
  assert.equal(first.removed.length, 3);
  assert.equal(await exists(orphanA), false);
  assert.equal(await exists(deadRuntime), false);
  assert.equal(await exists(oldArchive), false);
  assert.equal(await exists(orphanB), true);
  // Convenience caches stay on an automatic pass.
  assert.equal(await exists(join(f.online, "pip-cache")), true);
  assert.equal(await exists(liveNamespace), true);
  assert.equal(await exists(liveRuntime), true);
  assert.equal(await exists(join(f.dataHome, "memory", "notes.md")), true);
  let state = await f.store.read();
  assert.deepEqual(state.storageCleanupPending, first.failed.map(item => item.id));
  assert.equal(state.lastStorageCleanup.failed, 1);
  assert.equal(state.lastStorageCleanup.removed, 3);
  assert.ok(first.freedBytes > 0);
  assert.equal(first.inventory.pending.length, 1);

  locked = false;
  const second = await reclaimStorage(options, { manual: true });
  assert.equal(second.failed.length, 0);
  assert.equal(await exists(orphanB), false);
  assert.equal(await exists(join(f.online, "pip-cache")), false);
  state = await f.store.read();
  assert.deepEqual(state.storageCleanupPending, []);
  assert.equal(state.lastStorageCleanup.manual, true);
  const third = await reclaimStorage(options);
  assert.deepEqual(third, { removed: [], failed: [], freedBytes: 0, inventory: third.inventory });
});

test("linked entries and anything overlapping user data are refused", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(join(outside, hex(24), hex(24)), { recursive: true });
  await writeFile(join(outside, "precious.txt"), "do not delete");
  const linked = join(f.runtimes, hex(24));
  try { await symlink(outside, linked, "junction"); }
  catch (error) { if (error.code === "EPERM") { t.skip("symlinks unavailable"); return; } throw error; }
  // A data entry living under runtimes would make a namespace overlap user data.
  const overlapping = join(f.runtimes, hex(24));
  await mkdir(join(overlapping, hex(24), hex(32)), { recursive: true });
  const result = await reclaimStorage({ dataHome: join(overlapping, hex(24)), store: f.store });
  assert.equal(result.removed.length, 0);
  const inventory = await f.inventory();
  assert.equal(inventory.entries.some(e => e.path === linked), false);
  await reclaimStorage({ dataHome: f.dataHome, store: f.store });
  assert.equal(await exists(join(outside, "precious.txt")), true);
});
