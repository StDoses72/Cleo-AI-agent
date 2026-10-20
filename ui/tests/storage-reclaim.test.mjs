import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as nativeFs from "node:fs/promises";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { EvolutionStore, exists } from "../electron/evolution-store.mjs";
import { desktopPlatform } from "../electron/platform.mjs";
import { createStorageQueue, defaultLauncherPaths, installedLauncherPaths, namespaceKey, planKey, reclaimStorage, storageInventory, venvHome, versionKey } from "../electron/storage-reclaim.mjs";

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
  const addOnlineRuntime = async (key, version = "0.8.0", { completed = true } = {}) => {
    const directory = join(online, key);
    await mkdir(join(directory, "python"), { recursive: true });
    if (completed) await writeFile(join(directory, "ready.json"), JSON.stringify({ key, version }));
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
  assert.equal(result.entries.find(e => e.path === other).action, "keep");
  assert.match(result.entries.find(e => e.path === other).reason, /无法确认无人使用/);
});

test("online runtimes retain known owners and unproven orphans, and reclaim incomplete orphans", async t => {
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
  assert.equal(find(unreferenced).action, "keep");
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
  const incompleteRuntime = await f.addOnlineRuntime(hex(64), "0.8.0", { completed: false });
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
  assert.equal(await exists(incompleteRuntime), false);
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

test("another release channel's programs and snapshots keep the shared online runtime", async t => {
  const f = await fixture(t);
  // The sibling channel (Cleo Alpha) has its own registry and data home but installs into the same online root.
  const sibling = { label: "Cleo Alpha", controlRoot: join(f.root, "alpha-userdata", "evolution"), dataHome: join(f.root, "alpha-home") };
  const id = `official-${randomUUID()}`;
  const resources = join(sibling.controlRoot, "builds", id, target.bundle, target.resources);
  await mkdir(resources, { recursive: true });
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify({ schema: 1, plan: "alpha-0.9.1" }));
  await writeFile(join(sibling.controlRoot, "state.json"), JSON.stringify({ builds: [{ id, kind: "official", version: "0.9.1-alpha" }] }));
  const byPlan = await f.addOnlineRuntime(await planKey(resources), "0.9.1-alpha");
  const bySnapshot = await f.addOnlineRuntime(hex(64), "0.8.9-alpha");
  const alphaRuntimes = join(sibling.dataHome, "runtimes", hex(24), hex(24), hex(32), "python");
  await mkdir(alphaRuntimes, { recursive: true });
  await writeFile(join(alphaRuntimes, "pyvenv.cfg"), `home = ${join(bySnapshot, "python")}\n`);
  const orphan = await f.addOnlineRuntime(hex(64), "0.8.0", { completed: false });

  const without = await f.inventory();
  assert.match(without.entries.find(e => e.path === byPlan).reason, /无法确认无人使用/, "the sibling owner is unknown unless declared");
  const result = await f.inventory({ siblings: [sibling] });
  const find = path => result.entries.find(e => e.path === path);
  assert.equal(find(byPlan).action, "keep");
  assert.match(find(byPlan).reason, /Cleo Alpha/);
  assert.equal(find(bySnapshot).action, "keep");
  assert.equal(find(orphan).action, "reclaim");
});

test("a runtimes directory linked to user data is never inventoried or reclaimed", async t => {
  const f = await fixture(t);
  await rm(f.runtimes, { recursive: true, force: true });
  // Real memory data whose folder names happen to look like a runtime namespace and snapshot.
  const lookalike = join(f.dataHome, "memory", hex(24), hex(24), hex(32), "python");
  await mkdir(lookalike, { recursive: true });
  await writeFile(join(lookalike, "pyvenv.cfg"), `home = ${join(f.root, "gone", "python")}\n`);
  await writeFile(join(f.dataHome, "memory", "notes.md"), "irreplaceable");
  try { await symlink(join(f.dataHome, "memory"), f.runtimes, "junction"); }
  catch (error) { if (error.code === "EPERM") { t.skip("links unavailable"); return; } throw error; }

  const inventory = await f.inventory();
  assert.equal(inventory.entries.filter(e => e.kind === "runtime-namespace").length, 0);
  assert.equal(inventory.reclaimableBytes, 0);
  const result = await reclaimStorage({ dataHome: f.dataHome, store: f.store }, { manual: true });
  assert.equal(result.removed.length, 0);
  assert.equal(await exists(join(lookalike, "pyvenv.cfg")), true);
  assert.equal(await exists(join(f.dataHome, "memory", "notes.md")), true);
});

test("an entry that resolves into user data through a link is refused at reclaim time", async t => {
  const f = await fixture(t);
  // The inventory decided on a plain orphan namespace; a link swapped in underneath must still not reach user data.
  const orphan = await f.addNamespace(hex(24), join(f.root, "gone", "python"));
  const fs = { ...nativeFs, realpath: async path => resolve(path) === resolve(orphan) ? join(f.dataHome, "memory") : nativeFs.realpath(path) };
  const result = await reclaimStorage({ dataHome: f.dataHome, store: f.store, fs });
  assert.equal(result.removed.length, 0);
  assert.equal(result.failed.length, 0, "the inventory already refused it, so nothing was attempted");
  const entry = result.inventory.entries.find(e => e.path === orphan);
  assert.equal(entry.action, "keep");
  assert.match(entry.reason, /用户数据/);
  assert.equal(await exists(orphan), true);
});

test("queued storage requests resolve to their own results in order", async () => {
  const queue = createStorageQueue();
  const order = [];
  const slow = queue(async () => { await new Promise(done => setTimeout(done, 30)); order.push("reclaim"); return { removed: [] }; });
  const fast = queue(async () => { order.push("inventory"); return { entries: [] }; });
  const failing = queue(async () => { throw new Error("boom"); });
  const after = queue(async () => ({ entries: [1] }));
  assert.deepEqual(await slow, { removed: [] });
  assert.deepEqual(await fast, { entries: [] });
  await assert.rejects(failing, /boom/);
  assert.deepEqual(await after, { entries: [1] });
  assert.deepEqual(order, ["reclaim", "inventory"]);
});

test("an installed launcher that never opened the evolution registry keeps its online runtime", async t => {
  const f = await fixture(t);
  // A chat-only installation of the other channel: a launcher on disk, no builds, no state.json, no snapshots.
  const launcherRoot = join(f.root, "Programs", "Cleo");
  const resources = join(launcherRoot, target.resources);
  await mkdir(resources, { recursive: true });
  await writeFile(join(launcherRoot, target.executable), "exe");
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify({ schema: 1, plan: "stable-0.9.0" }));
  await writeFile(join(target.platform === "darwin" ? resources : launcherRoot, "release.json"), JSON.stringify({ app: "Cleo", version: "0.9.0" }));
  const runtime = await f.addOnlineRuntime(await planKey(resources), "0.9.0");
  const orphan = await f.addOnlineRuntime(hex(64), "0.8.0", { completed: false });
  const missing = join(f.root, "Programs", "Cleo Alpha", target.executable);

  const result = await f.inventory({ installedExecutables: [join(launcherRoot, target.executable), missing] });
  const find = path => result.entries.find(e => e.path === path);
  assert.equal(find(runtime).action, "keep");
  assert.match(find(runtime).reason, /已安装的 Cleo 0\.9\.0/);
  assert.equal(find(orphan).action, "reclaim");
  // Completed runtimes without a known launcher remain protected, but cannot name their owner.
  assert.match((await f.inventory()).entries.find(e => e.path === runtime).reason, /无法确认无人使用/);
});

