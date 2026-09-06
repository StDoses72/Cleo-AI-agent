import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { compareVersions, DesktopUpdater, validateManifest as validatePlatformManifest } from "./updater.mjs";
import { installationPaths, readInstallation, writeInstallation } from "./install-state.mjs";

const validateManifest = (value) => validatePlatformManifest(value, { id: "windows-x64", archive: "Cleo-windows-x64.zip" });

const manifest = {
  schema_version: 1,
  app: "Cleo",
  version: "0.2.0",
  platform: "windows-x64",
  archive: "Cleo-windows-x64.zip",
  sha256: "a".repeat(64),
  bytes: 1024,
};

test("semantic version comparison handles prereleases", () => {
  assert.equal(compareVersions("0.1.3", "0.1.3-alpha"), 1);
  assert.equal(compareVersions("0.1.3-alpha.2", "0.1.3-alpha.10"), -1);
  assert.equal(compareVersions("v1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
});

test("release manifests must describe the expected verified Windows archive", () => {
  assert.equal(validateManifest(manifest).version, "0.2.0");
  assert.throws(
    () => validateManifest({ ...manifest, archive: "other.zip" }),
    /unexpected release metadata/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, sha256: "not-a-hash" }),
    /unexpected release metadata/,
  );
});

test("packaged updater reports a newer release", async () => {
  const states = [];
  const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
    app: {
      isPackaged: true,
      getVersion: () => "0.1.3-alpha",
      getPath: () => "C:\\Temp",
    },
    resourcesPath: "C:\\Cleo\\resources",
    executablePath: "C:\\Cleo\\Cleo.exe",
    onState: (state) => states.push(state),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => manifest,
    }),
  });

  const state = await updater.check();

  assert.equal(state.phase, "available");
  assert.equal(state.latestVersion, "0.2.0");
  assert.deepEqual(states.map((item) => item.phase), ["checking", "available"]);
});

test("development builds do not contact the release server", async () => {
  let fetched = false;
  const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
    app: { isPackaged: false, getVersion: () => "0.1.3-alpha" },
    resourcesPath: "",
    fetchImpl: async () => {
      fetched = true;
      throw new Error("unexpected fetch");
    },
  });

  assert.equal((await updater.check()).phase, "unsupported");
  assert.equal(fetched, false);
});

