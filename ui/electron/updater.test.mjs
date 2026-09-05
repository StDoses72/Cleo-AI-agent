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

import { compareVersions, DesktopUpdater, validateManifest } from "./updater.mjs";

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

async function readyUpdater(root, spawnImpl, quit) {
  const resourcesPath = join(root, "Installed Cleo", "resources");
  const stagingRoot = join(root, "Downloaded update");
  await mkdir(resourcesPath, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await writeFile(join(resourcesPath, "update.ps1"), "# installer fixture\n");
  const updater = new DesktopUpdater({
    app: { isPackaged: true, getVersion: () => "0.1.0", quit },
    resourcesPath,
    executablePath: join(root, "Installed Cleo", "Cleo.exe"),
    spawnImpl,
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
  app: { isPackaged: true, getVersion: () => "0.1.0", quit: () => process.exit(0) },
  resourcesPath: ${JSON.stringify(resourcesPath)},
  executablePath: ${JSON.stringify(join(installRoot, "Cleo.exe"))},
});
updater.manifest = validateManifest(${JSON.stringify(release)});
updater.archivePath = ${JSON.stringify(archivePath)};
updater.setState({ phase: "ready" });
await updater.install();
`);
    await run(process.execPath, [harnessPath], { cwd: installRoot, windowsHide: true, timeout: 15_000 });
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
    await assert.rejects(readFile(join(installRoot, "obsolete.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(archivePath), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "user-data.json"), "utf8"), "preserve local data");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