test("default launcher locations cover both channels on every platform", () => {
  assert.deepEqual(defaultLauncherPaths("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }),
    ["C:\\Users\\u\\AppData\\Local\\Programs\\Cleo\\Cleo.exe"]);
  assert.deepEqual(defaultLauncherPaths("win32", {}), []);
  const mac = defaultLauncherPaths("darwin", { HOME: "/Users/u" });
  assert.ok(mac.includes(posix.join("/Applications", "Cleo.app", "Contents", "MacOS", "Cleo")));
  assert.ok(mac.includes(posix.join("/Users/u/Applications", "Cleo Alpha.app", "Contents", "MacOS", "Cleo")));
  assert.ok(defaultLauncherPaths("linux", {}).some(path => path.includes("Cleo Alpha")));
});

test("a registered custom installation without evolution state keeps its shared runtime", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const launcherRoot = join(f.root, "custom-install", target.bundle);
  const resources = join(launcherRoot, target.resources);
  await mkdir(resources, { recursive: true });
  await writeFile(join(launcherRoot, target.executable), "exe");
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify({ schema: 1, plan: "custom-stable" }));
  const runtime = await f.addOnlineRuntime(await planKey(resources), "0.9.0");
  const orphan = await f.addOnlineRuntime(hex(64), "0.8.0", { completed: false });
  const installedExecutables = () => installedLauncherPaths({
    environment: { SystemRoot: process.env.SystemRoot, LOCALAPPDATA: join(f.root, "local-appdata") },
    execute: async () => ({ stdout: JSON.stringify([launcherRoot]) }),
  });
  const result = await f.inventory({ installedExecutables });
  assert.equal(result.entries.find(entry => entry.path === runtime).action, "keep");
  await reclaimStorage({ dataHome: f.dataHome, store: f.store, installedExecutables });
  assert.equal(await exists(runtime), true);
  assert.equal(await exists(orphan), false);
});

