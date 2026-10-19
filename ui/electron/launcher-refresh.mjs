import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as nativeFs from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { desktopPlatform, installationRoot } from "./platform.mjs";
import { exists, ownedPath, readJson } from "./evolution-store.mjs";
import { copyProgramBundle } from "./evolution-tools.mjs";
import { executableInUse } from "./install-state.mjs";

/** The Inno Setup AppId from scripts/installers/windows.iss; its uninstall key is `<AppId>_is1`. */
export const WINDOWS_INSTALLER_APP_ID = "{AD929A4D-0594-4D59-A698-5D8B26D72795}";
export const WINDOWS_UNINSTALL_HIVES = [
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
/** Give up after this many failed attempts for one build; a newer activation starts over. */
export const MAX_REFRESH_ATTEMPTS = 3;
// Inno Setup's uninstaller and the source-checkout installer's receipt live beside Cleo.exe and are not part of a build.
const PRESERVED_ENTRIES = /^(unins\d*\.(exe|dat|msg|dll)|install\.json)$/i;
const SIBLING_PATTERN = /\.(refresh|retired)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nativeFilesystem() {
  return process.versions.electron ? createRequire(import.meta.url)("original-fs").promises : nativeFs;
}

function normalize(path, platform) {
  const absolute = resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

function outside(parent, path) {
  const child = relative(resolve(parent), resolve(path));
  return !child || child.startsWith("..") || isAbsolute(child);
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Input: platform. Output: the installer's default launcher when the registry has never recorded one. */
export function defaultLauncherPaths(platform = process.platform, environment = process.env) {
  if (platform !== "win32" || !environment.LOCALAPPDATA) return [];
  return [join(environment.LOCALAPPDATA, "Programs", "Cleo", "Cleo.exe")];
}

/** Input: recorded launcher path (lowercased on Windows) and target. Output: its bundle root, or a layout error. */
export function launcherRoot(path, target) {
  if (target.platform !== "win32") return installationRoot(path, target);
  if (basename(path).toLowerCase() !== target.executable.toLowerCase()) {
    throw new Error("The executable does not match the expected Cleo package layout.");
  }
  return installationRoot(join(dirname(path), target.executable), target);
}

/** Input: a lowercased Windows path. Output: the same path with the leaf spelled as it exists on disk, so a swap keeps it. */
async function onDiskCase(path, filesystem) {
  try {
    const name = basename(path);
    const actual = (await filesystem.readdir(dirname(path))).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return actual ? join(dirname(path), actual) : path;
  } catch { return path; }
}

/** Input: installed bundle root and target. Output: its release metadata version, or null when not a Cleo release. */
async function installedVersion(root, target) {
  const metadata = await readJson(join(target.platform === "darwin" ? join(root, target.resources) : root, "release.json"))
    .catch(() => null);
  if (metadata?.app !== "Cleo" || metadata.platform !== target.id || typeof metadata.version !== "string") return null;
  return metadata.version;
}

/** Purpose: Point the Inno Setup uninstall entry at the version now installed under the launcher.
 * Input: installed root and version. Output: updated registry key paths; a missing entry is not an error.
 * The entry is found by its recorded `Inno Setup: App Path`, falling back to the installer's AppId.
 */
export async function updateWindowsUninstallEntry(root, version, { hives = WINDOWS_UNINSTALL_HIVES, appId = WINDOWS_INSTALLER_APP_ID } = {}) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$root = ${powershellLiteral(root)}`,
    `$version = ${powershellLiteral(version)}`,
    `$appId = ${powershellLiteral(appId)}`,
    `$hives = @(${hives.map(powershellLiteral).join(", ")})`,
    "function Normalize-Path([string]$path) { return [System.IO.Path]::GetFullPath($path).TrimEnd('\\').ToLowerInvariant() }",
    "$keys = @()",
    "foreach ($hive in $hives) {",
    "  if (-not (Test-Path -LiteralPath $hive)) { continue }",
    "  foreach ($key in @(Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue)) {",
    "    try {",
    "      $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue",
    "      $appPath = $properties.'Inno Setup: App Path'",
    "      if ($appPath) { if ((Normalize-Path $appPath) -eq (Normalize-Path $root)) { $keys += $key.PSPath } }",
    "      elseif ($key.PSChildName -eq ($appId + '_is1')) { $keys += $key.PSPath }",
    "    } catch { continue }",
    "  }",
    "}",
    "$updated = @(); $failed = @()",
    "$parts = @($version -split '[^0-9]+' | Where-Object { $_ -ne '' })",
    "foreach ($key in $keys) {",
    "  try {",
    "    Set-ItemProperty -LiteralPath $key -Name 'DisplayVersion' -Value $version -Type String",
    "    foreach ($pair in @(@('VersionMajor', 0), @('MajorVersion', 0), @('VersionMinor', 1), @('MinorVersion', 1))) {",
    "      $existing = Get-ItemProperty -LiteralPath $key -Name $pair[0] -ErrorAction SilentlyContinue",
    "      if ($existing -and $parts.Count -gt $pair[1]) { Set-ItemProperty -LiteralPath $key -Name $pair[0] -Value ([int]$parts[$pair[1]]) -Type DWord }",
    "    }",
    "    $updated += $key",
    "  } catch { $failed += ($key + ': ' + $_.Exception.Message) }",
    "}",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ updated = @($updated); failed = @($failed) }))",
  ].join("\n");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await promisify(execFile)(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ""));
  if (result.failed?.length && !result.updated?.length) throw new Error(result.failed.join("; "));
  return result.updated || [];
}

/** Purpose: Keep the installed entry point (the launcher the Start Menu and taskbar open) at the running official version.
 * Input: evolution store and the running program; optional seams for tests. Output: per-launcher outcome.
 * Runs after a healthy startup of an official build that lives under evolution/builds. The launcher has already
 * quit after handing off, so its directory is replaced wholesale by a sibling-rename swap; a Windows file lock
 * leaves a journal in the registry (`launcherRefresh`) that the next healthy startup retries. User data is never touched.
 */
export async function refreshInstalledLauncher({
  store, executable = process.execPath, platform = process.platform, arch = process.arch,
  filesystem = nativeFilesystem(), copyBundle = copyProgramBundle, inUse = executableInUse,
  registry = platform === "win32" ? updateWindowsUninstallEntry : async () => [],
  launchers = defaultLauncherPaths(platform), log = () => {},
} = {}) {
  const target = desktopPlatform(platform, arch);
  const state = await store.read();
  const active = state.builds.find((build) => build.id === state.active);
  if (state.transaction || active?.kind !== "official" || !active.version) return { status: "skipped", reason: "no-official-build" };
  if (outside(ownedPath(store.root, "builds"), executable)) return { status: "skipped", reason: "launcher-running" };
  let build;
  try { build = await store.build(active.id); }
  catch { return { status: "skipped", reason: "build-missing" }; }
  if (normalize(build.executable, platform) !== normalize(executable, platform)) return { status: "skipped", reason: "inactive-program" };
  const source = join(build.directory, target.bundle);

  await cleanLeftovers(store, filesystem);
  const recorded = Object.keys(state.installedReleases || {});
  const candidates = [...new Set([...recorded, ...launchers.map((path) => normalize(path, platform))])];
  const results = {};
  for (const path of candidates) {
    let root;
    try { root = launcherRoot(path, target); }
    catch { results[path] = { status: "skipped", reason: "not-a-cleo-layout" }; continue; }
    if (!outside(store.root, path) || normalize(path, platform) === normalize(executable, platform)) {
      results[path] = { status: "skipped", reason: "managed-program" }; continue;
    }
    if (platform === "win32") root = await onDiskCase(root, filesystem);
    const previous = state.launcherRefresh?.[path] || null;
    await recoverInterruptedSwap(previous, root, filesystem);
    if (!await exists(path)) { results[path] = { status: "skipped", reason: "missing" }; continue; }
    // A location the registry never recorded is adopted only when it carries Cleo release metadata.
    if (!recorded.includes(path) && !previous && !await installedVersion(root, target)) {
      results[path] = { status: "skipped", reason: "unidentified" }; continue;
    }
    results[path] = await refreshLauncher({ store, path, root, previous, source, build: active, target, filesystem, copyBundle, inUse, registry, log });
  }
  return { status: "done", results };
}

/** Input: journaled leftover directories. Output: removes those that are still siblings of a launcher root; the rest stay journaled. */
async function cleanLeftovers(store, filesystem) {
  const state = await store.read();
  const pending = Array.isArray(state.launcherCleanupPending) ? state.launcherCleanupPending : [];
  if (!pending.length) return;
  const failures = [];
  for (const path of pending) {
    try {
      if (typeof path !== "string" || !SIBLING_PATTERN.test(path)) continue;
      if (!outside(store.root, path) || !outside(store.dataHome, path)) continue;
      await filesystem.rm(path, { recursive: true, force: true });
    } catch { failures.push(path); }
  }
  await store.exclusive(() => store.update({ launcherCleanupPending: failures }));
}

/** Input: launcher path and its journal entry (null closes it). Output: the per-launcher refresh journal persisted. */
async function journal(store, path, entry) {
  await store.exclusive(async () => {
    const { [path]: _previous, ...others } = (await store.read()).launcherRefresh || {};
    await store.update({ launcherRefresh: entry ? { ...others, [path]: entry } : others });
  });
}

/** Input: a launcher whose swap was interrupted. Output: the launcher directory present again, from the new or old copy. */
async function recoverInterruptedSwap(journalEntry, root, filesystem) {
  if (!journalEntry || !["replacing", "cleaning"].includes(journalEntry.phase)) return;
  if (!await exists(root)) {
    if (journalEntry.staging && await exists(journalEntry.staging)) await filesystem.rename(journalEntry.staging, root);
    else if (journalEntry.retired && await exists(journalEntry.retired)) await filesystem.rename(journalEntry.retired, root);
  }
}

async function refreshLauncher({ store, path, root, previous, source, build, target, filesystem, copyBundle, inUse, registry, log }) {
  const state = await store.read();
  const leftovers = [previous?.staging, previous?.retired, ...(previous?.leftovers || [])].filter(Boolean);
  const onDisk = await installedVersion(root, target);
  const current = onDisk === build.version && state.installedReleases?.[path] === build.version;
  if (current && !previous) return { status: "current", version: build.version };
  if (onDisk === build.version) {
    // Only bookkeeping is missing: a completed swap whose journal was not closed, or an unrecorded launcher.
    const registryKeys = previous ? await registry(root, build.version).catch((error) => { log(`Uninstall entry: ${error.message}`); return []; }) : [];
    await finish({ store, path, root, build, leftovers, registryKeys, filesystem });
    return { status: "recorded", version: build.version };
  }
  const attempts = previous?.build === build.id ? previous.attempts : 0;
  if (attempts >= MAX_REFRESH_ATTEMPTS) return { status: "deferred", reason: "attempts-exhausted", error: previous.error };
  const id = randomUUID();
  const entry = { id, path, root, build: build.id, version: build.version, attempts: attempts + 1,
    staging: `${root}.refresh-${id}`, retired: `${root}.retired-${id}`, phase: "copying",
    startedAt: new Date().toISOString(), error: null, leftovers };
  await journal(store, path, entry);
  try {
    if (await inUse(path)) throw Object.assign(new Error("The installed launcher is still running."), { code: "EBUSY" });
    await copyBundle(source, entry.staging);
    if (!await exists(join(entry.staging, target.executable))) throw new Error("The copied program is incomplete.");
    for (const name of await filesystem.readdir(root)) {
      if (!PRESERVED_ENTRIES.test(name) || await exists(join(entry.staging, name))) continue;
      await filesystem.copyFile(join(root, name), join(entry.staging, name));
    }
    await journal(store, path, { ...entry, phase: "replacing" });
    await filesystem.rename(root, entry.retired);
    try { await filesystem.rename(entry.staging, root); }
    catch (error) { await filesystem.rename(entry.retired, root); throw error; }
    await journal(store, path, { ...entry, phase: "cleaning" });
    const cleanup = [];
    try { await filesystem.rm(entry.retired, { recursive: true, force: true, maxRetries: 3 }); }
    catch { cleanup.push(entry.retired); }
    const registryKeys = await registry(root, build.version).catch((error) => { log(`Uninstall entry: ${error.message}`); return []; });
    await finish({ store, path, root, build, leftovers: [...leftovers, ...cleanup], registryKeys, filesystem });
    return { status: "refreshed", version: build.version, registryKeys };
  } catch (error) {
    const cleanup = [...leftovers];
    try { await filesystem.rm(entry.staging, { recursive: true, force: true, maxRetries: 3 }); }
    catch { cleanup.push(entry.staging); }
    await journal(store, path, { ...entry, phase: "failed", error: error.message, leftovers: cleanup });
    log(`Launcher refresh deferred: ${error.message}`);
    return { status: "deferred", error: error.message };
  }
}

/** Input: completed refresh. Output: closed journal, version bookkeeping and leftover cleanup intent. */
async function finish({ store, path, root, build, leftovers, registryKeys, filesystem }) {
  await store.exclusive(async () => {
    const state = await store.read();
    const pending = Array.isArray(state.launcherCleanupPending) ? state.launcherCleanupPending : [];
    const { [path]: _closed, ...journals } = state.launcherRefresh || {};
    await store.update({
      installedReleases: { ...state.installedReleases, [path]: build.version },
      launcherRefresh: journals,
      launcherCleanupPending: [...new Set([...pending, ...leftovers])],
      installedLauncher: { path, root, version: build.version, build: build.id,
        refreshedAt: new Date().toISOString(), registryKeys },
    });
  });
  // Leftovers that were just journaled are removed on the next run; try once now so a healthy install is clean.
  if (leftovers.length) await cleanLeftovers(store, filesystem);
}
