import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { desktopPlatform } from "../electron/platform.mjs";
import { EvolutionStore, exists, writeJson } from "../electron/evolution-store.mjs";
import { refreshInstalledLauncher, updateWindowsUninstallEntry, WINDOWS_INSTALLER_APP_ID, MAX_REFRESH_ATTEMPTS } from "../electron/launcher-refresh.mjs";

const target = desktopPlatform();
const key = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Purpose: Build a registry with an active official build and an older installed launcher outside it.
 * Input: test context. Output: store, launcher paths, the running executable and a refresh helper with test seams.
 */
async function fixture(t, { launcherVersion = "0.7.0", activeVersion = "0.9.0", activeKind = "official" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cleo-launcher-refresh-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const store = new EvolutionStore(join(root, "profile", "evolution"), join(root, "home"));
  await mkdir(join(store.dataHome, "data"), { recursive: true });
  await writeFile(join(store.dataHome, "data", "chat.txt"), "user data");
  const metadata = (version) => ({ schema_version: 1, app: "Cleo", version, platform: target.id, evolution_protocol: 2, build_kind: "official" });
  const writeBundle = async (bundle, version, label) => {
    const resources = join(bundle, target.resources);
    await mkdir(dirname(join(bundle, target.executable)), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(join(bundle, target.executable), `${label} executable ${version}`);
    await writeFile(join(resources, "app.asar"), `${label} archive ${version}`);
    await writeFile(join(resources, "cleo.ico"), `${label} icon ${version}`);
    await writeFile(join(bundle, "LICENSE"), `${label} license`);
    await writeJson(join(target.platform === "darwin" ? resources : bundle, "release.json"), metadata(version));
  };
  const builds = [];
  const add = async (id, version, kind = "official") => {
    const bundle = join(store.root, "builds", id, target.bundle);
    await writeBundle(bundle, version, id);
    builds.push({ id, kind, version, baseTag: `v${version}`, executable: `${target.bundle}/${target.executable}`, createdAt: new Date().toISOString() });
    return join(bundle, target.executable);
  };
  const baseline = await add("baseline-" + randomUUID(), "0.7.0");
  const active = await add("official-" + randomUUID(), activeVersion, activeKind);
  const installRoot = join(root, "Programs", target.bundle);
  await writeBundle(installRoot, launcherVersion, "installed");
  await writeFile(join(installRoot, "unins000.exe"), "inno uninstaller");
  await writeFile(join(installRoot, "unins000.dat"), "inno uninstall log");
  await writeFile(join(installRoot, "obsolete.txt"), "stale file from the old launcher");
  const launcher = join(installRoot, target.executable);
  await store.update({ active: builds[1].id, baseline: builds[0].id, builds, prepared: false,
    installedReleases: { [key(launcher)]: launcherVersion } });
  const registry = [];
  const refresh = (overrides = {}) => refreshInstalledLauncher({
    store, executable: active, registry: async (dir, version) => { registry.push({ root: key(dir), version }); return ["HKCU:\\test"]; },
    inUse: async () => false, launchers: [], ...overrides,
  });
  return { root, store, builds, baseline, active, installRoot, launcher, refresh, registry };
}

test("a healthy official activation replaces the installed launcher with the running build", async (t) => {
  const { store, builds, active, installRoot, launcher, refresh, registry } = await fixture(t);
  const result = await refresh();
  assert.equal(result.status, "done");
  assert.equal(result.results[key(launcher)].status, "refreshed");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`, "the launcher now carries the new build's executable (icon and version resources included)");
  assert.equal(await readFile(join(installRoot, target.resources, "app.asar"), "utf8"), `${builds[1].id} archive 0.9.0`);
  assert.equal(await readFile(join(installRoot, target.resources, "cleo.ico"), "utf8"), `${builds[1].id} icon 0.9.0`);
  assert.equal(JSON.parse(await readFile(join(target.platform === "darwin" ? join(installRoot, target.resources) : installRoot, "release.json"), "utf8")).version, "0.9.0");
  assert.equal(await readFile(join(installRoot, "unins000.exe"), "utf8"), "inno uninstaller", "the Inno uninstaller survives the swap");
  assert.equal(await readFile(join(installRoot, "unins000.dat"), "utf8"), "inno uninstall log");
  assert.equal(await exists(join(installRoot, "obsolete.txt")), false, "files that are not part of the build are not carried over");
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle], "no staging or retired copies remain beside the launcher");
  assert.deepEqual(registry, [{ root: key(installRoot), version: "0.9.0" }], "the uninstall entry shows the new version");
  const state = await store.read();
  assert.equal(state.installedReleases[key(launcher)], "0.9.0");
  assert.deepEqual(state.launcherRefresh, {});
  assert.equal(state.installedLauncher.version, "0.9.0");
  assert.equal(state.installedLauncher.build, builds[1].id);
  assert.deepEqual(state.launcherCleanupPending, []);
  assert.equal(await readFile(active, "utf8"), `${builds[1].id} executable 0.9.0`, "the running build is untouched");
  assert.equal(await readFile(join(store.dataHome, "data", "chat.txt"), "utf8"), "user data");
  // Idempotent: the next healthy startup finds the launcher current and copies nothing.
  await writeFile(join(installRoot, "sentinel.txt"), "unchanged launcher");
  assert.equal((await refresh()).results[key(launcher)].status, "current");
  assert.equal(await readFile(join(installRoot, "sentinel.txt"), "utf8"), "unchanged launcher");
  assert.equal(registry.length, 1);
});

test("a locked launcher is journaled, left intact, and refreshed on the next healthy startup", async (t) => {
  const { store, builds, installRoot, launcher, refresh, registry } = await fixture(t);
  let locked = true;
  const filesystem = { ...fs, rename: async (from, to) => {
    if (locked && key(from) === key(installRoot)) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return fs.rename(from, to);
  } };
  const first = await refresh({ filesystem });
  assert.equal(first.results[key(launcher)].status, "deferred");
  assert.match(first.results[key(launcher)].error, /EPERM/);
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0", "a locked launcher is never half-replaced");
  assert.equal(await readFile(join(installRoot, "obsolete.txt"), "utf8"), "stale file from the old launcher");
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle], "the staged copy is removed after a failed swap");
  let state = await store.read();
  assert.equal(state.launcherRefresh[key(launcher)].phase, "failed");
  assert.equal(state.launcherRefresh[key(launcher)].build, builds[1].id);
  assert.equal(state.launcherRefresh[key(launcher)].attempts, 1);
  assert.match(state.launcherRefresh[key(launcher)].error, /EPERM/);
  assert.equal(state.installedReleases[key(launcher)], "0.7.0", "bookkeeping still describes the old launcher");
  assert.equal(registry.length, 0);

  // A launcher whose image is still mapped by a process is not touched either.
  const running = await refresh({ inUse: async () => true });
  assert.equal(running.results[key(launcher)].status, "deferred");
  assert.match(running.results[key(launcher)].error, /still running/);
  assert.equal((await store.read()).launcherRefresh[key(launcher)].attempts, 2);
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0");

  locked = false;
  const second = await refresh({ filesystem });
  assert.equal(second.results[key(launcher)].status, "refreshed");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`);
  state = await store.read();
  assert.deepEqual(state.launcherRefresh, {});
  assert.equal(state.installedReleases[key(launcher)], "0.9.0");
  assert.deepEqual(registry, [{ root: key(installRoot), version: "0.9.0" }]);
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle]);
});

