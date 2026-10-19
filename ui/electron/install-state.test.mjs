import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSingleInstance, executableInUse, processIsAlive } from "./install-state.mjs";

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

test("the running process is alive and an impossible pid is not", () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(-1), false);
});

test("an executable image is in use only while a process holds it open for execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "cleo-image-probe-"));
  try {
    const path = join(root, "Cleo.exe");
    await writeFile(path, "not running");
    assert.equal(await executableInUse(path), false);
    assert.equal(await executableInUse(join(root, "missing.exe")), false);
    const locked = { open: async () => { throw Object.assign(new Error("sharing violation"), { code: "EBUSY" }); } };
    assert.equal(await executableInUse(path, locked), true);
    const broken = { open: async () => { throw Object.assign(new Error("disk"), { code: "EIO" }); } };
    await assert.rejects(executableInUse(path, broken), /disk/);
    if (process.platform === "win32") {
      // The current Node image is mapped by this very process: Windows refuses write access to it.
      assert.equal(await executableInUse(process.execPath), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
