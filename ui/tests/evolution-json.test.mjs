import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readJson, writeJson } from "../electron/evolution-store.mjs";

/** Purpose: Isolate persistence checks. Input: test context. Output: an owned, cleaned JSON path. */
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "cleo-json-test-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const path = join(root, "requests-v1.json");
  await writeJson(path, { value: "original" });
  return { path, root };
}

/** Purpose: Reproduce Windows replacement denial with a real external handle.
 * Input: JSON path. Output: a child holding the file until its stdin closes.
 */
async function lockFile(path) {
  const script = '$h=[IO.File]::Open($env:CLEO_LOCK_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try {[Console]::WriteLine("locked"); [Console]::ReadLine() | Out-Null} finally {$h.Dispose()}';
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...process.env, CLEO_LOCK_TEST_FILE: path }, stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const ready = new Promise((done, reject) => {
    child.once("error", reject);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("locked")) done(); });
    child.once("exit", (code) => reject(new Error(`Lock holder exited: ${code}`)));
  });
  await ready;
  return async () => { child.stdin.end("\n"); await exited; };
}

test("Windows transient file lock is retried without losing the saved record", { skip: process.platform !== "win32" }, async (t) => {
  const { path, root } = await fixture(t);
  const unlock = await lockFile(path);
  const release = new Promise((done) => setTimeout(() => done(unlock()), 150));
  try { await writeJson(path, { value: "updated" }); }
  finally { await release; }
  assert.deepEqual(await readJson(path), { value: "updated" });
  assert.deepEqual(await fs.readdir(root), ["requests-v1.json"]);
});

test("permanent rename denial is bounded, preserves old data and removes its temporary file", async (t) => {
  const { path, root } = await fixture(t);
  let attempts = 0;
  t.mock.method(fs, "rename", async () => { attempts++; throw Object.assign(new Error("locked"), { code: "EPERM" }); });
  await assert.rejects(writeJson(path, { value: "rejected" }), { code: "EPERM" });
  assert.ok(attempts > 1 && attempts <= 10);
  assert.deepEqual(await readJson(path), { value: "original" });
  assert.deepEqual(await fs.readdir(root), ["requests-v1.json"]);
});

test("unrelated failures are not retried and cannot poison later writes", async (t) => {
  const { path, root } = await fixture(t);
  const rename = fs.rename;
  let attempts = 0;
  const mock = t.mock.method(fs, "rename", async () => { attempts++; throw Object.assign(new Error("disk"), { code: "ENOSPC" }); });
  await assert.rejects(writeJson(path, { value: "rejected" }), { code: "ENOSPC" });
  assert.equal(attempts, 1);
  mock.mock.restore();
  assert.equal(fs.rename, rename);
  await writeJson(path, { value: "recovered" });
  assert.deepEqual(await readJson(path), { value: "recovered" });
  assert.deepEqual(await fs.readdir(root), ["requests-v1.json"]);
});

test("overlapping reads and writes observe complete records in call order", async (t) => {
  const { path } = await fixture(t);
  const operations = [];
  for (let index = 0; index < 30; index++) {
    operations.push(writeJson(path, { index }));
    operations.push(readJson(path).then((data) => assert.equal(data.index, index)));
  }
  await Promise.all(operations);
});