test("repeated lock failures stop retrying until a different build is activated", async (t) => {
  const { store, builds, launcher, refresh } = await fixture(t);
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
    assert.equal((await refresh({ inUse: async () => true })).results[key(launcher)].status, "deferred");
    assert.equal((await store.read()).launcherRefresh[key(launcher)].attempts, attempt);
  }
  const exhausted = await refresh({ inUse: async () => true });
  assert.equal(exhausted.results[key(launcher)].reason, "attempts-exhausted");
  assert.equal((await store.read()).launcherRefresh[key(launcher)].attempts, MAX_REFRESH_ATTEMPTS);
  const state = await store.read();
  const newer = { ...builds[1], id: "official-" + randomUUID(), version: "0.9.1" };
  const bundle = join(store.root, "builds", newer.id, target.bundle);
  await mkdir(dirname(join(bundle, target.executable)), { recursive: true });
  await mkdir(join(bundle, target.resources), { recursive: true });
  await writeFile(join(bundle, target.executable), "newer executable");
  await writeJson(join(target.platform === "darwin" ? join(bundle, target.resources) : bundle, "release.json"),
    { app: "Cleo", version: "0.9.1", platform: target.id });
  await store.update({ active: newer.id, builds: [...state.builds, newer] });
  const result = await refresh({ executable: join(bundle, target.executable) });
  assert.equal(result.results[key(launcher)].status, "refreshed", "a new activation starts a fresh attempt budget");
  assert.equal(await readFile(launcher, "utf8"), "newer executable");
});

