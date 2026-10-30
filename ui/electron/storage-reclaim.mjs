import { t as tr } from "./i18n.mjs";
import { createHash } from "node:crypto";
import * as nativeFs from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { desktopPlatform, installationRoot } from "./platform.mjs";
import { compareVersions } from "./updater.mjs";
import { readJson } from "./evolution-store.mjs";
import { runtimeInUse } from "./install-state.mjs";
import { parseRuntimeRegistry, RUNTIME_REGISTRY } from "./online-runtime.mjs";

/** Rebuildable package caches below this total are kept for faster reinstalls; above it they are reclaimed automatically. */
export const PACKAGE_CACHE_LIMIT = 512 * 1024 * 1024;
/** An installer scratch directory untouched for this long belongs to a crashed installation. */
export const STALE_INSTALL_MS = 24 * 60 * 60 * 1000;

const NAMESPACE = /^[a-f0-9]{24}$/;
const SNAPSHOT = /^[a-f0-9]{32}$/;
const PLAN_KEY = /^[a-f0-9]{64}$/;
const BUILD = /^(baseline|local|official)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP = /^apply-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_NAMES = ["pip-cache", "npm-cache", "downloads"];
/** Real session, memory, model and configuration data; never a cleanup candidate. */
export const USER_DATA_ENTRIES = ["memory", "data", "models", "config", "skills", "PERSONA.md", "AGENTS.md", "setup"];

function filesystem() {
  return process.versions.electron ? createRequire(import.meta.url)("original-fs").promises : nativeFs;
}

/** Input: path that may be missing. Output: lstat result or null for ENOENT/ENOTDIR. */
async function probe(fs, path) {
  try { return await fs.lstat(path); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

async function listDirectory(fs, path) {
  try { return (await fs.readdir(path)).sort(); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return [];
    throw error;
  }
}

/** Purpose: Approximate recursive file size without following links. Input: path. Output: bytes (0 when missing). */
export async function directorySize(path, { fs = filesystem(), signal } = {}) {
  const info = await probe(fs, path);
  if (!info) return 0;
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let total = 0;
  const stack = [path];
  while (stack.length) {
    signal?.throwIfAborted();
    const directory = stack.pop();
    let names;
    try { names = await fs.readdir(directory); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) continue;
      throw error;
    }
    for (const name of names) {
      const entry = join(directory, name);
      let stat;
      try { stat = await fs.lstat(entry); }
      catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) continue;
        throw error;
      }
      if (stat.isDirectory()) stack.push(entry);
      else if (stat.isFile()) total += stat.size;
    }
  }
  return total;
}

/** The dependency updater keys its runtime namespace by the application's resources path. */
export function namespaceKey(resourcesPath) {
  return createHash("sha256").update(resolve(resourcesPath)).digest("hex").slice(0, 24);
}

/** The dependency updater nests snapshots under a digest of the application version. */
export function versionKey(version) {
  return createHash("sha256").update(String(version)).digest("hex").slice(0, 24);
}

