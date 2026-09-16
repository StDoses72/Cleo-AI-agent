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
  manager.tools.prepareGithub = manager.tools.prepare;
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

test("a missing GitHub executable reports a CLI failure rather than unknown credentials", async t => {
  const { manager } = await fixture(t);
  manager.runCommand = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
  await manager.login();
  assert.equal(manager.githubAuth.status, "failed");
  assert.equal(manager.githubAuth.reason, "cli");
});

test("device code streams before completion, opens only GitHub, and is never persisted", async (t) => {
  const { manager, root, opened } = await fixture(t);
  let complete;
  const ready = Promise.withResolvers();
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") { if (complete) return "authenticated"; throw new Error("not logged in"); }
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
    if (args[1] === "status") { if (attempts === 2) return "authenticated"; throw new Error("not logged in"); }
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
    if (args[1] === "status") { if (complete) return "authenticated"; throw new Error("not logged in"); }
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

for (const [name, chunks] of [
  ["plain", ["! First copy your one-time code: AB12-CD34\n"]],
  ["clipboard", ["! One-time code (AB12-CD34) copied to clipboard\n"]],
  ["clipboard ANSI and split chunks", ["! One-time co", "de (\u001b[1mAB12-", "CD34\u001b[0m) copied to clip", "board\r\n"]],
  ["clipboard lowercase", ["! One-time code (ab12-cd34) copied to clipboard\n"]],
  ["clipboard unavailable falls back to plain", ["! Failed to copy one-time code to clipboard\n", "! First copy your one-time code: AB12-CD34\n"]],
]) {
  test(`CLI output compatibility: ${name}`, async (t) => {
    const { manager, root, opened } = await fixture(t);
    const states = [];
    let authenticated = false;
    manager.onState = () => { if (manager.githubAuth) states.push({ ...manager.githubAuth }); };
    manager.runCommand = async (_command, args, options) => {
      if (args[1] === "status") { if (authenticated) return "authenticated"; throw new Error("not logged in"); }
      for (const chunk of chunks) options.log(chunk);
      // Repeated CLI output must not reopen the browser.
      for (const chunk of chunks) options.log(chunk);
      authenticated = true;
    };
    await manager.login();
    assert.ok(states.some(state => state.status === "waiting" && state.code === "AB12-CD34"));
    assert.deepEqual(opened, ["https://github.com/login/device"]);
    assert.equal(manager.githubAuth.status, "connected");
    assert.ok(!manager.logs.includes("AB12-CD34"));
    assert.ok(!(await readFile(join(root, "state.json"), "utf8")).includes("AB12-CD34"));
  });
}

test("older CLI without --active can validate an existing login without starting OAuth", async (t) => {
  const { manager, opened } = await fixture(t);
  const calls = [];
  manager.runCommand = async (_command, args) => {
    calls.push(args);
    if (args.includes("--active")) throw new Error("gh failed (1)\nunknown flag: --active");
    assert.equal(args[1], "status", "Existing authentication must not be replaced with a new login");
    return "authenticated";
  };
  await manager.login();
  assert.equal(manager.githubAuth.status, "connected");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["auth", "status", "--hostname", "github.com"]);
  assert.deepEqual(opened, []);
});

test("unrecognized or malformed code output never opens an arbitrary URL or reports connected on failure", async (t) => {
  const { manager, opened } = await fixture(t);
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    options.log("diagnostic AB12-CD34; Open this URL: https://untrusted.invalid/login\n");
    options.log("one-time code: AB12-CD345\none-time code (AB12-CD345) copied to clipboard\n");
    throw new Error("unsupported output");
  };
  await manager.login();
  assert.deepEqual(opened, []);
  assert.equal(manager.githubAuth.status, "failed");
  assert.equal(manager.githubAuth.code, undefined);
});

test("a CLI success without usable saved credentials is not reported as connected", async (t) => {
  const { manager } = await fixture(t);
  let checks = 0;
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") { checks++; throw new Error("not logged in"); }
    options.log("First copy your one-time code: AB12-CD34\nAuthentication complete.\n");
  };
  await manager.login();
  assert.ok(checks >= 2, "Login must independently verify saved credentials");
  assert.equal(manager.githubAuth.status, "failed");
  assert.equal(manager.githubAuth.reason, "credentials");
  assert.doesNotMatch(manager.githubAuth.message, /终端|GH_TOKEN|下载 GitHub CLI/);
});

test("a late CLI error is reconciled against usable credentials, without a second authorization", async (t) => {
  const { manager, opened } = await fixture(t);
  let checks = 0;
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") {
      if (++checks === 1) throw new Error("not logged in");
      return "authenticated";
    }
    options.log("First copy your one-time code: AB12-CD34\nAuthentication complete.\n");
    throw new Error("failed to configure git credential helper");
  };
  await manager.login();
  assert.equal(manager.githubAuth.status, "connected");
  assert.equal(opened.length, 1);
});

test("credential storage failure is distinct from network failure and leaks no credentials", async (t) => {
  const { manager, root } = await fixture(t);
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    options.log("First copy your one-time code: AB12-CD34\nAuthentication complete.\n");
    throw new Error("keychain write failed: permission denied; oauth_token=gho_FAKE_TEST_SECRET");
  };
  await manager.login();
  assert.equal(manager.githubAuth.reason, "storage");
  assert.match(manager.githubAuth.message, /保存|钥匙串/);
  assert.ok(!JSON.stringify(manager.githubAuth).includes("FAKE_TEST_SECRET"));
  assert.ok(!manager.logs.includes("FAKE_TEST_SECRET"));
  assert.ok(!(await readFile(join(root, "state.json"), "utf8")).includes("FAKE_TEST_SECRET"));
});

test("an HTTP error after device authorization retains a safe actionable diagnosis", async (t) => {
  const { manager } = await fixture(t);
  manager.runCommand = async (_command, args, options) => {
    if (args[1] === "status") throw new Error("not logged in");
    options.log("First copy your one-time code: AB12-CD34\n");
    throw new Error("failed to authenticate via web browser: HTTP 401: Bad credentials (https://api.github.com/user?access_token=SECRET)");
  };
  await manager.login();
  assert.equal(manager.githubAuth.reason, "credentials");
  assert.match(manager.githubAuth.diagnostic, /401/);
  assert.ok(!JSON.stringify(manager.githubAuth).includes("SECRET"));
});