test("an interrupted swap is completed before bookkeeping and leftovers are cleaned", async (t) => {
  const { store, builds, installRoot, launcher, refresh, registry } = await fixture(t);
  // Simulate a crash after the old launcher was moved aside and the new copy was moved in, but before cleanup.
  const id = randomUUID();
  const retired = `${installRoot}.retired-${id}`;
  await fs.rename(installRoot, retired);
  await fs.cp(join(store.root, "builds", builds[1].id, target.bundle), installRoot, { recursive: true });
  await store.update({ launcherRefresh: { [key(launcher)]: { id, path: key(launcher), root: installRoot, build: builds[1].id, version: "0.9.0",
    attempts: 1, staging: `${installRoot}.refresh-${id}`, retired, phase: "cleaning", startedAt: new Date().toISOString(), error: null, leftovers: [] } } });
  const result = await refresh();
  assert.equal(result.results[key(launcher)].status, "recorded");
  assert.equal(await exists(retired), false, "the retired launcher copy is removed");
  const state = await store.read();
  assert.equal(state.installedReleases[key(launcher)], "0.9.0");
  assert.deepEqual(state.launcherRefresh, {});
  assert.deepEqual(registry, [{ root: key(installRoot), version: "0.9.0" }]);

  // A crash between the two renames leaves no launcher directory: the staged copy is moved into place.
  const again = randomUUID();
  const staging = `${installRoot}.refresh-${again}`;
  await fs.rename(installRoot, staging);
  await store.update({ installedReleases: { [key(launcher)]: "0.7.0" }, launcherRefresh: { [key(launcher)]: { id: again, path: key(launcher), root: installRoot,
    build: builds[1].id, version: "0.9.0", attempts: 1, staging, retired: `${installRoot}.retired-${again}`, phase: "replacing",
    startedAt: new Date().toISOString(), error: null, leftovers: [] } } });
  assert.equal((await refresh()).results[key(launcher)].status, "recorded");
  assert.equal(await exists(launcher), true);
  assert.equal(await exists(staging), false);
});

test("the running program is left alone when it is the installed launcher itself", async (t) => {
  const { store, launcher, installRoot, refresh, registry } = await fixture(t);
  const before = await readFile(store.statePath, "utf8");
  const result = await refresh({ executable: launcher });
  assert.deepEqual(result, { status: "skipped", reason: "launcher-running" });
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0");
  assert.equal(await readFile(join(installRoot, "obsolete.txt"), "utf8"), "stale file from the old launcher");
  assert.equal(await readFile(store.statePath, "utf8"), before, "no journal or bookkeeping is written");
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle]);
  assert.equal(registry.length, 0);
});