/** The online installer keys its shared runtime by the digest of the bundled runtime plan. */
export async function planKey(resourcesPath, fs = filesystem()) {
  try { return createHash("sha256").update(await fs.readFile(join(resourcesPath, "runtime-plan.json"))).digest("hex"); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
}

/** Input: a venv's pyvenv.cfg text. Output: its `home` interpreter directory, or null. */
export function venvHome(text) {
  const match = /^\s*home\s*=\s*(.+?)\s*$/m.exec(text);
  return match ? match[1] : null;
}

function within(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Input: path. Output: its real location, or null when it is missing or unreadable. */
async function realLocation(fs, path) {
  try { return await fs.realpath(path); }
  catch { return null; }
}

/** Input: directory. Output: true when it is a symbolic link or junction, or does not exist as a directory. */
async function linkedDirectory(fs, path) {
  const info = await probe(fs, path);
  return !info || !info.isDirectory() || info.isSymbolicLink();
}

/** Input: a runtimes root. Output: existing pyvenv homes of every snapshot under it (links skipped). */
async function snapshotHomes(fs, runtimesRoot) {
  const homes = [];
  if (await linkedDirectory(fs, runtimesRoot)) return homes;
  for (const name of await listDirectory(fs, runtimesRoot)) {
    const namespace = join(runtimesRoot, name);
    if (!NAMESPACE.test(name) || await linkedDirectory(fs, namespace)) continue;
    for (const version of await listDirectory(fs, namespace)) {
      if (!NAMESPACE.test(version)) continue;
      for (const snapshot of await listDirectory(fs, join(namespace, version))) {
        if (!SNAPSHOT.test(snapshot)) continue;
        try {
          const home = venvHome(await fs.readFile(join(namespace, version, snapshot, "python", "pyvenv.cfg"), "utf8"));
          if (home && await probe(fs, home)) homes.push(home);
        } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
      }
    }
  }
  return homes;
}

/** Purpose: Where the installers place a launcher, for either release channel, whether or not that
 * installation ever opened the evolution registry (a chat-only install has no builds or journal).
 * Input: platform and environment. Output: candidate executables; missing ones are ignored by the inventory.
 */
export function defaultLauncherPaths(platform = process.platform, environment = process.env) {
  if (platform === "win32") {
    // Both channels use the same Inno Setup AppId and directory.
    return environment.LOCALAPPDATA ? [win32.join(environment.LOCALAPPDATA, "Programs", "Cleo", "Cleo.exe")] : [];
  }
  const names = ["Cleo", "Cleo Alpha"];
  if (platform === "darwin") {
    const roots = ["/Applications", environment.HOME && posix.join(environment.HOME, "Applications")].filter(Boolean);
    return roots.flatMap(root => names.map(name => posix.join(root, `${name}.app`, "Contents", "MacOS", "Cleo")));
  }
  return names.flatMap(name => [posix.join("/opt", name, "Cleo"), posix.join("/usr/lib", name, "Cleo")]);
}

/** Purpose: Run inventory and reclaim requests one at a time, each resolving to its own result.
 * Input: none. Output: a function that queues an action behind the previous one.
 */
export function createStorageQueue() {
  let tail = Promise.resolve();
  return action => {
    const run = tail.then(action, action);
    tail = run.catch(() => {});
    return run;
  };
}

/** Purpose: Gather every program location whose runtimes must survive.
 * Input: evolution state, builds directory, current process, installed launchers. Output: resources paths with labels.
 */
async function liveResources({ fs, state, buildsRoot, target, currentResources, currentVersion, installedExecutables, siblings = [] }) {
  const references = new Map();
  /** A reference with no known version keeps every version of its namespace; `evidence` names how it was found. */
  const add = (path, label, version = null, evidence = "program-directory") => {
    if (!path) return;
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const entry = references.get(key) || { path: resolve(path), label, evidence, versions: new Set(), unknownVersion: false };
    if (version) entry.versions.add(String(version)); else entry.unknownVersion = true;
    references.set(key, entry);
  };
  if (currentResources) add(currentResources, tr("storage_reclaim.currently_running_cleo"), currentVersion, "current-program");
  const registered = new Map((state.builds || []).map(build => [build.id, build]));
  for (const id of await listDirectory(fs, buildsRoot)) {
    if (!BUILD.test(id)) continue;
    const build = registered.get(id);
    const pending = (state.cleanupPending || []).includes(id);
    const label = build ? `${build.kind === "official" ? tr("storage_reclaim.program") : tr("storage_reclaim.local_version")} ${build.version || build.name || id}`
      : tr("storage_reclaim.unregistered_program_directory_value", { p0: id });
    const resources = join(buildsRoot, id, target.bundle, target.resources);
    add(resources, pending ? tr("storage_reclaim.value_awaiting_retirement", { p0: label }) : label, build?.version || await bundleVersion(fs, resources, target),
      build ? "registered-build" : "program-directory");
  }
  for (const [executable, version] of Object.entries(state.installedReleases || {})) {
    try {
      const resources = join(installationRoot(executable, target), target.resources);
      // The launcher may have been upgraded in place since it was journaled; its bundle says which version runs now.
      add(resources, tr("storage_reclaim.installed_cleo_value", { p0: version }), await bundleVersion(fs, resources, target) || version, "installed-launcher");
    } catch { /* A foreign layout is not a runtime owner. */ }
  }
  for (const executable of installedExecutables || []) {
    try {
      // A launcher that never opened the evolution registry is still a program with a runtime.
      if (!await probe(fs, executable)) continue;
      const resources = join(installationRoot(executable, target), target.resources);
      const version = await bundleVersion(fs, resources, target);
      add(resources, version ? tr("storage_reclaim.installed_cleo_value", { p0: version }) : tr("storage_reclaim.installed_cleo"), version
        || (resolve(executable) === resolve(process.execPath) ? currentVersion : null), "installed-launcher");
    } catch { /* ignore */ }
  }
  // Another release channel (Cleo / Cleo Alpha) shares the online runtime root; its programs count too.
  for (const sibling of siblings) {
    const label = sibling.label || tr("storage_reclaim.cleo_from_another_channel");
    const siblingState = await readJson(join(sibling.controlRoot, "state.json"), {});
    const siblingBuilds = join(sibling.controlRoot, "builds");
    const registered = new Map((siblingState.builds || []).map(build => [build.id, build]));
    for (const id of await listDirectory(fs, siblingBuilds)) {
      if (!BUILD.test(id)) continue;
      const resources = join(siblingBuilds, id, target.bundle, target.resources);
      add(resources, tr("storage_reclaim.value_program_value", { p0: label, p1: registered.get(id)?.version || id }),
        registered.get(id)?.version || await bundleVersion(fs, resources, target), "sibling-channel");
    }
    for (const [executable, version] of Object.entries(siblingState.installedReleases || {})) {
      try {
        const resources = join(installationRoot(executable, target), target.resources);
        add(resources, tr("storage_reclaim.value_installed_value", { p0: label, p1: version }), await bundleVersion(fs, resources, target) || version, "sibling-channel");
      } catch { /* ignore */ }
    }
  }
  return [...references.values()];
}

/** Input: a bundle's resources path. Output: the version its release.json declares, or null. */
async function bundleVersion(fs, resources, target) {
  const path = join(target.platform === "darwin" ? resources : dirname(resources), "release.json");
  try {
    const version = JSON.parse(await fs.readFile(path, "utf8"))?.version;
    return typeof version === "string" && version ? version : null;
  } catch { return null; }
}

/** Purpose: Build an auditable inventory of Cleo-owned storage with a keep-or-reclaim decision per entry.
 * Input: data home, evolution store, current process locations and policy. Output: entries, totals and the reasons.
 * Unknown content is always kept; user data is listed for size only.
 */
export async function storageInventory({
  dataHome, store, currentResources = null, currentRuntimeNamespace = null, currentBaseResources = null,
  onlineRoots = [], installedExecutables = [], protectedVersions = [], currentVersion = null,
  siblings = [], downloadsBusy = () => false, cacheLimit = PACKAGE_CACHE_LIMIT, measure = "all",
  pruneOnlineRuntimes = false,
  target = desktopPlatform(), fs = filesystem(), signal, now = Date.now(),
} = {}) {
  dataHome = resolve(dataHome);
  const state = await store.read();
  const buildsRoot = join(store.root, "builds");
  const entries = [];
  const size = path => directorySize(path, { fs, signal });
  // Startup passes measure only what they remove; walking retained programs and user data is for the UI.
  const push = async entry => { entries.push({ ...entry, bytes: measure === "all" || entry.action === "reclaim" ? await size(entry.path) : 0 }); };
  const references = await liveResources({ fs, state, buildsRoot, target, currentResources, currentVersion, installedExecutables, siblings });
  const liveNamespaces = new Map();
  const owner = (key, item) => {
    const entry = liveNamespaces.get(key) || { label: item.label, versions: new Set(), unknownVersion: false };
    for (const version of item.versions) entry.versions.add(versionKey(version));
    entry.unknownVersion ||= item.unknownVersion;
    liveNamespaces.set(key, entry);
  };
  for (const item of references) owner(namespaceKey(item.path), item);
  if (currentRuntimeNamespace) {
    owner(basename(resolve(currentRuntimeNamespace)), { label: tr("storage_reclaim.currently_running_cleo"),
      versions: new Set(currentVersion ? [currentVersion] : []), unknownVersion: !currentVersion });
  }
  // Every program that provably still uses an online runtime, with the kind of evidence that found it.
  const livePlans = new Map();
  const planOwners = new Map();
  const claim = (key, label, evidence) => {
    if (!livePlans.has(key)) livePlans.set(key, label);
    const owners = planOwners.get(key) || [];
    if (!owners.some(owner => owner.label === label && owner.evidence === evidence)) owners.push({ label, evidence });
    planOwners.set(key, owners);
  };
  for (const item of references) {
    const key = await planKey(item.path, fs);
    if (key) claim(key, item.label, item.evidence);
  }
  if (currentBaseResources && PLAN_KEY.test(basename(resolve(currentBaseResources)))) {
    claim(basename(resolve(currentBaseResources)), tr("storage_reclaim.currently_running_cleo"), "current-program");
  }
  const userData = new Set(USER_DATA_ENTRIES.map(name => resolve(dataHome, name)));
  for (const path of [...userData]) {
    const real = await realLocation(fs, path);
    if (real) userData.add(real);
  }
  const runtimesRoot = join(dataHome, "runtimes");
  const onlineRootSet = [...new Set([join(runtimesRoot, "online"), ...onlineRoots.map(root => resolve(root))])];
  const protectHomes = (homes, reason) => {
    for (const home of homes) {
      for (const root of onlineRootSet) {
        if (!within(home, root)) continue;
        const key = relative(root, home).split(/[\\/]/)[0];
        if (PLAN_KEY.test(key)) claim(key, reason, "dependency-snapshot");
      }
    }
  };
  // The launch registry (#141): which program locations started with which runtime. A registered
  // location that still exists and still plans the same runtime is an owner; one that moved on to
  // another runtime or disappeared is evidence of retirement. A missing, unreadable or foreign
  // registry is no evidence either way.
  const retirementEvidence = new Map();
  for (const root of onlineRootSet) {
    if (await linkedDirectory(fs, root)) continue;
    let registry;
    try { registry = parseRuntimeRegistry(await fs.readFile(join(root, RUNTIME_REGISTRY), "utf8")); }
    catch { continue; }
    const evidence = (key, kind, detail) => retirementEvidence.set(key, [...(retirementEvidence.get(key) || []), { kind, detail }]);
    for (const [installation, entry] of Object.entries(registry.installations)) {
      const exists = (await probe(fs, installation))?.isDirectory();
      // Runtimes this location already left (journaled at the launch that switched away).
      for (const item of entry.history || []) {
        evidence(item.key, exists ? "installation-upgraded" : "installation-removed", exists
          ? tr("storage_reclaim.installation_now_uses_another_runtime_value", { p0: installation })
          : tr("storage_reclaim.installation_no_longer_exists_value", { p0: installation }));
      }
      if (!exists) {
        evidence(entry.key, "installation-removed", tr("storage_reclaim.installation_no_longer_exists_value", { p0: installation }));
        continue;
      }
      const planned = await planKey(installation, fs);
      if (planned === null || planned === entry.key) {
        claim(entry.key, tr("storage_reclaim.cleo_value_launched_from_value", { p0: entry.version || "", p1: installation }), "launch-registry");
      } else {
        evidence(entry.key, "installation-upgraded", tr("storage_reclaim.installation_now_uses_another_runtime_value", { p0: installation }));
      }
    }
  }
  for (const sibling of siblings) {
    if (sibling.dataHome) protectHomes(await snapshotHomes(fs, join(sibling.dataHome, "runtimes")), tr("storage_reclaim.dependency_snapshot_for_value", { p0: sibling.label || tr("storage_reclaim.cleo_from_another_channel") }));
  }
  // A linked runtimes directory could point anywhere, including at user data: never inventory through it.
  const runtimesLinked = await linkedDirectory(fs, runtimesRoot) && Boolean(await probe(fs, runtimesRoot));
  if (runtimesLinked) {
    entries.push({ id: "unknown:runtimes", kind: "unknown", path: runtimesRoot, bytes: 0, action: "keep", reason: tr("storage_reclaim.the_runtimes_directory_is_a_link_and_will_not_be_cleaned") });
  }

  // Dependency snapshots: one namespace per program location, each holding validated runtime copies.
  for (const name of runtimesLinked ? [] : await listDirectory(fs, runtimesRoot)) {
    const path = join(runtimesRoot, name);
    if (name === "online" || onlineRootSet.includes(path)) continue;
    const info = await probe(fs, path);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    if (!NAMESPACE.test(name)) { await push({ id: `unknown:${name}`, kind: "unknown", path, action: "keep", reason: tr("storage_reclaim.directory_origin_is_unknown_retaining_it_conservatively") }); continue; }
    const versions = [];
    for (const version of await listDirectory(fs, path)) {
      if (!NAMESPACE.test(version) || !(await probe(fs, join(path, version)))?.isDirectory()) continue;
      const homes = [];
      for (const snapshot of await listDirectory(fs, join(path, version))) {
        if (!SNAPSHOT.test(snapshot)) continue;
        try { homes.push(venvHome(await fs.readFile(join(path, version, snapshot, "python", "pyvenv.cfg"), "utf8"))); }
        catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; homes.push(null); }
      }
      const presentHomes = [];
      for (const home of homes) if (home && await probe(fs, home)) presentHomes.push(home);
      versions.push({ version, snapshots: homes.length, presentHomes });
    }
    // A kept snapshot keeps the online runtime it was derived from.
    const protectPlans = protectHomes;
    const owned = liveNamespaces.get(name);
    if (owned) {
      // One install location upgraded in place leaves the previous versions' snapshots behind.
      for (const item of versions) {
        const current = owned.unknownVersion || owned.versions.has(item.version);
        const reason = current ? tr("storage_reclaim.dependency_snapshot_for_value", { p0: owned.label }) : tr("storage_reclaim.dependency_snapshot_left_by_value_before_an_in_place_upgrade", { p0: owned.label });
        if (current) protectPlans(item.presentHomes, reason);
        await push({ id: `runtime-namespace:${name}/${item.version}`, kind: "runtime-namespace", path: join(path, item.version),
          snapshots: item.snapshots, policy: "automatic", action: current ? "keep" : "reclaim", reason });
      }
      continue;
    }
    const snapshots = versions.reduce((sum, item) => sum + item.snapshots, 0);
    const presentHomes = versions.flatMap(item => item.presentHomes);
    const entry = { id: `runtime-namespace:${name}`, kind: "runtime-namespace", path, snapshots, policy: "automatic" };
    if (presentHomes.length) Object.assign(entry, { action: "keep", reason: tr("storage_reclaim.the_associated_program_still_exists_at_value_but_is_not_registered_as_retained", { p0: dirname(presentHomes[0]) }) });
    else Object.assign(entry, { action: "reclaim", reason: snapshots ? tr("storage_reclaim.the_associated_program_was_deleted_and_no_one_uses_this_snapshot") : tr("storage_reclaim.empty_dependency_namespace") });
    if (entry.action === "keep") protectPlans(presentHomes, entry.reason);
    await push(entry);
  }

  // Shared online runtimes plus the installer's rebuildable caches.
  let installing = false;
  const caches = [];
  const onlineRuntimes = [];
  for (const root of onlineRootSet) {
    if (await linkedDirectory(fs, root)) {
      if (await probe(fs, root)) entries.push({ id: `unknown:online/${basename(root)}`, kind: "unknown", path: root, bytes: 0, action: "keep", reason: tr("storage_reclaim.the_runtime_directory_is_a_link_and_will_not_be_cleaned") });
      continue;
    }
    for (const name of await listDirectory(fs, root)) {
      // The launch registry (and its in-flight temporary) is bookkeeping, not storage to classify.
      if (name === RUNTIME_REGISTRY || name.startsWith(`${RUNTIME_REGISTRY}.`)) continue;
      const path = join(root, name);
      const info = await probe(fs, path);
      if (!info) continue;
      if (name.startsWith(".install-")) {
        const stale = now - info.mtimeMs > STALE_INSTALL_MS;
        if (!stale) installing = true;
        await push({ id: `install-scratch:${name}`, kind: "install-scratch", path, policy: "automatic",
          action: stale ? "reclaim" : "keep", reason: stale ? tr("storage_reclaim.temporary_directory_left_by_an_interrupted_installation") : tr("storage_reclaim.installation_in_progress") });
        continue;
      }
      if (CACHE_NAMES.includes(name)) { caches.push({ id: `package-cache:${name}`, kind: "package-cache", path }); continue; }
      if (!info.isDirectory() || info.isSymbolicLink() || !PLAN_KEY.test(name)) {
        await push({ id: `unknown:online/${name}`, kind: "unknown", path, action: "keep", reason: tr("storage_reclaim.directory_origin_is_unknown_retaining_it_conservatively") });
        continue;
      }
      let version = null;
      let completed = false;
      try {
        const ready = JSON.parse(await fs.readFile(join(path, "ready.json"), "utf8"));
        version = ready.version ?? null;
        completed = ready.key === name;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
      }
      const owner = livePlans.get(name);
      // Until an update is healthy, preserve completed legacy installs even without discoverable owners.
      onlineRuntimes.push({ id: `online-runtime:${name}`, kind: "online-runtime", path, version, completed, policy: "automatic",
        ownership: owner ? "in-use" : completed ? "unknown" : "retired",
        owners: planOwners.get(name) || [], evidence: retirementEvidence.get(name) || [],
        action: owner || completed ? "keep" : "reclaim",
        reason: owner ? tr("storage_reclaim.runtime_used_by_value", { p0: owner }) : completed ? tr("storage_reclaim.completed_runtime_legacy_installers_allow_custom_program_locations_so_it_cannot_be_co")
          : tr("storage_reclaim.incomplete_runtime_with_no_program_using_it") });
    }
  }
  const currentOnline = currentBaseResources && onlineRuntimes.find(entry =>
    resolve(entry.path) === resolve(currentBaseResources) && entry.completed && entry.version === currentVersion);
  const pruneOnline = pruneOnlineRuntimes && currentOnline && !state.transaction && !installing && !downloadsBusy()
    && currentResources && await planKey(currentResources, fs) === basename(currentOnline.path)
    && (await probe(fs, join(currentOnline.path, "python", target.platform === "win32" ? "python.exe" : "bin/python3")))?.isFile()
    && (await probe(fs, join(currentOnline.path, "browser", target.platform === "win32" ? "node.exe" : "node")))?.isFile();
  for (const { completed, ...entry } of onlineRuntimes) {
    // A successful update replaces old online environments, including legacy custom installs.
    // Newer staged releases survive until they themselves acknowledge a healthy startup.
    if (pruneOnline && entry.path !== currentOnline.path
        && dirname(entry.path) === dirname(currentOnline.path)) {
      // A failed recursive delete may already have removed ready.json.
      let superseded = !completed;
      try { if (completed) superseded = compareVersions(entry.version, currentVersion) <= 0; }
      catch { /* Unknown versions are not evidence of an older runtime. */ }
      if (superseded) Object.assign(entry, { action: "reclaim", ownership: "retired", reason: "更新已成功，只保留当前版本的在线运行环境" });
      // A newer or unversioned runtime nobody provably uses is retired only when the registry shows
      // every installation that launched with it has upgraded or is gone (#141).
      else if (entry.ownership === "unknown" && entry.evidence.length) {
        Object.assign(entry, { action: "reclaim", ownership: "retired", reason: tr(
          "storage_reclaim.retired_every_installation_registered_to_it_moved_on_value",
          { p0: entry.evidence.map(item => item.detail).join("; ") }) });
      }
    }
    await push(entry);
  }
  for (const cache of caches) {
    entries.push({ ...cache, bytes: await size(cache.path) });
  }
  const cacheBytes = caches.reduce((sum, cache) => sum + (entries.find(entry => entry.id === cache.id)?.bytes || 0), 0);
  for (const entry of entries) {
    if (entry.kind !== "package-cache") continue;
    if (installing) Object.assign(entry, { action: "keep", policy: "manual", reason: tr("storage_reclaim.installation_in_progress_download_cache_will_not_be_cleaned_yet") });
    else Object.assign(entry, { action: "reclaim", policy: cacheBytes > cacheLimit ? "automatic" : "manual",
      reason: cacheBytes > cacheLimit ? tr("storage_reclaim.rebuildable_download_cache_exceeds_its_retention_limit") : tr("storage_reclaim.rebuildable_download_cache_reclaimed_during_manual_cleanup") });
  }

  // Release archives: keep the newest and anything an update or the running version still needs.
  const downloadsRoot = join(store.root, "downloads");
  const busy = Boolean(downloadsBusy());
  const archives = [];
  for (const platform of await listDirectory(fs, downloadsRoot)) {
    const platformPath = join(downloadsRoot, platform);
    const info = await probe(fs, platformPath);
    if (!info) continue;
    if (info.isFile()) {
      const match = /^v(\d+\.\d+\.\d+(?:-alpha)?)-/.exec(platform);
      archives.push({ id: `release-download:legacy/${platform}`, path: platformPath, version: match?.[1] || null, legacy: true, partial: platform.endsWith(".partial") });
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    for (const version of await listDirectory(fs, platformPath)) {
      const versionPath = join(platformPath, version);
      const versionInfo = await probe(fs, versionPath);
      if (!versionInfo?.isDirectory() || versionInfo.isSymbolicLink()) continue;
      for (const checksum of await listDirectory(fs, versionPath)) {
        const path = join(versionPath, checksum);
        const files = await listDirectory(fs, path);
        archives.push({ id: `release-download:${platform}/${version}/${checksum}`, path, version,
          partial: files.some(file => file.endsWith(".partial")) });
      }
    }
  }
  const versions = archives.map(item => item.version).filter(Boolean).sort(compareVersions);
  const newest = versions.at(-1) || null;
  const protectedSet = new Set([...protectedVersions, currentVersion, newest].filter(Boolean));
  for (const archive of archives) {
    const entry = { ...archive, kind: "release-download", policy: "automatic" };
    if (busy) Object.assign(entry, { action: "keep", reason: tr("storage_reclaim.an_update_is_downloading_cleanup_is_deferred") });
    else if (archive.partial) Object.assign(entry, { action: "keep", reason: tr("storage_reclaim.download_incomplete") });
    else if (archive.version && protectedSet.has(archive.version)) {
      Object.assign(entry, { action: "keep", reason: archive.version === newest && !protectedVersions.includes(archive.version)
        ? tr("storage_reclaim.most_recently_downloaded_installer") : tr("storage_reclaim.installer_for_the_current_version_or_pending_update") });
    } else if (!archive.version) Object.assign(entry, { action: "keep", reason: tr("storage_reclaim.unrecognized_version_retaining_it_conservatively") });
    else Object.assign(entry, { action: "reclaim", reason: tr("storage_reclaim.the_cleo_value_installer_was_superseded_by_a_newer_version", { p0: archive.version }) });
    await push(entry);
  }

  // Retained programs and data backups are governed by the evolution store; list them with their reasons.
  const keepRoles = new Map();
  const role = (id, label) => { if (id) keepRoles.set(id, [...(keepRoles.get(id) || []), label]); };
  role(state.active, tr("storage_reclaim.current_program")); role(state.baseline, tr("storage_reclaim.initial_working_version")); role(state.workspaceBase, tr("storage_reclaim.evolution_baseline"));
  role(state.latestSaved, tr("storage_reclaim.most_recently_saved_version")); role(state.candidate, tr("storage_reclaim.candidate_build")); role(state.downloadedOfficial, tr("storage_reclaim.downloaded_update"));
  for (const id of await listDirectory(fs, buildsRoot)) {
    const path = join(buildsRoot, id);
    if (!(await probe(fs, path))?.isDirectory()) continue;
    const build = (state.builds || []).find(item => item.id === id);
    const pending = (state.cleanupPending || []).includes(id);
    await push({ id: `build:${id}`, kind: "build", path, version: build?.version || null, action: "keep",
      reason: pending ? tr("storage_reclaim.retired_awaiting_deletion_retry_after_previously_being_in_use") : build
        ? `${build.kind === "official" ? tr("storage_reclaim.program") : tr("storage_reclaim.local_version")} ${build.version || build.name || ""}${keepRoles.has(id) ? ` · ${keepRoles.get(id).join("、")}` : ""}`.trim()
        : tr("storage_reclaim.unregistered_program_directory_handled_by_startup_checks") });
  }
  const backupsRoot = join(store.root, "backups");
  const protectedBackups = new Set([state.transaction?.backup, state.transaction?.id && `apply-${state.transaction.id}`, state.lastApplication?.backup].filter(Boolean));
  for (const id of await listDirectory(fs, backupsRoot)) {
    const path = join(backupsRoot, id);
    if (!(await probe(fs, path))?.isDirectory()) continue;
    const pending = (state.backupCleanupPending || []).includes(id);
    await push({ id: `backup:${id}`, kind: "backup", path, action: "keep",
      reason: pending ? tr("storage_reclaim.exceeds_retention_count_awaiting_deletion_retry") : protectedBackups.has(id) ? tr("storage_reclaim.data_backup_required_for_recovery")
        : BACKUP.test(id) ? tr("storage_reclaim.retained_data_backup_up_to_three") : tr("storage_reclaim.unknown_backup_directory_retaining_it_conservatively") });
  }
  for (const name of USER_DATA_ENTRIES) {
    const path = join(dataHome, name);
    if (!await probe(fs, path)) continue;
    await push({ id: `user-data:${name}`, kind: "user-data", path, action: "keep", reason: tr("storage_reclaim.user_data_never_cleaned") });
  }
  for (const entry of entries) {
    // Nothing that overlaps protected user data may ever be reclaimed, whatever its category,
    // whichever path (logical or real) reaches it.
    if (entry.action !== "reclaim") continue;
    const locations = [entry.path, await realLocation(fs, entry.path)].filter(Boolean);
    if (locations.some(location => [...userData].some(path => within(location, path) || within(path, location)))) {
      Object.assign(entry, { action: "keep", reason: tr("storage_reclaim.overlaps_user_data_cleanup_refused") });
    }
  }
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const reclaim = entries.filter(entry => entry.action === "reclaim");
  return {
    computedAt: now, dataHome, controlRoot: store.root, entries, totalBytes: total,
    reclaimableBytes: reclaim.reduce((sum, entry) => sum + entry.bytes, 0),
    automaticBytes: reclaim.filter(entry => entry.policy === "automatic").reduce((sum, entry) => sum + entry.bytes, 0),
    pending: Array.isArray(state.storageCleanupPending) ? state.storageCleanupPending : [],
    lastCleanup: state.lastStorageCleanup || null,
  };
}

/** Purpose: Remove reclaimable entries with deletion intent journaled first so Windows locks and crashes retry later.
 * Input: inventory options plus `manual` (also reclaim caches kept for convenience). Output: removed/failed ids and bytes.
 */
export async function reclaimStorage(options, { manual = false } = {}) {
  const { store, fs = filesystem() } = options;
  const inUse = options.runtimeInUse || runtimeInUse;
  return store.exclusive(async () => {
    const inventory = await storageInventory({ measure: manual ? "all" : "reclaim", ...options, fs });
    const targets = inventory.entries.filter(entry => entry.action === "reclaim" && (manual || entry.policy === "automatic"));
    const previous = inventory.pending.filter(id => !targets.some(entry => entry.id === id));
    if (!targets.length) {
      if (previous.length) await store.update({ storageCleanupPending: [] });
      return { removed: [], failed: [], freedBytes: 0, inventory };
    }
    await store.update({ storageCleanupPending: targets.map(entry => entry.id) });
    const ownedRoots = (await Promise.all([
      join(resolve(options.dataHome), "runtimes"), ...(options.onlineRoots || []), join(store.root, "downloads"),
    ].map(root => realLocation(fs, root)))).filter(Boolean);
    const protectedData = (await Promise.all(USER_DATA_ENTRIES.map(name => realLocation(fs, join(resolve(options.dataHome), name))))).filter(Boolean);
    const removed = [], failed = [];
    let freedBytes = 0;
    for (const entry of targets) {
      try {
        const parent = dirname(entry.path);
        const realParent = await fs.realpath(parent);
        const info = await fs.lstat(entry.path);
        if (info.isSymbolicLink()) throw new Error("Linked storage entry.");
        const real = await fs.realpath(entry.path);
        if (real !== join(realParent, basename(entry.path))) throw new Error("Relocated storage entry.");
        if (!ownedRoots.some(root => within(real, root))) throw new Error("Storage entry outside Cleo-owned roots.");
        if (protectedData.some(path => within(real, path) || within(path, real))) throw new Error("Storage entry overlaps user data.");
        if (entry.kind === "online-runtime") {
          // Recheck after measuring/journaling: an installer or process may have started meanwhile.
          if (await inUse(real, fs)) throw new Error("旧运行环境仍有进程使用，退出后重试。");
          if (options.downloadsBusy?.() || (await store.read()).transaction) throw new Error("安装或更新尚未完成，稍后重试。");
          for (const name of await listDirectory(fs, parent)) {
            if (name.startsWith(".install-")
                && Date.now() - (await fs.stat(join(parent, name))).mtimeMs <= STALE_INSTALL_MS) {
              throw new Error("运行环境正在安装，稍后重试。");
            }
          }
        }
        await fs.rm(entry.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed.push(entry.id);
        freedBytes += entry.bytes;
      } catch (error) {
        if (error.code === "ENOENT" && !await probe(fs, entry.path)) {
          removed.push(entry.id); freedBytes += entry.bytes; continue;
        }
        failed.push({ id: entry.id, error: error.message });
      }
    }
    const result = { at: Date.now(), removed: removed.length, failed: failed.length, freedBytes, manual };
    await store.update({ storageCleanupPending: failed.map(item => item.id), lastStorageCleanup: result });
    return { removed, failed, freedBytes, inventory: { ...inventory,
      entries: inventory.entries.filter(entry => !removed.includes(entry.id)),
      totalBytes: inventory.totalBytes - freedBytes,
      reclaimableBytes: inventory.reclaimableBytes - freedBytes,
      automaticBytes: Math.max(0, inventory.automaticBytes - targets.filter(e => e.policy === "automatic" && removed.includes(e.id)).reduce((s, e) => s + e.bytes, 0)),
      pending: failed.map(item => item.id), lastCleanup: result } };
  });
}
