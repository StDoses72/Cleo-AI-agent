import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionManager } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";

/** Purpose: Exercise the real login state machine without accounts or browser side effects.
 * Input: test context and browser stub. Output: isolated controller and captured official URLs.
 */
async function fixture(t, browser) {
  const root = await mkdtemp(join(tmpdir(), "cleo-github-test-"));
  const opened = [];
  const manager = new EvolutionManager({ app: { isPackaged: false, getVersion: () => "0.3.9" },
    root, dataHome: join(root, "home"), openExternal: browser || (async (url) => { opened.push(url); }) });
  manager.tools.prepare = async () => ({ gh: "fixture-gh", env: process.env });
  await mkdir(join(root, "builds"));
  await manager.store.update({ prepared: true, iteration: { base: "base" }, draftDirty: false });
  await manager.recordValidation({ status: "passed", candidate: "candidate", sourceHash: "source", message: "检查通过" });
  t.after(async () => {
    await manager.cancelLogin();
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { manager, root, opened };
}

test("device code streams before completion, opens only GitHub, and is never persisted", async (t) => {
  const { manager, root, opened } = await fixture(t);
  let complete;
  const ready = Promise.withResolvers();
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    options.log("! First copy your one-time co");
    options.log("de: \u001b[1mAB12-");
    options.log("CD34\u001b[0m\nOpen this URL: https://untrusted.invalid/login\n");
    ready.resolve();
    await new Promise((done) => { complete = done; });
  };
  const pending = manager.login();
  await ready.promise;
  assert.equal(manager.phase, "authenticating");
  assert.equal((await manager.status()).githubAuth.code, "AB12-CD34");
  assert.deepEqual(opened, ["https://github.com/login/device"]);
  assert.ok(!manager.logs.includes("AB12-CD34"));
  assert.ok(!(await readFile(join(root, "state.json"), "utf8")).includes("AB12-CD34"));
  complete();
  await pending;
  assert.deepEqual(manager.githubAuth, { status: "connected", message: "GitHub 已连接，可以继续提交 PR。" });
  assert.equal(manager.phase, "idle");
  assert.equal((await manager.status()).validation.status, "passed");
});

test("expired login clears the old code and retries without changing build validation", async (t) => {
  const { manager, opened } = await fixture(t);
  let attempts = 0;
  const codes = [];
  manager.onState = () => { if (manager.githubAuth?.code) codes.push(manager.githubAuth.code); };
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    attempts += 1;
    options.log(`First copy your one-time code: ${attempts === 1 ? "AB12-CD34" : "EF56-GH78"}\n`);
    if (attempts === 1) throw new Error("failed to authenticate via web browser: context deadline exceeded");
  };
  await manager.login();
  assert.equal(manager.githubAuth.status, "failed");
  assert.match(manager.githubAuth.message, /超时/);
  assert.equal(manager.githubAuth.code, undefined);
  assert.equal(manager.error, null);
  assert.equal((await manager.status()).validation.status, "passed");
  await manager.login();
  assert.equal(manager.githubAuth.status, "connected");
  assert.ok(codes.includes("AB12-CD34") && codes.includes("EF56-GH78"));
  assert.equal(opened.length, 2);
});

test("browser failures retain a usable code and cannot overwrite completed authorization", async (t) => {
  let failBrowser;
  const { manager } = await fixture(t, () => new Promise((_, reject) => { failBrowser = reject; }));
  let complete;
  const ready = Promise.withResolvers();
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    options.log("First copy your one-time code: AB12-CD34\n");
    ready.resolve();
    await new Promise((done) => { complete = done; });
  };
  const pending = manager.login();
  await ready.promise;
  failBrowser(new Error("browser unavailable"));
  await new Promise((done) => setImmediate(done));
  assert.equal(manager.githubAuth.code, "AB12-CD34");
  assert.match(manager.githubAuth.browserError, /手动访问 github.com/);
  const reopening = manager.openGithubLogin();
  complete(); await pending;
  failBrowser(new Error("late browser error")); await reopening;
  assert.equal(manager.githubAuth.status, "connected");
  assert.equal(manager.githubAuth.browserError, undefined);
});

test("cancellation stops the real polling subprocess and allows another login", async (t) => {
  const { manager } = await fixture(t);
  const ready = Promise.withResolvers();
  let childPid;
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    return run(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], {
      ...options, log: (text) => { childPid = Number(text.trim()); ready.resolve(); },
    });
  };
  const pending = manager.login();
  await ready.promise;
  await manager.cancelLogin(); await pending;
  assert.equal(manager.githubAuth.status, "cancelled");
  assert.equal(manager.githubAuth.code, undefined);
  assert.equal(manager.phase, "idle");
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  manager.runCommand = async () => "already connected";
  await manager.login();
  assert.equal(manager.githubAuth.status, "connected");
});

test("an authenticated account needs no new device code or browser", async (t) => {
  const { manager, opened } = await fixture(t);
  const calls = [];
  manager.runCommand = async (_command, args) => { calls.push(args); return "authenticated"; };
  await manager.login();
  assert.deepEqual(calls, [["auth", "status", "--hostname", "github.com", "--active"]]);
  assert.equal(manager.githubAuth.status, "connected");
  assert.deepEqual(opened, []);
});