test("local builds, pending transactions and foreign layouts never rewrite an installation", async (t) => {
  const { store, builds, active, launcher, installRoot, refresh, root } = await fixture(t, { activeKind: "local" });
  assert.equal((await refresh()).reason, "no-official-build");
  await store.update({ builds: builds.map((build) => ({ ...build, kind: "official" })) });
  await store.update({ transaction: { id: "pending", phase: "starting" } });
  assert.equal((await refresh()).reason, "no-official-build");
  await store.update({ transaction: null });
  // A running build that is not the active one cannot be trusted as the source.
  assert.equal((await refresh({ executable: join(store.root, "builds", builds[0].id, target.bundle, target.executable) })).reason, "inactive-program");
  // A recorded path that is not a Cleo bundle layout, or that lives inside the evolution registry, is skipped.
  const foreign = join(root, "Other", "tool.exe");
  await mkdir(dirname(foreign), { recursive: true });
  await writeFile(foreign, "unrelated program");
  const managed = join(store.root, "builds", builds[0].id, target.bundle, target.executable);
  await store.update({ installedReleases: { [key(foreign)]: "0.1.0", [key(managed)]: "0.7.0", [key(join(root, "gone", target.bundle, target.executable))]: "0.7.0" } });
  const result = await refresh({ executable: active });
  assert.equal(result.status, "done");
  assert.equal(result.results[key(foreign)].reason, "not-a-cleo-layout");
  assert.equal(result.results[key(managed)].reason, "managed-program");
  assert.equal(result.results[key(join(root, "gone", target.bundle, target.executable))].reason, "missing");
  assert.equal(await readFile(foreign, "utf8"), "unrelated program");
  assert.equal(await readFile(managed, "utf8"), `${builds[0].id} executable 0.7.0`);
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0", "an unrecorded launcher is not guessed at without an installer default");
  assert.equal(await exists(join(installRoot, "obsolete.txt")), true);
});

test("an unrecorded default launcher is adopted from its release metadata and refreshed only when stale", async (t) => {
  const { store, builds, launcher, installRoot, refresh } = await fixture(t);
  await store.update({ installedReleases: {} });
  // Already at the running version: only bookkeeping is recorded, nothing is copied.
  await writeJson(join(target.platform === "darwin" ? join(installRoot, target.resources) : installRoot, "release.json"),
    { app: "Cleo", version: "0.9.0", platform: target.id });
  assert.equal((await refresh({ launchers: [launcher] })).results[key(launcher)].status, "recorded");
  assert.equal((await store.read()).installedReleases[key(launcher)], "0.9.0");
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0");
  // Stale metadata: the launcher is replaced like a recorded one.
  await writeJson(join(target.platform === "darwin" ? join(installRoot, target.resources) : installRoot, "release.json"),
    { app: "Cleo", version: "0.7.0", platform: target.id });
  assert.equal((await refresh({ launchers: [launcher] })).results[key(launcher)].status, "refreshed");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`);
  // A default location without Cleo metadata is never touched.
  await store.update({ installedReleases: {} });
  const stranger = join(dirname(installRoot), "Stranger", target.bundle);
  await mkdir(dirname(join(stranger, target.executable)), { recursive: true });
  await writeFile(join(stranger, target.executable), "someone else's Cleo.exe");
  const result = await refresh({ launchers: [join(stranger, target.executable)] });
  assert.deepEqual(result.results[key(join(stranger, target.executable))], { status: "skipped", reason: "unidentified" });
  assert.equal(await readFile(join(stranger, target.executable), "utf8"), "someone else's Cleo.exe");
  // The installer default is also consulted alongside recorded launchers, and both are kept current.
  await writeJson(join(target.platform === "darwin" ? join(installRoot, target.resources) : installRoot, "release.json"),
    { app: "Cleo", version: "0.7.0", platform: target.id });
  const second = join(dirname(installRoot), "Second", target.bundle);
  await mkdir(dirname(join(second, target.executable)), { recursive: true });
  await writeFile(join(second, target.executable), "second launcher");
  await store.update({ installedReleases: { [key(join(second, target.executable))]: "0.7.0" } });
  const both = await refresh({ launchers: [launcher] });
  assert.equal(both.results[key(launcher)].status, "refreshed");
  assert.equal(both.results[key(join(second, target.executable))].status, "refreshed");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`);
  assert.equal(await readFile(join(second, target.executable), "utf8"), `${builds[1].id} executable 0.9.0`);
  assert.deepEqual(Object.keys((await store.read()).installedReleases).sort(), [key(launcher), key(join(second, target.executable))].sort());
});

