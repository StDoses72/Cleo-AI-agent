import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  acquireSingleInstance, installationPaths, interceptUpdateStartup,
  readInstallation, writeInstallation,
} from "./install-state.mjs";

test("manual launch is intercepted during extraction and signals the progress window", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-update-guard-"));
  try {
    const paths = installationPaths(root, join(root, "Cleo", "Cleo.exe"));
    await writeInstallation(paths.status, { phase: "extracting", pid: 42, processStartTime: "test" });
    assert.equal(await interceptUpdateStartup(paths, (pid) => pid === 42 ? "test" : null), true);
    assert.match(await readFile(paths.attention, "utf8"), /^\d+$/);
    assert.equal((await readInstallation(paths.status)).phase, "extracting");
    const other = installationPaths(root, join(root, "Other", "Cleo.exe"));
    assert.equal(await interceptUpdateStartup(other, () => true), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed installer does not leave a permanent startup lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-update-recovery-"));
  try {
    const paths = installationPaths(root, join(root, "Cleo.exe"));
    await writeInstallation(paths.status, { phase: "replacing", pid: 42, processStartTime: "test" });
    assert.equal(await interceptUpdateStartup(paths, () => "reused-pid"), false);
    assert.equal((await readInstallation(paths.status)).phase, "failed");
    await writeInstallation(paths.status, { phase: "completed", pid: 42 });
    assert.equal(await interceptUpdateStartup(paths, () => true), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second normal launch focuses the existing window", () => {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  const calls = [];
  const window = {
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => calls.push("restore"), show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  assert.equal(acquireSingleInstance(app, () => [window]), true);
  app.emit("second-instance");
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  app.requestSingleInstanceLock = () => false;
  assert.equal(acquireSingleInstance(app, () => []), false);
});

test("an installation completing during the startup probe is not marked failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-update-race-"));
  const paths = installationPaths(root, join(root, "Cleo.exe"));
  try {
    await writeInstallation(paths.status, { phase: "replacing", pid: 42, processStartTime: "test" });
    assert.equal(await interceptUpdateStartup(paths, async () => {
      await writeInstallation(paths.status, { phase: "completed", version: "0.2.7", pid: 42 });
      return null;
    }), false);
    assert.equal((await readInstallation(paths.status)).phase, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the standalone Windows progress window displays and closes on success", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-update-window-"));
  const paths = installationPaths(root, join(root, "Cleo.exe"));
  try {
    await writeInstallation(paths.status, {
      phase: "completed", version: "0.2.7", pid: process.pid, installRoot: root,
    });
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await promisify(execFile)(powershell, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", fileURLToPath(new URL("../../scripts/update-progress.ps1", import.meta.url)),
      "-StatusPath", paths.status,
    ], { windowsHide: true, timeout: 15_000 });
    assert.match(await readFile(`${paths.status}.window`, "utf8"), /^\d+$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a previous Windows progress window closes when a retry takes ownership", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-update-window-retry-"));
  const paths = installationPaths(root, join(root, "Cleo.exe"));
  try {
    await writeInstallation(paths.status, {
      operationId: "first", phase: "verifying", version: "0.2.7", pid: process.pid, installRoot: root,
    });
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const running = promisify(execFile)(powershell, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
      "-File", fileURLToPath(new URL("../../scripts/update-progress.ps1", import.meta.url)),
      "-StatusPath", paths.status,
    ], { windowsHide: true, timeout: 15_000 });
    const ready = `${paths.status}.window`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await readFile(ready); break; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await readFile(ready);
    await writeInstallation(paths.status, {
      operationId: "retry", phase: "verifying", pid: process.pid, installRoot: root,
    });
    await running;
    assert.equal((await readInstallation(paths.status)).operationId, "retry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
