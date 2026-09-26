import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubReleaseDriver, setReleaseVersion, redactReleaseLog } from "../electron/release-driver.mjs";

const commit = "a".repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-release-driver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const job = { id: "12345678-1234-1234-1234-123456789012", commit, login: "owner", tag: "v0.4.8",
    branch: "codex/own-release", title: "v0.4.8", body: "", prerelease: false, attempt: 1 };
  const requests = [], runs = [];
  const remote = { runs, requests, login: "owner", changes: "", names: "", attempt: 1, head: commit, git: [] };
  const driver = new GithubReleaseDriver({ store: { root }, tools: { prepare: async () => ({ gh: "gh", git: "git", env: {} }) } }, {
    runtime: async () => ({}), repair: async () => { remote.repairs = (remote.repairs || 0) + 1; },
    runCommand: async (tool, args) => {
      if (tool === "git") {
        remote.git.push(args);
        if (args.includes("rev-parse")) return remote.head;
        if (args.includes("rev-list")) return `${remote.head} ${commit}`;
        if (args.includes("status")) return remote.changes;
        if (args.includes("diff")) return remote.names;
        return "";
      }
      if (args[0] === "run") return "compiler failed";
      if (args.includes("POST")) {
        requests.push({ path: args[3], payload: JSON.parse(await readFile(args.at(-1), "utf8")) });
        return "";
      }
      const path = args[1];
      if (path === "user") return JSON.stringify({ login: remote.login });
      if (path.includes("/workflows/")) return JSON.stringify({ workflow_runs: runs });
      if (path.endsWith("/jobs?per_page=100")) return JSON.stringify({ jobs: [{ conclusion: "success" }, { conclusion: null }] });
      if (path.includes("/actions/runs/")) return JSON.stringify(runs.find(run => path.endsWith(`/${run.id}`)));
      throw new Error(`Unexpected API: ${path}`);
    },
  });
  await mkdir(driver.directory(job), { recursive: true });
  return { driver, job, remote, checkpoint: async values => Object.assign(job, values) };
}

test("dispatch is journaled once; restart reconciles the same branch and commit", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  assert.equal((await driver.poll(job, false, undefined, checkpoint)).status, "running");
  assert.equal(remote.requests.length, 1);
  assert.equal(remote.requests[0].payload.ref, job.branch);
  await driver.poll(job, false, undefined, checkpoint);
  assert.equal(remote.requests.length, 1);
  remote.runs.push({ id: 42, head_sha: commit, head_branch: job.branch, event: "workflow_dispatch",
    status: "completed", conclusion: "success", html_url: "https://example.test/42" });
  assert.equal((await driver.poll(job, false, undefined, checkpoint)).status, "success");
  assert.equal(job.buildRunId, "42");
});

test("another branch cannot be mistaken for this release even when SHA matches", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  remote.runs.push({ id: 42, head_sha: commit, head_branch: "someone-else", event: "workflow_dispatch", status: "completed", conclusion: "success" });
  assert.equal((await driver.poll(job, false, undefined, checkpoint)).status, "running");
  assert.equal(job.buildRunId, undefined);
  assert.equal(remote.requests.length, 1);
});

test("publish dispatch keeps notes and build identity and never publishes inline", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  Object.assign(job, { releaseUrl: "https://example.test/draft", buildRunId: "42" });
  await driver.poll(job, true, undefined, checkpoint);
  assert.deepEqual(remote.requests[0].payload, { ref: "v0.4.8", inputs: { run_id: "42", tag: "v0.4.8",
    title: "v0.4.8", notes: "", prerelease: "false", allow_existing_release: "true" } });
});

test("transient failure repairs and retries without consuming another attempt while GitHub queues", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  Object.assign(job, { buildRunId: "42", repairPhase: "building", diagnostics: "network" });
  remote.runs.push({ id: 42, head_sha: commit, event: "workflow_dispatch", status: "completed", conclusion: "failure", run_attempt: 1 });
  await driver.repair(job, undefined, checkpoint);
  assert.equal(remote.repairs, 1);
  assert.equal(job.retryRun.attempt, 2);
  assert.equal((await driver.poll(job, false, undefined, checkpoint)).status, "running");
  await driver.repair(job, undefined, checkpoint);
  assert.equal(remote.repairs, 1);
  assert.equal(remote.requests.length, 1);
});

test("account change pauses before any remote writes", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  remote.login = "different";
  await assert.rejects(driver.poll(job, false, undefined, checkpoint), /账号已变化/);
  assert.equal(remote.requests.length, 0);
});

test("restart after repair commit adopts the existing child and retries only its push", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  Object.assign(job, { repairPhase: "building", repairCommitBase: commit, buildRunId: "old-run" });
  remote.head = "b".repeat(40);
  const result = await driver.repair(job, undefined, checkpoint);
  assert.equal(result.changed, true);
  assert.equal(job.commit, remote.head);
  assert.equal(job.buildRunId, null);
  assert.equal(remote.repairs, undefined);
  assert.equal(remote.git.filter(args => args.includes("commit")).length, 0);
  assert.equal(remote.git.filter(args => args.includes("push")).length, 1);
  await driver.repair(job, undefined, checkpoint);
  assert.equal(remote.repairs, undefined);
  assert.equal(remote.git.filter(args => args.includes("push")).length, 2);
});

test("protected workflow edits from the harness are retained but never committed or pushed", async t => {
  const { driver, job, remote, checkpoint } = await fixture(t);
  job.repairPhase = "building";
  remote.changes = "M .github/workflows/desktop-platforms.yml";
  remote.names = ".github/workflows/desktop-platforms.yml";
  await assert.rejects(driver.repair(job, undefined, checkpoint), /人工核对/);
  assert.equal(remote.requests.length, 0);
});

test("version preparation synchronizes project, UI and lockfile without changing dependencies", async t => {
  const { driver, job } = await fixture(t);
  const source = driver.directory(job);
  await mkdir(join(source, "ui"));
  await writeFile(join(source, "pyproject.toml"), '[build-system]\nrequires = []\n[project]\nname = "cleo"\nversion = "0.4.7"\n[tool.ruff]\nline-length = 100\n');
  const pkg = { name: "cleo", version: "0.4.7", packages: { "": { version: "0.4.7" }, dep: { version: "1" } } };
  for (const name of ["package.json", "package-lock.json"]) await writeFile(join(source, "ui", name), JSON.stringify(pkg));
  await setReleaseVersion(source, "0.4.8");
  assert.match(await readFile(join(source, "pyproject.toml"), "utf8"), /version = "0.4.8"/);
  const lock = JSON.parse(await readFile(join(source, "ui/package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.4.8"); assert.equal(lock.packages[""].version, "0.4.8");
  assert.equal(lock.packages.dep.version, "1");
});

test("logs redact GitHub authentication before persistence or harness input", () => {
  assert.equal(redactReleaseLog("ghp_secret github_pat_hidden Authorization: Bearer abc"),
    "[redacted] [redacted] Authorization: Bearer [redacted]");
});