test("a launcher directory that holds the data home or the registry is never swapped or deleted", async (t) => {
  const { store, root, builds, launcher, installRoot, refresh, active } = await fixture(t);
  const before = async () => [await readFile(launcher, "utf8"), await readFile(join(installRoot, "obsolete.txt"), "utf8")];
  // CLEO_HOME inside Programs\Cleo: the whole session store would travel with the retired directory.
  const inside = new EvolutionStore(store.root, join(installRoot, "home"));
  await mkdir(join(inside.dataHome, "data"), { recursive: true });
  await writeFile(join(inside.dataHome, "data", "sessions.jsonl"), "irreplaceable");
  const refused = await refreshInstalledLauncher({ store: inside, executable: active, launchers: [], inUse: async () => false, registry: async () => assert.fail("no registry change") });
  assert.equal(refused.results[key(launcher)].reason, "contains-user-data");
  assert.deepEqual(await before(), ["installed executable 0.7.0", "stale file from the old launcher"]);
  assert.equal(await readFile(join(inside.dataHome, "data", "sessions.jsonl"), "utf8"), "irreplaceable");
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle]);
  assert.equal((await inside.read()).launcherRefresh, undefined, "a refused refresh is not journaled for retry");
  // The install root inside the data home is refused the same way.
  const enclosing = new EvolutionStore(store.root, dirname(installRoot));
  assert.equal((await refreshInstalledLauncher({ store: enclosing, executable: active, launchers: [], inUse: async () => false })).results[key(launcher)].reason, "contains-user-data");
  assert.deepEqual(await before(), ["installed executable 0.7.0", "stale file from the old launcher"]);
  // A data entry linked into the install root is detected through its real path.
  const linked = new EvolutionStore(store.root, join(root, "linked-home"));
  await mkdir(linked.dataHome, { recursive: true });
  await mkdir(join(installRoot, "memory-store"));
  await writeFile(join(installRoot, "memory-store", "MEMORY.md"), "long-term memory");
  let linkable = true;
  try { await symlink(join(installRoot, "memory-store"), join(linked.dataHome, "memory"), "junction"); }
  catch { linkable = false; }
  if (linkable) {
    assert.equal((await refreshInstalledLauncher({ store: linked, executable: active, launchers: [], inUse: async () => false })).results[key(launcher)].reason, "contains-user-data");
    assert.equal(await readFile(join(installRoot, "memory-store", "MEMORY.md"), "utf8"), "long-term memory");
    await rm(join(linked.dataHome, "memory"), { recursive: true, force: true });
  }
  await rm(join(installRoot, "memory-store"), { recursive: true, force: true });
  // With the data elsewhere the same launcher refreshes normally.
  assert.equal((await refresh()).results[key(launcher)].status, "refreshed");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`);
});

test("an alpha program never replaces the stable entry point, and channels must match", async (t) => {
  const { store, builds, launcher, installRoot, refresh, registry } = await fixture(t, { activeVersion: "0.9.0-alpha" });
  // The recorded stable launcher is left alone and the default location is not even considered.
  const alpha = await refresh({ launchers: [launcher] });
  assert.equal(alpha.results[key(launcher)].reason, "channel-mismatch");
  assert.equal(alpha.results[key(launcher)].launcherChannel, "stable");
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0");
  assert.equal(await exists(join(installRoot, "obsolete.txt")), true);
  assert.equal(registry.length, 0);
  await store.update({ installedReleases: {} });
  assert.deepEqual((await refresh({ launchers: [launcher] })).results, {}, "the installer default is only a stable candidate");
  // An alpha launcher recorded for the alpha channel is refreshed by the alpha program.
  const alphaRoot = join(dirname(installRoot), "Cleo Alpha", target.bundle);
  await mkdir(dirname(join(alphaRoot, target.executable)), { recursive: true });
  await writeFile(join(alphaRoot, target.executable), "installed alpha 0.8.0-alpha");
  await writeJson(join(target.platform === "darwin" ? join(alphaRoot, target.resources) : alphaRoot, "release.json"),
    { app: "Cleo", version: "0.8.0-alpha", platform: target.id });
  const alphaLauncher = join(alphaRoot, target.executable);
  await store.update({ installedReleases: { [key(alphaLauncher)]: "0.8.0-alpha", [key(launcher)]: "0.7.0" } });
  const result = await refresh({ launchers: [launcher] });
  assert.equal(result.results[key(alphaLauncher)].status, "refreshed");
  assert.equal(result.results[key(launcher)].reason, "channel-mismatch");
  assert.equal(await readFile(alphaLauncher, "utf8"), `${builds[1].id} executable 0.9.0-alpha`);
  assert.equal(await readFile(launcher, "utf8"), "installed executable 0.7.0");
  // Conversely a stable program does not overwrite an alpha launcher.
  const stable = { ...builds[1], id: "official-" + randomUUID(), version: "0.9.0" };
  const bundle = join(store.root, "builds", stable.id, target.bundle);
  await mkdir(dirname(join(bundle, target.executable)), { recursive: true });
  await writeFile(join(bundle, target.executable), "stable executable");
  await store.update({ active: stable.id, builds: [...(await store.read()).builds, stable] });
  const back = await refresh({ executable: join(bundle, target.executable), launchers: [launcher] });
  assert.equal(back.results[key(alphaLauncher)].reason, "channel-mismatch");
  assert.equal(back.results[key(launcher)].status, "refreshed");
  assert.equal(await readFile(alphaLauncher, "utf8"), `${builds[1].id} executable 0.9.0-alpha`);
  assert.equal(await readFile(launcher, "utf8"), "stable executable");
});

test("a failed rollback leaves both copies in place and the entry point is restored on the next healthy startup", async (t) => {
  const { store, builds, launcher, installRoot, refresh } = await fixture(t);
  let promoteFails = true, rollbackFails = true;
  const filesystem = { ...fs, rename: async (from, to) => {
    const failing = key(to) === key(installRoot) && ((promoteFails && /\.refresh-/.test(from)) || (rollbackFails && /\.retired-/.test(from)));
    if (failing) throw Object.assign(new Error("EPERM: locked"), { code: "EPERM" });
    return fs.rename(from, to);
  } };
  const first = await refresh({ filesystem });
  assert.equal(first.results[key(launcher)].reason, "entry-point-missing");
  assert.equal(await exists(installRoot), false, "the swap was interrupted with the entry point missing");
  let state = await store.read();
  const entry = state.launcherRefresh[key(launcher)];
  assert.equal(entry.phase, "replacing");
  assert.match(entry.error, /rollback/);
  assert.equal(await exists(entry.staging), true, "the new copy is kept");
  assert.equal(await exists(entry.retired), true, "the old copy is kept");
  // Still locked on the next startup: nothing is deleted, the journal survives, and the attempt budget is not consumed.
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS + 1; attempt += 1) {
    const again = await refresh({ filesystem });
    assert.equal(again.results[key(launcher)].reason, "entry-point-missing");
  }
  assert.equal(await exists(entry.staging), true);
  assert.equal(await exists(entry.retired), true);
  assert.deepEqual((await store.read()).launcherRefresh[key(launcher)], entry);
  // Once the lock clears the staged program is promoted and bookkeeping completes.
  promoteFails = false;
  const restored = await refresh({ filesystem });
  assert.equal(restored.results[key(launcher)].status, "recorded");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`);
  assert.equal(await readFile(join(installRoot, "unins000.exe"), "utf8"), "inno uninstaller");
  state = await store.read();
  assert.deepEqual(state.launcherRefresh, {});
  assert.equal(state.installedReleases[key(launcher)], "0.9.0");
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle]);
  // When only the old copy survives, it is what comes back.
  const id = randomUUID();
  const retired = `${installRoot}.retired-${id}`;
  await fs.rename(installRoot, retired);
  await store.update({ launcherRefresh: { [key(launcher)]: { id, path: key(launcher), root: installRoot, build: builds[1].id, version: "0.9.0",
    attempts: 1, staging: `${installRoot}.refresh-${id}`, retired, phase: "failed", startedAt: new Date().toISOString(), error: "crash", leftovers: [] } } });
  assert.equal((await refresh()).results[key(launcher)].status, "recorded", "the stale journal is closed once the entry point is back");
  assert.equal(await readFile(launcher, "utf8"), `${builds[1].id} executable 0.9.0`);
  assert.deepEqual(await readdir(dirname(installRoot)), [target.bundle]);
  assert.deepEqual((await store.read()).launcherRefresh, {});
});

