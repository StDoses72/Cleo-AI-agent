import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as nativeFs from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { desktopPlatform, installationRoot } from "./platform.mjs";
import { compareVersions } from "./updater.mjs";
import { readJson } from "./evolution-store.mjs";

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
const executeFile = promisify(execFile);
const WINDOWS_INSTALL_KEY = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{AD929A4D-0594-4D59-A698-5D8B26D72795}_is1";
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

/** Include the currently registered Windows installer location, which can differ from its default.
 * Both channels share one AppId; unregistered moved/copied bundles are not discoverable here.
 * Registry failures propagate so cleanup cannot proceed with an incomplete owner inventory.
 */
export async function installedLauncherPaths({ platform = process.platform, environment = process.env, execute = executeFile } = {}) {
  const launchers = defaultLauncherPaths(platform, environment);
  if (platform !== "win32") return launchers;
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$locations = @()
foreach ($hive in @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)) {
  $key = $hive.OpenSubKey('${WINDOWS_INSTALL_KEY}')
  if ($null -eq $key) { continue }
  try {
    $paths = @('InstallLocation', 'Inno Setup: App Path') | ForEach-Object { $key.GetValue($_) } | Where-Object { $_ -ne $null -and $_ -ne '' }
    if (!$paths) { throw 'The Cleo installer registration has no installation path.' }
    $locations += $paths
  } finally { $key.Dispose() }
}
ConvertTo-Json -InputObject @($locations) -Compress
`;
  const powershell = win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  const locations = JSON.parse(stdout.trim());
  if (!Array.isArray(locations) || locations.some(path => typeof path !== "string" || !win32.isAbsolute(path))) {
    throw new Error("The Cleo installer registration contains an invalid installation path.");
  }
  return [...new Set([...launchers, ...locations.map(path => win32.join(path, "Cleo.exe"))])];
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
  /** A reference with no known version keeps every version of its namespace. */
  const add = (path, label, version = null) => {
    if (!path) return;
    const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const entry = references.get(key) || { path: resolve(path), label, versions: new Set(), unknownVersion: false };
    if (version) entry.versions.add(String(version)); else entry.unknownVersion = true;
    references.set(key, entry);
  };
  if (currentResources) add(currentResources, "当前运行的 Cleo", currentVersion);
  const registered = new Map((state.builds || []).map(build => [build.id, build]));
  for (const id of await listDirectory(fs, buildsRoot)) {
    if (!BUILD.test(id)) continue;
    const build = registered.get(id);
    const pending = (state.cleanupPending || []).includes(id);
    const label = build ? `${build.kind === "official" ? "程序" : "本机版本"} ${build.version || build.name || id}`
      : `未登记的程序目录 ${id}`;
    const resources = join(buildsRoot, id, target.bundle, target.resources);
    add(resources, pending ? `${label}（等待退役）` : label, build?.version || await bundleVersion(fs, resources, target));
  }
  for (const [executable, version] of Object.entries(state.installedReleases || {})) {
    try {
      const resources = join(installationRoot(executable, target), target.resources);
      // The launcher may have been upgraded in place since it was journaled; its bundle says which version runs now.
      add(resources, `已安装的 Cleo ${version}`, await bundleVersion(fs, resources, target) || version);
    } catch { /* A foreign layout is not a runtime owner. */ }
  }
  for (const executable of installedExecutables || []) {
    try {
      // A launcher that never opened the evolution registry is still a program with a runtime.
      if (!await probe(fs, executable)) continue;
      const resources = join(installationRoot(executable, target), target.resources);
      const version = await bundleVersion(fs, resources, target);
      add(resources, version ? `已安装的 Cleo ${version}` : "已安装的 Cleo", version
        || (resolve(executable) === resolve(process.execPath) ? currentVersion : null));
    } catch { /* ignore */ }
  }
  // Another release channel (Cleo / Cleo Alpha) shares the online runtime root; its programs count too.
  for (const sibling of siblings) {
    const label = sibling.label || "另一渠道的 Cleo";
    const siblingState = await readJson(join(sibling.controlRoot, "state.json"), {});
    const siblingBuilds = join(sibling.controlRoot, "builds");
    const registered = new Map((siblingState.builds || []).map(build => [build.id, build]));
    for (const id of await listDirectory(fs, siblingBuilds)) {
      if (!BUILD.test(id)) continue;
      const resources = join(siblingBuilds, id, target.bundle, target.resources);
      add(resources, `${label} 程序 ${registered.get(id)?.version || id}`,
        registered.get(id)?.version || await bundleVersion(fs, resources, target));
    }
    for (const [executable, version] of Object.entries(siblingState.installedReleases || {})) {
      try {
        const resources = join(installationRoot(executable, target), target.resources);
        add(resources, `${label} 已安装 ${version}`, await bundleVersion(fs, resources, target) || version);
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
  target = desktopPlatform(), fs = filesystem(), signal, now = Date.now(),
} = {}) {
  dataHome = resolve(dataHome);
  const state = await store.read();
  const buildsRoot = join(store.root, "builds");
  const entries = [];
  const size = path => directorySize(path, { fs, signal });
  // Startup passes measure only what they remove; walking retained programs and user data is for the UI.
  const push = async entry => { entries.push({ ...entry, bytes: measure === "all" || entry.action === "reclaim" ? await size(entry.path) : 0 }); };
  const references = await liveResources({ fs, state, buildsRoot, target, currentResources, currentVersion,
    installedExecutables: typeof installedExecutables === "function" ? await installedExecutables() : installedExecutables, siblings });
  const liveNamespaces = new Map();
  const owner = (key, item) => {
    const entry = liveNamespaces.get(key) || { label: item.label, versions: new Set(), unknownVersion: false };
    for (const version of item.versions) entry.versions.add(versionKey(version));
    entry.unknownVersion ||= item.unknownVersion;
    liveNamespaces.set(key, entry);
  };
  for (const item of references) owner(namespaceKey(item.path), item);
  if (currentRuntimeNamespace) {
    owner(basename(resolve(currentRuntimeNamespace)), { label: "当前运行的 Cleo",
      versions: new Set(currentVersion ? [currentVersion] : []), unknownVersion: !currentVersion });
  }
  const livePlans = new Map();
  for (const item of references) {
    const key = await planKey(item.path, fs);
    if (key) livePlans.set(key, item.label);
  }
  if (currentBaseResources && PLAN_KEY.test(basename(resolve(currentBaseResources)))) {
    livePlans.set(basename(resolve(currentBaseResources)), "当前运行的 Cleo");
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
        if (PLAN_KEY.test(key) && !livePlans.has(key)) livePlans.set(key, reason);
      }
    }
  };
  for (const sibling of siblings) {
    if (sibling.dataHome) protectHomes(await snapshotHomes(fs, join(sibling.dataHome, "runtimes")), `${sibling.label || "另一渠道的 Cleo"} 的依赖快照`);
  }
  // A linked runtimes directory could point anywhere, including at user data: never inventory through it.
  const runtimesLinked = await linkedDirectory(fs, runtimesRoot) && Boolean(await probe(fs, runtimesRoot));
  if (runtimesLinked) {
    entries.push({ id: "unknown:runtimes", kind: "unknown", path: runtimesRoot, bytes: 0, action: "keep", reason: "runtimes 目录是链接，不做清理" });
  }

  // Dependency snapshots: one namespace per program location, each holding validated runtime copies.
  for (const name of runtimesLinked ? [] : await listDirectory(fs, runtimesRoot)) {
    const path = join(runtimesRoot, name);
    if (name === "online" || onlineRootSet.includes(path)) continue;
    const info = await probe(fs, path);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    if (!NAMESPACE.test(name)) { await push({ id: `unknown:${name}`, kind: "unknown", path, action: "keep", reason: "未知来源的目录，保持保守" }); continue; }
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
        const reason = current ? `${owned.label} 的依赖快照` : `${owned.label} 原地升级前旧版本遗留的依赖快照`;
        if (current) protectPlans(item.presentHomes, reason);
        await push({ id: `runtime-namespace:${name}/${item.version}`, kind: "runtime-namespace", path: join(path, item.version),
          snapshots: item.snapshots, policy: "automatic", action: current ? "keep" : "reclaim", reason });
      }
      continue;
    }
    const snapshots = versions.reduce((sum, item) => sum + item.snapshots, 0);
    const presentHomes = versions.flatMap(item => item.presentHomes);
    const entry = { id: `runtime-namespace:${name}`, kind: "runtime-namespace", path, snapshots, policy: "automatic" };
    if (presentHomes.length) Object.assign(entry, { action: "keep", reason: `对应程序仍存在于 ${dirname(presentHomes[0])}，未登记为保留版本` });
    else Object.assign(entry, { action: "reclaim", reason: snapshots ? "对应程序已删除，快照无人使用" : "空的依赖命名空间" });
    if (entry.action === "keep") protectPlans(presentHomes, entry.reason);
    await push(entry);
  }

  // Shared online runtimes plus the installer's rebuildable caches.
  let installing = false;
  const caches = [];
  for (const root of onlineRootSet) {
    if (await linkedDirectory(fs, root)) {
      if (await probe(fs, root)) entries.push({ id: `unknown:online/${basename(root)}`, kind: "unknown", path: root, bytes: 0, action: "keep", reason: "运行环境目录是链接，不做清理" });
      continue;
    }
    for (const name of await listDirectory(fs, root)) {
      const path = join(root, name);
      const info = await probe(fs, path);
      if (!info) continue;
      if (name.startsWith(".install-")) {
        const stale = now - info.mtimeMs > STALE_INSTALL_MS;
        if (!stale) installing = true;
        await push({ id: `install-scratch:${name}`, kind: "install-scratch", path, policy: "automatic",
          action: stale ? "reclaim" : "keep", reason: stale ? "中断的安装遗留的临时目录" : "安装正在进行" });
        continue;
      }
      if (CACHE_NAMES.includes(name)) { caches.push({ id: `package-cache:${name}`, kind: "package-cache", path }); continue; }
      if (!info.isDirectory() || info.isSymbolicLink() || !PLAN_KEY.test(name)) {
        await push({ id: `unknown:online/${name}`, kind: "unknown", path, action: "keep", reason: "未知来源的目录，保持保守" });
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
      // Legacy script installers support custom locations without a registry entry; absence of an owner is not proof of disuse.
      await push({ id: `online-runtime:${name}`, kind: "online-runtime", path, version, policy: "automatic",
        action: owner || completed ? "keep" : "reclaim",
        reason: owner ? `${owner} 使用的运行环境` : completed ? "已完成的运行环境；旧安装器支持自定义程序位置，无法确认无人使用"
          : "未完成的运行环境，没有程序使用" });
    }
  }
  for (const cache of caches) {
    entries.push({ ...cache, bytes: await size(cache.path) });
  }
  const cacheBytes = caches.reduce((sum, cache) => sum + (entries.find(entry => entry.id === cache.id)?.bytes || 0), 0);
  for (const entry of entries) {
    if (entry.kind !== "package-cache") continue;
    if (installing) Object.assign(entry, { action: "keep", policy: "manual", reason: "安装正在进行，暂不清理下载缓存" });
    else Object.assign(entry, { action: "reclaim", policy: cacheBytes > cacheLimit ? "automatic" : "manual",
      reason: cacheBytes > cacheLimit ? "可重建的下载缓存，已超过保留上限" : "可重建的下载缓存，手动清理时释放" });
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
    if (busy) Object.assign(entry, { action: "keep", reason: "正在下载更新，暂不清理" });
    else if (archive.partial) Object.assign(entry, { action: "keep", reason: "下载尚未完成" });
    else if (archive.version && protectedSet.has(archive.version)) {
      Object.assign(entry, { action: "keep", reason: archive.version === newest && !protectedVersions.includes(archive.version)
        ? "最新下载的安装包" : "当前版本或待安装更新的安装包" });
    } else if (!archive.version) Object.assign(entry, { action: "keep", reason: "无法识别版本，保持保守" });
    else Object.assign(entry, { action: "reclaim", reason: `Cleo ${archive.version} 的安装包已被更新版本取代` });
    await push(entry);
  }

  // Retained programs and data backups are governed by the evolution store; list them with their reasons.
  const keepRoles = new Map();
  const role = (id, label) => { if (id) keepRoles.set(id, [...(keepRoles.get(id) || []), label]); };
  role(state.active, "当前程序"); role(state.baseline, "初始可用版本"); role(state.workspaceBase, "进化基线");
  role(state.latestSaved, "最近保存版本"); role(state.candidate, "候选构建"); role(state.downloadedOfficial, "已下载的更新");
  for (const id of await listDirectory(fs, buildsRoot)) {
    const path = join(buildsRoot, id);
    if (!(await probe(fs, path))?.isDirectory()) continue;
    const build = (state.builds || []).find(item => item.id === id);
    const pending = (state.cleanupPending || []).includes(id);
    await push({ id: `build:${id}`, kind: "build", path, version: build?.version || null, action: "keep",
      reason: pending ? "已退役，等待重试删除（上次被占用）" : build
        ? `${build.kind === "official" ? "程序" : "本机版本"} ${build.version || build.name || ""}${keepRoles.has(id) ? ` · ${keepRoles.get(id).join("、")}` : ""}`.trim()
        : "未登记的程序目录，由启动检查处理" });
  }
  const backupsRoot = join(store.root, "backups");
  const protectedBackups = new Set([state.transaction?.backup, state.transaction?.id && `apply-${state.transaction.id}`, state.lastApplication?.backup].filter(Boolean));
  for (const id of await listDirectory(fs, backupsRoot)) {
    const path = join(backupsRoot, id);
    if (!(await probe(fs, path))?.isDirectory()) continue;
    const pending = (state.backupCleanupPending || []).includes(id);
    await push({ id: `backup:${id}`, kind: "backup", path, action: "keep",
      reason: pending ? "超出保留份数，等待重试删除" : protectedBackups.has(id) ? "恢复所需的数据备份"
        : BACKUP.test(id) ? "保留的数据备份（最多三份）" : "未知备份目录，保持保守" });
  }
  for (const name of USER_DATA_ENTRIES) {
    const path = join(dataHome, name);
    if (!await probe(fs, path)) continue;
    await push({ id: `user-data:${name}`, kind: "user-data", path, action: "keep", reason: "用户数据，不会清理" });
  }
  for (const entry of entries) {
    // Nothing that overlaps protected user data may ever be reclaimed, whatever its category,
    // whichever path (logical or real) reaches it.
    if (entry.action !== "reclaim") continue;
    const locations = [entry.path, await realLocation(fs, entry.path)].filter(Boolean);
    if (locations.some(location => [...userData].some(path => within(location, path) || within(path, location)))) {
      Object.assign(entry, { action: "keep", reason: "与用户数据重叠，拒绝清理" });
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
        await fs.rm(entry.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed.push(entry.id);
        freedBytes += entry.bytes;
      } catch (error) {
        if (error.code === "ENOENT") { removed.push(entry.id); freedBytes += entry.bytes; continue; }
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
