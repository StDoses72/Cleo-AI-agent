import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EvolutionManager } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";

const repository = "StDoses72/Cleo-AI-agent";
const branch = "cleo/local-fixture";
const prUrl = `https://github.com/${repository}/pull/123`;
const title = "customize agents& custom harness";
const body = "Build and tests pass.\n\nKeep literal `code` and $(text) unchanged.";

/** Purpose: Exercise submission with real Git commits and a local bare remote, without publishing.
 * Input: test context. Output: protected source, controller, and intercepted GitHub boundary calls.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cleo-submit-test-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0" };
  await writeFile(env.GIT_CONFIG_GLOBAL, "");
  const manager = new EvolutionManager({ app: { isPackaged: false, getVersion: () => "0.3.9" }, root: join(root, "controller"), dataHome: join(root, "home") });
  await mkdir(join(manager.source, "ui/electron"), { recursive: true });
  for (const name of ["bootstrap.mjs", "evolution.mjs", "evolution-store.mjs", "evolution-tools.mjs", "evolution-recovery.mjs", "evolution-launch.mjs", "evolution-progress.mjs", "evolution-handoff.mjs"]) {
    await cp(new URL(`../electron/${name}`, import.meta.url), join(manager.source, "ui/electron", name));
  }
  await writeFile(join(manager.source, "ui/package.json"), '{"main":"electron/bootstrap.mjs"}');
  await manager.saveProtection();
  const options = { cwd: manager.source, env };
  await run("git", ["init", "--initial-branch", branch], options);
  await run("git", ["add", "--all"], options);
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], options);
  await writeFile(join(manager.source, "feature.txt"), "custom harness\n");
  const remote = join(root, "fork.git");
  await run("git", ["init", "--bare", remote], { env });
  const tools = { git: "git", gh: "fixture-gh", env };
  manager.tools.prepare = async () => tools;
  const digest = await manager.sourceHash(tools);
  await manager.store.update({ prepared: true, active: "saved", builds: [{ id: "saved", kind: "local", sourceHash: digest }], pullRequest: null });
  const calls = [];
  const remotePrs = [];
  const command = async (executable, args, commandOptions) => {
    calls.push({ executable, args });
    if (executable === tools.gh) {
      if (args[0] === "auth") return "connected";
      if (args[0] === "api") return JSON.stringify({ login: "fixture-user" });
      if (args[0] === "repo") {
        // gh rejects the presence of --remote with a repository argument, even when set to false.
        if (args[2] && args.some((arg) => arg.startsWith("--remote="))) throw new Error("the `--remote` flag is unsupported when a repository argument is provided");
        assert.deepEqual(args, ["repo", "fork", repository, "--clone=false"]);
        return "https://github.com/fixture-user/Cleo-AI-agent";
      }
      assert.equal(args[0], "pr");
      if (args[1] === "list") return JSON.stringify(remotePrs.filter((pr) => pr.headRefName === args[args.indexOf("--head") + 1]));
      if (args[1] === "view") return JSON.stringify({ ...remotePrs.find((pr) => pr.url === args[2]), title,
        mergeable: "MERGEABLE", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] });
      assert.ok(["create", "edit"].includes(args[1]));
      assert.equal(args[args.indexOf("--repo") + 1], repository);
      assert.equal(args[args.indexOf("--title") + 1], title);
      assert.equal(await readFile(args[args.indexOf("--body-file") + 1], "utf8"), body);
      if (args[1] === "create") remotePrs.push({ url: `https://github.com/${repository}/pull/${123 + remotePrs.length}`, number: 123 + remotePrs.length,
        state: "OPEN", headRefName: args[args.indexOf("--head") + 1].split(":")[1], headRepositoryOwner: { login: "fixture-user" } });
      return remotePrs.at(-1).url;
    }
    if (args.includes("push")) {
      assert.equal(args.at(-2), "https://github.com/fixture-user/Cleo-AI-agent.git");
      assert.match(args.at(-1), /^[a-f0-9]{40}:refs\/heads\/codex\/pr-/);
      assert.ok(args.includes("credential.helper="));
      assert.ok(args.some((arg) => arg.includes("auth git-credential")));
      return run("git", ["push", remote, args.at(-1)], commandOptions);
    }
    return run(executable, args, commandOptions);
  };
  manager.runCommand = command;
  return { manager, root, remote, calls, command, tools, remotePrs };
}

test("submission forks noninteractively, commits, pushes the managed branch, and creates a PR", async (t) => {
  const { manager, remote, calls, tools } = await fixture(t);
  assert.equal(await manager.submitPullRequest(title, body), prUrl);
  const fork = calls.find(({ args }) => args[0] === "repo");
  assert.deepEqual(fork.args, ["repo", "fork", repository, "--clone=false"]);
  const create = calls.find(({ args }) => args[0] === "pr" && args[1] === "create");
  const publishedBranch = create.args[create.args.indexOf("--head") + 1].split(":")[1];
  assert.match(publishedBranch, /^codex\/pr-/);
  assert.equal(create.args[create.args.indexOf("--base") + 1], "main");
  assert.equal(await run("git", ["--git-dir", remote, "show", `${publishedBranch}:feature.txt`], { env: tools.env }), "custom harness");
  const receipt = (await manager.store.read()).pullRequest;
  assert.equal(receipt.url, prUrl);
  assert.equal(receipt.headRefName, publishedBranch);
  assert.equal(await run("git", ["branch", "--show-current"], { cwd: manager.source, env: tools.env }), branch);
  assert.equal(receipt.outcome, "created");
  assert.equal(manager.submission.status, "success");
});

test("the same submission ID retries safely, but a fresh request always creates another PR", async (t) => {
  const { manager, calls, command } = await fixture(t);
  const submissionId = randomUUID();
  manager.runCommand = async (executable, args, options) => {
    if (args[0] === "repo") throw new Error("temporary GitHub failure");
    return command(executable, args, options);
  };
  await assert.rejects(manager.submitPullRequest(title, body, submissionId), /temporary GitHub failure/);
  assert.equal((await manager.store.read()).pullRequest, null);
  assert.ok(!calls.some(({ args }) => args.includes("push") || args.includes("commit")));
  manager.runCommand = command;
  assert.equal(await manager.submitPullRequest(title, body, submissionId), prUrl);
  assert.equal(await manager.submitPullRequest(title, body, submissionId), prUrl);
  assert.notEqual(await manager.submitPullRequest(title, body, randomUUID()), prUrl);
  const creates = calls.filter(({ args }) => args[0] === "pr" && args[1] === "create");
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].args[creates[0].args.indexOf("--head") + 1], creates[1].args[creates[1].args.indexOf("--head") + 1]);
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
  assert.equal((await manager.store.read()).pullRequests.length, 2);
});

test("changed source or an unmanaged branch cannot be published", async (t) => {
  const { manager, calls, tools } = await fixture(t);
  await writeFile(join(manager.source, "feature.txt"), "unchecked change\n");
  await assert.rejects(manager.submitPullRequest(title, body), /完成检查和构建/);
  assert.ok(!calls.some(({ args }) => args[0] === "repo" || args.includes("push") || args[0] === "pr"));
  await writeFile(join(manager.source, "feature.txt"), "custom harness\n");
  await run("git", ["switch", "-c", "unmanaged"], { cwd: manager.source, env: tools.env });
  await assert.rejects(manager.submitPullRequest(title, body), /只能提交 Cleo 管理/);
  assert.ok(!calls.some(({ args }) => args.includes("push") || (args[0] === "pr" && args[1] !== "list")));
});

test("fork and PR arguments pass the real installed gh parser without network access", async (t) => {
  try { await run("gh", ["--version"], { timeout: 5000 }); }
  catch { t.skip("GitHub CLI is not installed; controller contract tests still run."); return; }
  const { manager, root, command } = await fixture(t);
  const parsed = [];
  manager.runCommand = async (executable, args, options) => {
    if (executable === "fixture-gh" && ["repo", "pr"].includes(args[0])) {
      const env = { ...process.env, GH_TOKEN: "fixture-token", GITHUB_TOKEN: "", GH_HOST: "github.com", GH_CONFIG_DIR: join(root, "github-config"),
        GH_PROMPT_DISABLED: "1", HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "" };
      await assert.rejects(run("gh", args, { cwd: manager.source, env, timeout: 10000 }), (error) => {
        assert.doesNotMatch(error.message, /unsupported|unknown flag|Usage:/);
        assert.match(error.message, /proxyconnect tcp.*127\.0\.0\.1:1/);
        parsed.push(args.slice(0, 2).join(" "));
        return true;
      });
    }
    return command(executable, args, options);
  };
  await manager.submitPullRequest(title, body);
  await manager.submitPullRequest(title, body);
  assert.deepEqual(parsed, ["pr list", "repo fork", "pr create", "pr list", "repo fork", "pr create"]);
});

test("even an open PR on the workspace branch is historical, never reused by a new request", async (t) => {
  const { manager, calls, remotePrs } = await fixture(t);
  await manager.store.update({ pullRequest: { url: "https://github.com/StDoses72/Cleo-AI-agent/pull/35", state: "OPEN" } });
  remotePrs.push({ url: prUrl, state: "OPEN", headRefName: branch, headRepositoryOwner: { login: "fixture-user" } });
  await manager.submitPullRequest(title, body);
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
  assert.equal((await manager.store.read()).pullRequests.length, 2);
});

test("lost creation response is reconciled without creating a duplicate", async (t) => {
  const { manager, calls, command } = await fixture(t);
  manager.runCommand = async (exe, args, opts) => {
    const result = await command(exe, args, opts);
    if (args[0] === "pr" && args[1] === "create") throw new Error("response lost");
    return result;
  };
  assert.equal(await manager.submitPullRequest(title, body), prUrl);
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
});

test("remote closure creates a new branch even when the cache still says OPEN", async (t) => {
  const { manager, remotePrs, calls } = await fixture(t);
  remotePrs.push({ url: prUrl, state: "CLOSED", headRefName: branch, headRepositoryOwner: { login: "fixture-user" } });
  await manager.store.update({ pullRequest: { url: prUrl, state: "OPEN" } });
  await manager.submitPullRequest(title, body);
  const create = calls.find(({ args }) => args[1] === "create");
  assert.match(create.args[create.args.indexOf("--head") + 1], /^fixture-user:codex\/pr-/);
  assert.ok(!calls.some(({ args }) => args[0] === "switch"));
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
});

test("successful submission and failing CI remain distinct states", async (t) => {
  const { manager } = await fixture(t);
  await manager.submitPullRequest(title, body);
  await manager.refreshPullRequest();
  assert.equal(manager.submission.status, "success");
  assert.equal((await manager.store.read()).pullRequest.checks, "failed");
});

test("publishing a later version never advances the first PR's remote ref", async (t) => {
  const { manager, remote, tools } = await fixture(t);
  await manager.submitPullRequest(title, body);
  const first = (await manager.store.read()).pullRequest;
  const gitOptions = { cwd: manager.source, env: tools.env };
  const originalCommit = await run("git", ["--git-dir", remote, "rev-parse", first.headRefName], gitOptions);
  await writeFile(join(manager.source, "feature.txt"), "second independently published version\n");
  const sourceHash = await manager.sourceHash(tools);
  await manager.store.update({ builds: [{ id: "saved", kind: "local", sourceHash }] });
  await manager.submitPullRequest(title, body);
  const second = (await manager.store.read()).pullRequest;
  assert.notEqual(first.url, second.url);
  assert.notEqual(first.headRefName, second.headRefName);
  assert.equal(await run("git", ["--git-dir", remote, "rev-parse", first.headRefName], gitOptions), originalCommit);
  assert.equal(await run("git", ["--git-dir", remote, "show", `${first.headRefName}:feature.txt`], gitOptions), "custom harness");
  assert.equal(await run("git", ["--git-dir", remote, "show", `${second.headRefName}:feature.txt`], gitOptions), "second independently published version");
});

test("response and reconciliation failure can be retried after restart without another push or PR", async (t) => {
  const { manager, calls, command, tools } = await fixture(t);
  const submissionId = randomUUID();
  let responseLost = false;
  manager.runCommand = async (exe, args, opts) => {
    if (responseLost && args[1] === "list") throw new Error("GitHub unavailable");
    const result = await command(exe, args, opts);
    if (args[1] === "create") { responseLost = true; throw new Error("response lost"); }
    return result;
  };
  await assert.rejects(manager.submitPullRequest(title, body, submissionId), /GitHub unavailable/);
  const restarted = new EvolutionManager({ app: manager.app, root: manager.store.root, dataHome: manager.store.dataHome });
  restarted.tools.prepare = async () => tools;
  restarted.runCommand = command;
  assert.equal(await restarted.submitPullRequest(title, body, submissionId), prUrl);
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
  assert.equal(calls.filter(({ args }) => args.includes("push")).length, 1);
});

test("local receipt failure keeps the pending identity for safe retry", async (t) => {
  const { manager, calls, remotePrs } = await fixture(t);
  const submissionId = randomUUID();
  const save = manager.savePullRequestReceipt.bind(manager);
  manager.savePullRequestReceipt = async () => { throw new Error("EPERM fixture"); };
  await assert.rejects(manager.submitPullRequest(title, body, submissionId), /本地回执保存失败/);
  assert.equal((await manager.store.read()).pendingPullRequests[0].id, submissionId);
  remotePrs[0].state = "CLOSED";
  manager.savePullRequestReceipt = save;
  assert.equal(await manager.submitPullRequest(title, body, submissionId), prUrl);
  assert.equal((await manager.store.read()).pullRequest.state, "CLOSED");
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
});

test("refreshing an older historical PR does not replace the latest receipt", async (t) => {
  const { manager } = await fixture(t);
  const first = await manager.submitPullRequest(title, body);
  const second = await manager.submitPullRequest(title, body);
  await manager.refreshPullRequest(first);
  const state = await manager.store.read();
  assert.equal(state.pullRequest.url, second);
  assert.equal(state.pullRequests.find((pr) => pr.url === first).checks, "failed");
  assert.equal(state.pullRequests.find((pr) => pr.url === second).checks, "pending");
});