test("the hard-coded uninstall key matches the Windows installer's AppId", async () => {
  const iss = await readFile(new URL("../../scripts/installers/windows.iss", import.meta.url), "utf8");
  const appId = iss.match(/^AppId=\{(\{[0-9A-F-]+\})\s*$/mi)?.[1];
  assert.equal(appId, WINDOWS_INSTALLER_APP_ID);
  assert.match(iss, /^DefaultDirName=\{localappdata\}\\Programs\\Cleo\s*$/mi);
});

test("the Inno uninstall entry is located by its recorded App Path and shows the refreshed version", {
  skip: process.platform !== "win32", timeout: 60_000,
}, async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const hive = `HKCU:\\Software\\Cleo-test-${randomUUID()}\\Uninstall`;
  const installRoot = join(tmpdir(), `Cleo-test-${randomUUID()}`);
  const ps = (command) => run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text",
    "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 });
  t.after(async () => { await ps(`Remove-Item -LiteralPath '${dirname(hive)}' -Recurse -Force -ErrorAction SilentlyContinue`); });
  await ps([
    `New-Item -Path '${hive}\\${WINDOWS_INSTALLER_APP_ID}_is1' -Force | Out-Null`,
    `Set-ItemProperty -LiteralPath '${hive}\\${WINDOWS_INSTALLER_APP_ID}_is1' -Name 'Inno Setup: App Path' -Value '${installRoot}'`,
    `Set-ItemProperty -LiteralPath '${hive}\\${WINDOWS_INSTALLER_APP_ID}_is1' -Name 'DisplayVersion' -Value '0.7.0'`,
    `Set-ItemProperty -LiteralPath '${hive}\\${WINDOWS_INSTALLER_APP_ID}_is1' -Name 'VersionMajor' -Value 0 -Type DWord`,
    `Set-ItemProperty -LiteralPath '${hive}\\${WINDOWS_INSTALLER_APP_ID}_is1' -Name 'VersionMinor' -Value 7 -Type DWord`,
    `New-Item -Path '${hive}\\{OTHER}_is1' -Force | Out-Null`,
    `Set-ItemProperty -LiteralPath '${hive}\\{OTHER}_is1' -Name 'Inno Setup: App Path' -Value 'C:\\Elsewhere'`,
    `Set-ItemProperty -LiteralPath '${hive}\\{OTHER}_is1' -Name 'DisplayVersion' -Value '1.0.0'`,
  ].join("\n"));
  const updated = await updateWindowsUninstallEntry(installRoot, "0.9.0", { hives: [hive] });
  assert.equal(updated.length, 1);
  const { stdout } = await ps(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $a = Get-ItemProperty -LiteralPath '${hive}\\${WINDOWS_INSTALLER_APP_ID}_is1'; $b = Get-ItemProperty -LiteralPath '${hive}\\{OTHER}_is1'; [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ version = $a.DisplayVersion; major = $a.VersionMajor; minor = $a.VersionMinor; other = $b.DisplayVersion }))`);
  assert.deepEqual(JSON.parse(stdout.trim()), { version: "0.9.0", major: 0, minor: 9, other: "1.0.0" });
  assert.deepEqual(await updateWindowsUninstallEntry(join(tmpdir(), "nowhere"), "0.9.0", { hives: [hive], appId: "{MISSING}" }), [], "a missing entry is not an error");
});