test("downloaded updates reach ready only after size and SHA-256 verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-"));
  const archive = Buffer.from("verified Cleo update");
  const downloadableManifest = {
    ...manifest,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
  };
  let request = 0;
  let archiveUrl = "";
  try {
    const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
      app: {
        isPackaged: true,
        getVersion: () => "0.1.3-alpha",
        getPath: () => root,
      },
      resourcesPath: root,
      executablePath: "C:\\Cleo\\Cleo.exe",
      fetchImpl: async (url) => {
        request += 1;
        if (request === 1) return { ok: true, status: 200, json: async () => downloadableManifest };
        archiveUrl = String(url);
        return new Response(archive, { status: 200 });
      },
    });

    assert.equal((await updater.check()).phase, "available");
    const state = await updater.download();
    assert.equal(state.phase, "ready");
    assert.equal(state.downloadedBytes, archive.length);
    assert.match(archiveUrl, /releases\/download\/v0\.2\.0\/Cleo-windows-x64\.zip$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified background download installs once on the next launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-auto-update-"));
  const archive = Buffer.from("new application");
  const release = { ...manifest, bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex") };
  const app = { isPackaged: true, getVersion: () => "0.1.0", getPath: () => root };
  const options = { app, platform: "win32", arch: "x64", resourcesPath: root,
    executablePath: join(root, "Cleo.exe") };
  try {
    const downloading = new DesktopUpdater({ ...options,
      fetchImpl: async (url) => String(url).endsWith(".zip")
        ? new Response(archive) : { ok: true, json: async () => release },
    });
    assert.equal((await downloading.download()).phase, "ready");
    const next = new DesktopUpdater(options);
    let installed = 0;
    next.install = async () => { installed += 1; return true; };
    assert.equal(await next.installPending(), true);
    assert.equal(installed, 1);
    assert.equal(await next.installPending(), false);
    assert.equal(installed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed pending archive cannot trigger automatic installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-auto-update-invalid-"));
  try {
    const updater = new DesktopUpdater({
      app: { isPackaged: true, getVersion: () => "0.1.0", getPath: () => root },
      platform: "win32", arch: "x64", resourcesPath: root,
      executablePath: join(root, "Cleo.exe"),
    });
    await writeFile(updater.pendingPath(), JSON.stringify(manifest));
    const archive = updater.archiveFor(validateManifest(manifest));
    await mkdir(join(root, "cleo-update-0.2.0"));
    await writeFile(archive, "tampered");
    updater.install = async () => { throw new Error("must not install"); };
    assert.equal(await updater.installPending(), false);
    assert.match(updater.getState().error, /verification/);
    assert.equal(await updater.installPending(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readyUpdater(root, spawnImpl, quit) {
  const resourcesPath = join(root, "Installed Cleo", "resources");
  const stagingRoot = join(root, "Downloaded update");
  await mkdir(resourcesPath, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(resourcesPath, "update.ps1"), "# installer fixture\n");
  await writeFile(join(resourcesPath, "update-progress.ps1"), "# progress fixture\n");
  const updater = new DesktopUpdater({
    platform: "win32", arch: "x64",
    app: { isPackaged: true, getVersion: () => "0.1.0", getPath: () => root, quit },
    resourcesPath,
    executablePath: join(root, "Installed Cleo", "Cleo.exe"),
    spawnImpl,
    processIdentity: async () => "test-start",
  });
  updater.manifest = validateManifest(manifest);
  updater.archivePath = join(stagingRoot, manifest.archive);
  updater.setState({ phase: "ready" });
  return updater;
}

test("install waits for the launcher to succeed and prevents duplicate launches", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-spawn-"));
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  let spawned;
  const spawnRequested = new Promise((resolve) => { spawned = resolve; });
  let launches = 0;
  let quits = 0;
  let launchOptions;
  try {
    const updater = await readyUpdater(root, (_command, _args, options) => {
      launches += 1;
      launchOptions = options;
      spawned();
      return child;
    }, () => { quits += 1; });
    const installing = updater.install();
    await spawnRequested;
    child.emit("spawn");
    await new Promise(setImmediate);
    assert.equal(launchOptions.cwd, join(root, "Downloaded update"));
    assert.notEqual(launchOptions.detached, true);
    assert.equal(quits, 0);
    assert.equal(await updater.install(), false);
    assert.equal(launches, 1);
    child.emit("exit", 0);
    await new Promise(setImmediate);
    assert.equal(quits, 0, "launcher exit alone does not acknowledge installer startup");
    const paths = installationPaths(root, updater.executablePath);
    const starting = await readInstallation(paths.status);
    await writeInstallation(paths.status, { ...starting, phase: "verifying", pid: process.pid + 1 });
    assert.equal(await installing, true);
    await new Promise(setImmediate);
    assert.equal(quits, 1);
    assert.equal(updater.getState().phase, "installing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer spawn failures keep Cleo open and allow retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-spawn-error-"));
  let quits = 0;
  try {
    const updater = await readyUpdater(root, () => {
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      setImmediate(() => child.emit("error", new Error("installer launch denied")));
      return child;
    }, () => { quits += 1; });
    await assert.rejects(updater.install(), /installer launch denied/);
    await new Promise(setImmediate);
    assert.equal(quits, 0);
    assert.equal(updater.getState().phase, "ready");
    assert.match(updater.getState().error, /installer launch denied/);
    assert.equal((await readInstallation(installationPaths(root, updater.executablePath).status)).phase, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher errors keep Cleo open and report the installation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-launch-error-"));
  let quits = 0;
  try {
    const updater = await readyUpdater(root, () => {
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      setImmediate(() => {
        child.stderr.write("Start-Process: access denied");
        child.emit("exit", 1);
      });
      return child;
    }, () => { quits += 1; });
    await assert.rejects(updater.install(), /Start-Process: access denied/);
    await new Promise(setImmediate);
    assert.equal(quits, 0);
    assert.equal(updater.getState().phase, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows restart-install replaces an existing installation and launches the new version", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-windows-"));
  const run = promisify(execFile);
  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const psArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  const installRoot = join(root, "Installed Cleo ' & 测试");
  const resourcesPath = join(installRoot, "resources");
  const stagingRoot = join(root, "Downloaded update ' & 测试");
  const archivePath = join(stagingRoot, manifest.archive);
  try {
    await mkdir(resourcesPath, { recursive: true });
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(join(installRoot, "Cleo.exe"), "old executable");
    await writeFile(join(installRoot, "obsolete.txt"), "old release file");
    await writeFile(join(root, "user-data.json"), "preserve local data");
    await copyFile(new URL("../../scripts/download.ps1", import.meta.url), join(resourcesPath, "update.ps1"));
    await writeFile(join(resourcesPath, "update-progress.ps1"), 'param($StatusPath)\n[System.IO.File]::WriteAllText("$StatusPath.window", [string]$PID)\nStart-Sleep -Seconds 1\n' );
    const fixtureScript = join(root, "package.ps1");
    await writeFile(fixtureScript, `
param($Root, $Archive)
$ErrorActionPreference = 'Stop'
$package = Join-Path $Root 'package\\Cleo'
New-Item -ItemType Directory -Path $package -Force | Out-Null
Add-Type -OutputAssembly (Join-Path $package 'Cleo.exe') -OutputType WindowsApplication -TypeDefinition @'
using System;
using System.IO;
public class Cleo {
    public static void Main() {
        File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launched.txt"), "0.2.0");
    }
}
'@
'{"app":"Cleo","version":"0.2.0","platform":"windows-x64"}' | Set-Content (Join-Path $package 'release.json')
Compress-Archive -LiteralPath $package -DestinationPath $Archive
`);
    await run(powershell, [...psArgs, "-File", fixtureScript, root, archivePath], { windowsHide: true });
    const archive = await readFile(archivePath);
    const release = { ...manifest, bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") };
    const harnessPath = join(root, "restart.mjs");
    await writeFile(harnessPath, `
import { DesktopUpdater, validateManifest } from ${JSON.stringify(new URL("./updater.mjs", import.meta.url).href)};
const updater = new DesktopUpdater({
  platform: "win32", arch: "x64",
  app: { isPackaged: true, getVersion: () => "0.1.0", getPath: () => ${JSON.stringify(root)}, quit: () => process.exit(0) },
  resourcesPath: ${JSON.stringify(resourcesPath)},
  executablePath: ${JSON.stringify(join(installRoot, "Cleo.exe"))},
});
updater.manifest = validateManifest(${JSON.stringify(release)});
updater.archivePath = ${JSON.stringify(archivePath)};
updater.setState({ phase: "ready" });
await updater.install();
`);
    try {
      await run(process.execPath, [harnessPath], { cwd: installRoot, windowsHide: true, timeout: 25_000 });
    } catch (error) {
      error.message += `\nInstaller stderr: ${await readFile(join(stagingRoot, "install-error.log"), "utf8").catch(() => "unavailable")}`;
      throw error;
    }
    let launched;
    let log = "";
    let errors = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      log = await readFile(join(stagingRoot, "install.log"), "utf8");
      errors = await readFile(join(stagingRoot, "install-error.log"), "utf8");
      try {
        launched = await readFile(join(installRoot, "launched.txt"), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (launched || errors) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(log, /Cleo download and installation complete\./, errors || log);
    const installed = JSON.parse((await readFile(join(installRoot, "install.json"), "utf8")).replace(/^\uFEFF/, ""));
    assert.equal(installed.version, "0.2.0");
    assert.equal(installed.sha256, release.sha256);
    assert.equal(launched, "0.2.0", errors || log);
    const status = await readInstallation(installationPaths(root, join(installRoot, "Cleo.exe")).status);
    assert.equal(status.phase, "completed");
    assert.equal(status.version, "0.2.0");
    await assert.rejects(readFile(join(installRoot, "obsolete.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(archivePath), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "user-data.json"), "utf8"), "preserve local data");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("the next startup reports installation success or failure once", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-result-"));
  try {
    const exe = join(root, "Cleo.exe");
    const paths = installationPaths(root, exe);
    const updater = new DesktopUpdater({
      platform: "win32", arch: "x64",
      app: { isPackaged: true, getVersion: () => "0.2.0", getPath: () => root },
      executablePath: exe, resourcesPath: root,
    });
    await writeInstallation(paths.status, { phase: "completed", version: "0.2.0" });
    assert.equal(await updater.restoreInstallationResult(), true);
    assert.equal(updater.getState().phase, "updated");
    assert.equal(await updater.restoreInstallationResult(), false);
    await writeInstallation(paths.status, { phase: "failed", version: "0.2.0", error: "Replacement failed" });
    assert.equal(await updater.restoreInstallationResult(), true);
    assert.equal(updater.getState().phase, "install-failed");
    assert.equal(updater.getState().error, "Replacement failed");
    await writeInstallation(paths.status, { phase: "completed", version: "0.3.0" });
    assert.equal(await updater.restoreInstallationResult(), true);
    assert.equal(updater.getState().phase, "install-failed", "a still-old binary must not claim success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Windows verification keeps the old program and cache without relaunching it", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-updater-failure-"));
  const run = promisify(execFile);
  const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const psArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  const installRoot = join(root, "Cleo");
  const exe = join(installRoot, "Cleo.exe");
  const paths = installationPaths(root, exe);
  const operationId = "failure-test";
  try {
    await mkdir(installRoot);
    const compile = join(root, "old.ps1");
    await writeFile(compile, `param($Exe)
Add-Type -OutputAssembly $Exe -OutputType WindowsApplication -TypeDefinition @'
using System;
using System.IO;
public class OldCleo {
    public static void Main() {
        File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "old-launched.txt"), "old");
    }
}
'@
`);
    await run(powershell, [...psArgs, "-File", compile, exe], { windowsHide: true });
    const original = await readFile(exe);
    const archive = join(root, "update.zip");
    await writeFile(archive, "unverified archive");
    const viewer = join(root, "progress.ps1");
    await writeFile(viewer, 'param($StatusPath)\n[System.IO.File]::WriteAllText("$StatusPath.window", [string]$PID)\nStart-Sleep -Seconds 1\n');
    await writeInstallation(paths.status, { operationId, phase: "starting", pid: process.pid });
    await assert.rejects(run(powershell, [...psArgs, "-File",
      fileURLToPath(new URL("../../scripts/download.ps1", import.meta.url)),
      "-PackagePath", archive, "-Sha256", "a".repeat(64), "-InstallRoot", installRoot,
      "-StatusPath", paths.status, "-OperationId", operationId, "-ProgressScript", viewer,
      "-WaitForProcessId", String(process.pid), "-RemovePackage", "-Launch", "-NoPause",
    ], { windowsHide: true, timeout: 15_000 }), /checksum mismatch/);
    assert.equal((await readInstallation(paths.status)).phase, "failed");
    assert.deepEqual(await readFile(exe), original);
    assert.equal(await readFile(archive, "utf8"), "unverified archive");
    await assert.rejects(readFile(join(installRoot, "old-launched.txt")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
