import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseJobs } from "../electron/release-jobs.mjs";

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "cleo-release-jobs-test-"));
  const calls = [];
  const driver = {
    authorize: async params => ({ ...params, runtime: { provider: "codex" } }),
    prepare: async () => { calls.push("prepare"); return { commit: "a".repeat(40) }; },
    poll: async (_job, publish) => { calls.push(publish ? "publish" : "build"); return { status: "success" }; },
    verify: async () => { calls.push("verify"); return { releaseUrl: "https://example.test/release" }; },
    repair: async () => { calls.push("repair"); return { changed: true }; },
  };
  const jobs = new ReleaseJobs(root, driver, { interval: 1 });
  try { await action({ root, driver, jobs, calls }); }
  finally { await jobs.close(); await rm(root, { recursive: true, force: true }); }
}

test("one click builds, verifies and publishes outside the initiating request", () => fixture(async ({ jobs, calls }) => {
  const accepted = await jobs.start({ tag: "v0.4.8", url: "pr" });
  assert.equal(accepted.phase, "preparing");
  await jobs.pending;
  assert.deepEqual(calls, ["prepare", "build", "publish", "verify"]);
  assert.equal((await jobs.status()).phase, "completed");
}));

test("failed build invokes the harness, rebuilds, then publishes", () => fixture(async ({ jobs, driver, calls }) => {
  const poll = driver.poll; let fail = true;
  driver.poll = async (...args) => {
    if (fail) { fail = false; return { status: "failure", diagnostics: "test failure" }; }
    return poll(...args);
  };
  await jobs.start({ tag: "v0.4.8", url: "pr" }); await jobs.pending;
  assert.deepEqual(calls, ["prepare", "repair", "build", "publish", "verify"]);
  assert.equal((await jobs.status()).attempt, 1);
}));

test("a failed verification never reports release completion", () => fixture(async ({ jobs, driver }) => {
  driver.verify = async () => { throw new Error("missing platform manifest"); };
  await jobs.start({ tag: "v0.4.8", url: "pr" }); await jobs.pending;
  assert.equal((await jobs.status()).phase, "failed");
  assert.match((await jobs.status()).error, /missing/);
  const id = (await jobs.status()).id;
  await assert.rejects(jobs.start({ tag: "v0.4.9", url: "pr" }), /上一发布任务/);
  assert.equal((await jobs.status()).id, id, "An unresolved remote run must remain recoverable");
}));

test("repair retries are bounded and never publish a failing build", () => fixture(async ({ jobs, driver, calls }) => {
  driver.poll = async () => ({ status: "failure", diagnostics: "still failing" });
  await jobs.start({ tag: "v0.4.8", url: "pr" }); await jobs.pending;
  assert.equal(calls.filter(c => c === "repair").length, 3);
  assert.equal((await jobs.status()).phase, "failed");
}));

test("close and restart resume the same authorized job without preparing twice", () => fixture(async ({ jobs, root, driver, calls }) => {
  let polled; const reached = new Promise(resolve => { polled = resolve; });
  driver.poll = async () => { polled(); return { status: "running" }; };
  await jobs.start({ tag: "v0.4.8", url: "pr" }); await reached;
  const id = (await jobs.status()).id;
  await jobs.close();
  const next = new ReleaseJobs(root, { ...driver, poll: async () => ({ status: "success" }) }, { interval: 1 });
  await next.resume(); await next.pending;
  assert.equal((await next.status()).id, id);
  assert.equal(calls.filter(c => c === "prepare").length, 1);
  assert.equal((await next.status()).phase, "completed");
}));
