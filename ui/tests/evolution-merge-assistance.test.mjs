import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvolutionManager } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";
import { checkContribution, submitContribution, inspectPullRequest, contributionRepairPrompt } from "../electron/evolution-merge-assistance.mjs";

/** Purpose: Exercise real merge mechanics with isolated local remotes. Input: test context. Output: manager and moving target. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-merge-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid.test" };
  await writeFile(env.GIT_CONFIG_GLOBAL, "");
  await run("git", ["init", "--initial-branch", "cleo/test", source], { env });
  const git = (args) => run("git", args, { cwd: source, env });
  await writeFile(join(source, "shared.txt"), "original\n");
  await git(["add", "."]); await git(["commit", "-m", "common base"]);
  const ancestor = await git(["rev-parse", "HEAD"]);
  await git(["switch", "-c", "target"]);
  await writeFile(join(source, "upstream.txt"), "upstream-only content\n");
  await git(["add", "."]); await git(["commit", "-m", "target advances"]);
  let target = await git(["rev-parse", "HEAD"]);
  await git(["switch", "cleo/test"]);
  await writeFile(join(source, "new.txt"), "local feature\n");
  const calls = [];
  const hash = () => EvolutionManager.prototype.sourceHash.call({ source }, { git: "git", env });
  const state = { builds: [{ id: "selected", kind: "local", sourceHash: await hash() }], unknown: { keep: true } };
  const pr = { url: "https://github.com/StDoses72/Cleo-AI-agent/pull/49", number: 49, state: "OPEN",
    headRefName: "cleo/test", headRepository: { name: "Cleo-AI-agent" }, headRepositoryOwner: { login: "fixture" },
    headRefOid: ancestor, baseRefOid: target, baseRefName: "target", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
    viewerCanUpdateBranch: false, statusCheckRollup: [{ name: "build", conclusion: "FAILURE", status: "COMPLETED" }] };
  const manager = { source, store: { root: join(root, "controller"), read: async () => state }, tools: { prepare: async () => ({ git: "git", gh: "fixture-gh", env }) },
    operation: async (_phase, action) => action(), checkProtection: async () => {}, sourceHash: hash, log: () => {},
    submitPullRequest: async () => { calls.push("publish"); return pr.url; },
    runCommand: async (exe, args, opts) => {
      calls.push(args);
      if (exe === "fixture-gh") return JSON.stringify(args[0] === "pr" ? pr
        : args[1].includes("/branches/") ? { name: "target", commit: { sha: target } } : { permissions: { push: false } });
      if (args.includes("fetch")) args = args.map((arg) => arg.startsWith("https://github.com/") ? source : arg);
      return run(exe, args, opts);
    } };
  return { root, source, manager, state, pr, git, calls, ancestor,
    emptyTarget: async () => {
      const tree = await git(["hash-object", "-t", "tree", "-w", "--stdin"]);
      target = await git(["commit-tree", tree, "-m", "empty independent target"]);
      await git(["update-ref", "refs/heads/target", target]);
      pr.baseRefOid = target;
    },
    conflict: async () => {
      await git(["add", "."]); await git(["commit", "-m", "local feature"]);
      await git(["switch", "target"]);
      await writeFile(join(source, "shared.txt"), "upstream replacement\n");
      await git(["add", "."]); await git(["commit", "-m", "upstream replacement"]);
      target = await git(["rev-parse", "HEAD"]); pr.baseRefOid = target;
      await git(["switch", "cleo/test"]);
      await writeFile(join(source, "shared.txt"), "local replacement\n");
      state.builds[0].sourceHash = await hash();
    } };
}
const selection = { targetBranch: "target", buildId: "selected" };

test("empty target accepts the uncommitted source without touching live index or history", async (t) => {
  const f = await fixture(t);
  await f.emptyTarget();
  const before = await readFile(join(f.source, ".git/index"));
  const report = await checkContribution(f.manager, selection);
  assert.equal(report.compatible, true);
  assert.equal(report.baseSha, f.pr.baseRefOid);
  assert.equal(report.snapshotFormat, "empty-target-snapshot-v1");
  assert.equal(report.fileCount, 2);
  assert.deepEqual(await readFile(join(f.source, ".git/index")), before);
  assert.equal(await f.git(["rev-parse", "HEAD"]), f.ancestor);
  assert.equal(await submitContribution(f.manager, "title", "body", "intent", selection), f.pr.url);
  assert.equal(f.calls.filter((call) => call === "publish").length, 1);
});

test("existing target files block snapshot preparation without changing source", async (t) => {
  const f = await fixture(t);
  const before = await f.git(["status", "--porcelain"]);
  await assert.rejects(checkContribution(f.manager, selection), /不是空分支/);
  assert.ok(!f.calls.includes("publish"));
  assert.equal(await f.git(["status", "--porcelain"]), before);
});

test("unknown target SHA and invalid selection fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(checkContribution(f.manager, { ...selection, targetBranch: "main" }), /main/);
  await assert.rejects(checkContribution(f.manager, { ...selection, buildId: "missing" }), /检查和构建/);
  const command = f.manager.runCommand;
  f.manager.runCommand = (exe, args, opts) => exe === "fixture-gh" ? Promise.resolve('{"name":"target"}') : command(exe, args, opts);
  await assert.rejects(checkContribution(f.manager, selection), /无法读取目标分支提交/);
  assert.ok(!f.calls.includes("publish"));
});

test("PR helper distinguishes clean merge from failed checks and missing permission without writes", async (t) => {
  const f = await fixture(t);
  const before = JSON.stringify(f.state);
  const report = await inspectPullRequest(f.manager, f.pr.url);
  assert.equal(report.compatible, true);
  assert.equal(report.canUpdate, false);
  assert.equal(report.checks[0].conclusion, "FAILURE");
  assert.equal(report.mergeStateStatus, "BLOCKED");
  assert.equal(JSON.stringify(f.state), before);
  assert.ok(!f.calls.some((args) => Array.isArray(args) && (args.includes("push") || args.includes("merge"))));
});

test("repair rereads remote refs, retains original PR identity, and prohibits final merge", async (t) => {
  const f = await fixture(t);
  const first = await contributionRepairPrompt(f.manager, { url: f.pr.url });
  assert.match(first, /原 PR.*pull\/49/);
  assert.match(first, /不得执行最终合并/);
  await f.conflict();
  const second = await contributionRepairPrompt(f.manager, { url: f.pr.url });
  assert.ok(second.includes(f.pr.baseRefOid));
  assert.notEqual(first, second);
  f.pr.state = "CLOSED";
  await assert.rejects(contributionRepairPrompt(f.manager, { url: f.pr.url }), /已关闭或合并/);
});

test("network errors remain visible and never claim local compatibility", async (t) => {
  const f = await fixture(t);
  const command = f.manager.runCommand;
  f.manager.runCommand = (exe, args, opts) => args.includes("fetch") ? Promise.reject(new Error("permission denied")) : command(exe, args, opts);
  const report = await inspectPullRequest(f.manager, f.pr.url);
  assert.match(report.probeError, /permission denied/);
  assert.equal(report.compatible, undefined);
  await assert.rejects(checkContribution(f.manager, selection), /permission denied/);
  assert.ok(!f.calls.includes("publish"));
});

test("completed retries delegate receipt validation without another network probe", async (t) => {
  const f = await fixture(t);
  f.state.pullRequests = [{ submissionId: "done" }];
  f.manager.runCommand = () => { throw new Error("must not probe completed receipt"); };
  assert.equal(await submitContribution(f.manager, "title", "body", "done", selection), f.pr.url);
});

test("an independent empty target needs no common developer history", async (t) => {
  const f = await fixture(t);
  await f.emptyTarget();
  const command = f.manager.runCommand;
  f.manager.runCommand = (exe, args, opts) => args.includes("merge-base")
    ? Promise.reject(new Error("no common ancestor")) : command(exe, args, opts);
  assert.equal((await checkContribution(f.manager, selection)).compatible, true);
  assert.ok(!f.calls.includes("publish"));
});

test("tracked files remain in the snapshot even when later ignored", async (t) => {
  const f = await fixture(t);
  await f.emptyTarget();
  await writeFile(join(f.source, "shared.txt"), "original\n");
  await writeFile(join(f.source, ".gitignore"), "shared.txt\n");
  f.state.builds[0].sourceHash = await f.manager.sourceHash();
  assert.equal((await checkContribution(f.manager, selection)).compatible, true);
});

test("legacy receipts cannot bypass empty target checks", async (t) => {
  const f = await fixture(t);
  f.state.pullRequests = [{ url: f.pr.url }];
  await f.conflict();
  await assert.rejects(checkContribution(f.manager, selection), /不是空分支/);
  assert.ok(!f.calls.includes("publish"));
});

test("snapshot failure identifies the rejected path and the stage before any publish", async (t) => {
  const f = await fixture(t);
  await f.emptyTarget();
  const before = await f.git(["status", "--porcelain"]);
  const command = f.manager.runCommand;
  const invalid = "../outside.txt";
  f.manager.runCommand = (exe, args, opts) => args[0] === "ls-files" && args.includes("--cached")
    ? Promise.resolve(`${invalid}\0`) : command(exe, args, opts);
  await assert.rejects(checkContribution(f.manager, selection), (error) => {
    assert.match(error.message, /快照导出/);
    assert.ok(error.message.includes(JSON.stringify(invalid)));
    assert.match(error.message, /未推送/);
    return true;
  });
  assert.equal(await f.git(["status", "--porcelain"]), before);
  assert.ok(!f.calls.includes("publish"));
});

test("Git enumeration diagnostics are reported instead of being mistaken for source paths", async (t) => {
  const f = await fixture(t);
  await f.emptyTarget();
  const command = f.manager.runCommand;
  const warning = "warning: could not open directory 'tests/long-path/': Filename too long\n";
  f.manager.runCommand = (exe, args, opts) => args[0] === "ls-files" && args.includes("--cached")
    ? run(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(warning)}); process.stdout.write('shared.txt\\0');`], opts)
    : command(exe, args, opts);
  await assert.rejects(checkContribution(f.manager, selection), (error) => {
    assert.match(error.message, /命令返回诊断/);
    assert.match(error.message, /Filename too long/);
    return true;
  });
  assert.ok(!f.calls.includes("publish"));
});