test("legacy script installations outside discoverable locations keep completed shared runtimes", async t => {
  const f = await fixture(t);
  const launcherRoot = join(f.root, "legacy-custom-install", target.bundle);
  const resources = join(launcherRoot, target.resources);
  await mkdir(resources, { recursive: true });
  await writeFile(join(launcherRoot, target.executable), "exe");
  await writeFile(join(resources, "runtime-plan.json"), JSON.stringify({ schema: 1, plan: "legacy-custom" }));
  // download.ps1 -InstallRoot records installation metadata locally, without an Inno registration.
  await writeFile(join(launcherRoot, "install.json"), JSON.stringify({ schema_version: 1, app: "Cleo", version: "0.9.0",
    installed_at: new Date().toISOString(), sha256: hex(64) }));
  const runtime = await f.addOnlineRuntime(await planKey(resources), "0.9.0");
  const alphaHome = join(f.root, "alpha-home");
  const store = new EvolutionStore(join(f.root, "alpha-control"), alphaHome);
  const options = { dataHome: alphaHome, store, onlineRoots: [f.online], installedExecutables: async () => [] };
  const inventory = await storageInventory(options);
  assert.equal(inventory.entries.find(entry => entry.path === runtime).action, "keep");
  for (const manual of [false, true]) {
    const result = await reclaimStorage(options, { manual });
    assert.equal(result.removed.length, 0);
    assert.equal(await exists(runtime), true);
    assert.equal(await exists(join(launcherRoot, target.executable)), true);
  }
});

test("Windows launcher discovery reads the installer's fixed AppId and both path values", async () => {
  const installer = await nativeFs.readFile(new URL("../../scripts/installers/windows.iss", import.meta.url), "utf8");
  const appId = /^AppId=\{(.+)$/m.exec(installer)[1].trim();
  const key = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`;
  const environment = { SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const custom = "D:\\Custom Apps\\Cleo";
  const other = "E:\\Other Cleo";
  const paths = await installedLauncherPaths({ platform: "win32", environment, execute: async (executable, args, options) => {
    assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(options.windowsHide, true);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.ok(script.includes(`OpenSubKey('${key}')`));
    assert.ok(script.includes("'InstallLocation', 'Inno Setup: App Path'"));
    return { stdout: `\uFEFF${JSON.stringify([custom + "\\", other, custom])}` };
  } });
  assert.deepEqual(paths, [...defaultLauncherPaths("win32", environment), win32.join(custom, "Cleo.exe"), win32.join(other, "Cleo.exe")]);
  assert.deepEqual(await installedLauncherPaths({ platform: "win32", environment, execute: async () => ({ stdout: "[]" }) }),
    defaultLauncherPaths("win32", environment));
  assert.deepEqual(await installedLauncherPaths({ platform: "linux", environment: {}, execute: () => { throw new Error("must not query Windows"); } }),
    defaultLauncherPaths("linux", {}));
});

test("unreadable or malformed installer ownership aborts cleanup before deletion", async t => {
  const f = await fixture(t);
  const orphan = await f.addOnlineRuntime(hex(64), "0.8.0", { completed: false });
  const denied = new Error("registry access denied");
  const environment = { SystemRoot: "C:\\Windows" };
  const installedExecutables = () => installedLauncherPaths({ platform: "win32", environment,
    execute: async () => { throw denied; } });
  await assert.rejects(reclaimStorage({ dataHome: f.dataHome, store: f.store, installedExecutables }), error => error === denied);
  assert.equal(await exists(orphan), true);
  assert.equal((await f.store.read()).storageCleanupPending, undefined);
  await assert.rejects(installedLauncherPaths({ platform: "win32", environment,
    execute: async () => ({ stdout: "invalid JSON" }) }), SyntaxError);
  for (const value of [null, {}, ["relative\\Cleo"], [42]]) {
    await assert.rejects(installedLauncherPaths({ platform: "win32", environment,
      execute: async () => ({ stdout: JSON.stringify(value) }) }), /invalid installation path/);
  }
});

test("native Windows registry discovery reads custom paths and missing registration", { skip: process.platform !== "win32" }, async t => {
  const execute = promisify(execFile);
  const powershell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const key = `SOFTWARE\\CleoStorageTests-${randomUUID()}`;
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const run = script => execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, "utf16le").toString("base64")], { windowsHide: true });
  const remove = () => run(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)}, $false)`);
  t.after(remove);
  const custom = "D:\\Custom Apps\\Cleo 测试's";
  const discover = () => installedLauncherPaths({ execute: (executable, args, options) => {
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le").replace(
      /SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\{[^}]+\}_is1/g, key);
    return execute(executable, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], options);
  } });
  const setPath = name => run(`$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(key)}); try { $key.SetValue(${quote(name)}, ${quote(custom + "\\")}) } finally { $key.Dispose() }`);
  await setPath("InstallLocation");
  assert.ok((await discover()).includes(win32.join(custom, "Cleo.exe")));
  await remove();
  await setPath("Inno Setup: App Path");
  assert.ok((await discover()).includes(win32.join(custom, "Cleo.exe")));
  await remove();
  assert.deepEqual(await discover(), defaultLauncherPaths());
  await run(`$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(key)}); $key.Dispose()`);
  await assert.rejects(discover(), /no installation path/);
});
