import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EvolutionManager } from "../electron/evolution.mjs";
import { run } from "../electron/evolution-tools.mjs";
import { listContributionBranches, requestTargetBranch, refreshTargetBranch } from "../electron/evolution-contributions.mjs";
import { createContributionSnapshot, removeContributionSnapshot } from "../electron/evolution-snapshot.mjs";

const repository = "StDoses72/Cleo-AI-agent";
const branch = "cleo/local-fixture";
const selection = { targetBranch: "self-evolving", buildId: "saved" };
const prUrl = `https://github.com/${repository}/pull/123`;
const title = "customize agents& custom harness";
const body = "Build and tests pass.\n\nKeep literal `code` and $(text) unchanged.";

test("main and omitted targets are rejected before any remote action", async (t) => {
  const { manager, calls } = await fixture(t);
  for (const targetBranch of [undefined, "main", "refs/heads/main", "MAIN", " main ", "submission-base"]) {
    await assert.rejects(manager.submitPullRequest(title, body, randomUUID(), { targetBranch, buildId: "saved" }), /目标分支|main|空模板/);
  }
  assert.equal(calls.length, 0);
});

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
  for (const name of ["bootstrap.mjs", "evolution.mjs", "evolution-store.mjs", "evolution-tools.mjs", "evolution-recovery.mjs", "evolution-launch.mjs", "evolution-progress.mjs", "evolution-handoff.mjs", "release-downloads.mjs", "program-updates.mjs", "updater.mjs", "shutdown.mjs"]) {
    await cp(new URL(`../electron/${name}`, import.meta.url), join(manager.source, "ui/electron", name));
  }
  await writeFile(join(manager.source, "ui/package.json"), '{"main":"electron/bootstrap.mjs"}');
  await manager.saveProtection();
  const options = { cwd: manager.source, env };
  await run("git", ["init", "--initial-branch", branch], options);
  await run("git", ["add", "--all"], options);
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], options);
  await writeFile(join(manager.source, "feature.txt"), "custom harness\n");
  const upstream = join(root, "upstream");
  await run("git", ["init", "--initial-branch", "self-evolving", upstream], { env });
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "empty target"], { cwd: upstream, env });
  let targetSha = await run("git", ["rev-parse", "HEAD"], { cwd: upstream, env });
  const setTarget = async (nonempty = false) => {
    if (nonempty) { await writeFile(join(upstream, "existing.txt"), "Do not overwrite"); await run("git", ["add", "."], { cwd: upstream, env }); }
    await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "target changed"], { cwd: upstream, env });
    targetSha = await run("git", ["rev-parse", "HEAD"], { cwd: upstream, env });
    return targetSha;
  };
  const remote = join(root, "fork.git");
  await run("git", ["init", "--bare", remote], { env });
  const tools = { git: "git", gh: "fixture-gh", env };
  manager.tools.prepare = async () => tools;
  const digest = await manager.sourceHash(tools);
  await manager.store.update({ prepared: true, active: "saved", builds: [{ id: "saved", kind: "local", sourceHash: digest }], pullRequest: null });
  const calls = [];
  const remotePrs = [];
  const branches = new Set(["main", "self-evolving"]);
  const issues = [];
  const command = async (executable, args, commandOptions) => {
    calls.push({ executable, args });
    if (executable === tools.gh) {
      if (args[0] === "auth") return "connected";
      if (args[0] === "api") {
        if (args[1] === "user") return JSON.stringify({ login: "fixture-user" });
        if (args[1].includes("?per_page=")) return [...branches].join("\n");
        const name = decodeURIComponent(args[1].split("/branches/")[1]);
        if (!branches.has(name)) throw new Error("目标分支尚未创建 (HTTP 404)");
        return JSON.stringify({ name, commit: { sha: targetSha } });
      }
      if (args[0] === "issue") {
        if (args[1] === "list") return JSON.stringify(issues);
        assert.equal(args[1], "create");
        const text = await readFile(args[args.indexOf("--body-file") + 1], "utf8");
        const issue = { url: `https://github.com/${repository}/issues/${100 + issues.length}`, body: text };
        issues.push(issue); return issue.url;
      }
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
        state: "OPEN", baseRefName: args[args.indexOf("--base") + 1], headRefName: args[args.indexOf("--head") + 1].split(":")[1], headRepositoryOwner: { login: "fixture-user" } });
      return remotePrs.at(-1).url;
    }
    if (args.includes("fetch")) {
      const updated = [...args]; updated[updated.length - 2] = upstream; updated[updated.length - 1] = targetSha;
      return run(executable, updated, commandOptions);
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
  return { manager, root, remote, calls, command, tools, remotePrs, branches, issues, upstream, setTarget };
}

test("GitHub stderr warnings do not corrupt JSON metadata or the successful PR receipt", async (t) => {
  const fixtureState = await fixture(t);
  fixtureState.manager.runCommand = async (executable, args, options) => {
    const output = await fixtureState.command(executable, args, options);
    if (executable !== fixtureState.tools.gh) return output;
    return run(process.execPath, ["-e", `process.stderr.write('warning: diagnostic only\\n'); process.stdout.write(${JSON.stringify(output)});`], options);
  };
  assert.equal(await fixtureState.manager.submitPullRequest(title, body, randomUUID(), selection), prUrl);
  assert.equal((await fixtureState.manager.store.read()).pullRequest.url, prUrl);
  assert.equal(fixtureState.remotePrs.length, 1);
});

test("branch application waits for a maintainer-created target and then submits the selected version from a fork", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await listContributionBranches(f.manager), ["self-evolving"]);
  const input = { targetBranch: "feature/user-request", body: "Please create this target", buildId: "saved", submissionId: randomUUID() };
  const request = await requestTargetBranch(f.manager, input);
  assert.equal(request.status, "requested");
  assert.equal(request.buildId, "saved");
  assert.match(f.issues[0].body, /不代表分支已经创建/);
  assert.ok(!f.calls.some(({ args }) => args.includes("push") || args[0] === "pr" || args[0] === "repo"));
  await assert.rejects(refreshTargetBranch(f.manager, request.id), /尚未创建/);
  await assert.rejects(f.manager.submitPullRequest(title, body, randomUUID(), { targetBranch: input.targetBranch, buildId: "saved" }), /尚未创建/);
  f.branches.add(input.targetBranch); // Simulate the owner creating the target, never a Cleo action.
  assert.equal((await refreshTargetBranch(f.manager, request.id)).status, "ready");
  await f.manager.submitPullRequest(title, body, randomUUID(), { targetBranch: input.targetBranch, buildId: "saved" });
  const receipt = (await f.manager.store.read()).pullRequest;
  assert.equal(receipt.targetBranch, input.targetBranch);
  assert.equal(receipt.sourceHash, request.sourceHash);
  assert.equal(receipt.buildId, request.buildId);
  assert.ok(!f.calls.some(({ args }) => args.includes("merge") || (args.includes("push") && (args.includes("--force") || args.includes("--force-with-lease")))));
});

test("application retries reconcile a lost issue response without duplicates, including after restart", async (t) => {
  const f = await fixture(t);
  const input = { targetBranch: "requested-target", body: "request", buildId: "saved", submissionId: randomUUID() };
  f.manager.runCommand = async (exe, args, opts) => {
    const result = await f.command(exe, args, opts);
    if (args[0] === "issue" && args[1] === "create") throw new Error("response lost");
    return result;
  };
  const receipt = await requestTargetBranch(f.manager, input);
  const restarted = new EvolutionManager({ app: f.manager.app, root: f.manager.store.root, dataHome: f.manager.store.dataHome });
  restarted.tools.prepare = async () => f.tools; restarted.runCommand = f.command;
  assert.equal((await requestTargetBranch(restarted, input)).url, receipt.url);
  assert.equal(f.issues.length, 1);
  await assert.rejects(requestTargetBranch(restarted, { ...input, body: "different" }), /已变化/);
});

test("applications also forbid main and invalid Git branch names, and PR retries bind target and version", async (t) => {
  const f = await fixture(t);
  for (const targetBranch of ["main", "refs/heads/main", "MAIN", "bad name", "../bad"]) {
    await assert.rejects(requestTargetBranch(f.manager, { targetBranch, body, buildId: "saved", submissionId: randomUUID() }), /main|名称无效/);
  }
  assert.equal(f.issues.length, 0);
  const id = randomUUID();
  await f.manager.submitPullRequest(title, body, id, selection);
  await assert.rejects(f.manager.submitPullRequest(title, body, id, { ...selection, targetBranch: "elsewhere" }), /已变化/);
  await assert.rejects(f.manager.submitPullRequest(title, body, randomUUID(), { ...selection, buildId: "missing" }), /先切换/);
});

test("a rejected non-fast-forward push is surfaced and never forced", async (t) => {
  const f = await fixture(t);
  f.manager.runCommand = (exe, args, opts) => args.includes("push")
    ? Promise.reject(new Error("non-fast-forward: remote branch has changed")) : f.command(exe, args, opts);
  await assert.rejects(f.manager.submitPullRequest(title, body, randomUUID(), selection), /non-fast-forward/);
  assert.equal(f.remotePrs.length, 0);
});

test("snapshot has only the empty target as parent and preserves source bytes without publishing local data", async (t) => {
  const f = await fixture(t);
  const source = f.manager.source;
  const options = { cwd: source, env: f.tools.env };
  await mkdir(join(source, "ui/runtime"), { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    await cp(new URL(`../runtime/${name}`, import.meta.url), join(source, "ui/runtime", name));
  }
  await mkdir(join(source, "ui/.npm-cache"), { recursive: true });
  await writeFile(join(source, "ui/.npm-cache/debug.log"), "machine-local log");
  await writeFile(join(source, ".env"), "PRIVATE=never-publish\n");
  await writeFile(join(source, ".gitattributes"), "*.txt text eol=lf\n");
  await writeFile(join(source, ".gitignore"), "feature.txt\n.env\n");
  await run("git", ["add", "-f", "feature.txt", ".env"], options);
  await writeFile(join(source, "feature.txt"), "selected\r\nversion\r\n");
  const before = { head: await run("git", ["rev-parse", "HEAD"], options), index: await readFile(join(source, ".git/index")) };
  const digest = await f.manager.sourceHash(f.tools);
  const snapshot = await createContributionSnapshot(f.manager, f.tools, selection.targetBranch, digest);
  const git = (args) => run("git", args, { cwd: snapshot.directory, env: f.tools.env });
  assert.equal(await git(["show", "-s", "--format=%P", snapshot.commit]), snapshot.baseSha);
  assert.notEqual(snapshot.baseSha, before.head);
  assert.equal(await git(["ls-tree", "--name-only", snapshot.baseSha]), "");
  assert.equal(await git(["merge-tree", "--write-tree", snapshot.baseSha, snapshot.commit]), snapshot.tree);
  // hash-object compares exact blob bytes, including CRLF, without filters.
  const expectedBlob = await run("git", ["hash-object", "--no-filters", "feature.txt"], options);
  assert.equal(await git(["rev-parse", `${snapshot.commit}:feature.txt`]), expectedBlob);
  const exportedPaths = (await git(["ls-tree", "-r", "--name-only", snapshot.commit])).split("\n");
  assert.ok(exportedPaths.includes("ui/runtime/package.json"));
  assert.ok(exportedPaths.includes("ui/runtime/package-lock.json"));
  assert.ok(!exportedPaths.includes("ui/.npm-cache/debug.log"));
  assert.ok(!(await git(["ls-tree", "-r", "--name-only", snapshot.commit])).split("\n").includes(".env"));
  assert.equal(await run("git", ["rev-parse", "HEAD"], options), before.head);
  assert.deepEqual(await readFile(join(source, ".git/index")), before.index);
  assert.equal(await f.manager.sourceHash(f.tools), digest);
  await removeContributionSnapshot(f.manager, snapshot.directory);
});

test("a nonempty target stops submission before any fork, push, or PR creation", async (t) => {
  const f = await fixture(t);
  await f.setTarget(true);
  await assert.rejects(f.manager.submitPullRequest(title, body, randomUUID(), selection), /不是空分支/);
  assert.ok(!f.calls.some(({ args }) => args[0] === "repo" || args.includes("push") || (args[0] === "pr" && args[1] === "create")));
});

for (const stage of ["fetch", "fork", "push"]) {
  test(`target moving during ${stage} stops the pinned attempt and never creates a PR`, async (t) => {
    const f = await fixture(t);
    let moved = false;
    f.manager.runCommand = async (exe, args, opts) => {
      if (!moved && stage === "fetch" && args.includes("fetch")) { moved = true; await f.setTarget(); }
      const result = await f.command(exe, args, opts);
      if (!moved && ((stage === "fork" && args[0] === "repo") || (stage === "push" && args.includes("push")))) {
        moved = true; await f.setTarget();
      }
      return result;
    };
    const id = randomUUID();
    await assert.rejects(f.manager.submitPullRequest(title, body, id, selection), /目标分支已变化/);
    assert.equal(f.remotePrs.length, 0);
    if (stage !== "fetch") await assert.rejects(f.manager.submitPullRequest(title, body, id, selection), /目标分支已变化/);
    assert.ok(!f.calls.some(({ args }) => args.includes("push") && args.some((arg) => arg.startsWith("--force"))));
  });
}

test("source changing during export prevents publication", async (t) => {
  const f = await fixture(t);
  let changed = false;
  f.manager.runCommand = async (exe, args, opts) => {
    const result = await f.command(exe, args, opts);
    if (!changed && args.includes("fetch")) {
      changed = true; await writeFile(join(f.manager.source, "feature.txt"), "changed after selection\n");
    }
    return result;
  };
  await assert.rejects(f.manager.submitPullRequest(title, body, randomUUID(), selection), /本地版本发生变化/);
  assert.equal(f.remotePrs.length, 0);
  assert.ok(!f.calls.some(({ args }) => args.includes("push")));
});

test("submission forks noninteractively, commits, pushes the managed branch, and creates a PR", async (t) => {
  const { manager, remote, calls, tools } = await fixture(t);
  assert.equal(await manager.submitPullRequest(title, body, randomUUID(), selection), prUrl);
  const fork = calls.find(({ args }) => args[0] === "repo");
  assert.deepEqual(fork.args, ["repo", "fork", repository, "--clone=false"]);
  const create = calls.find(({ args }) => args[0] === "pr" && args[1] === "create");
  const publishedBranch = create.args[create.args.indexOf("--head") + 1].split(":")[1];
  assert.match(publishedBranch, /^codex\/pr-/);
  assert.equal(create.args[create.args.indexOf("--base") + 1], "self-evolving");
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
  await assert.rejects(manager.submitPullRequest(title, body, submissionId, selection), /temporary GitHub failure/);
  assert.equal((await manager.store.read()).pullRequest, null);
  assert.ok(!calls.some(({ args }) => args.includes("push") || args.includes("commit")));
  manager.runCommand = command;
  assert.equal(await manager.submitPullRequest(title, body, submissionId, selection), prUrl);
  assert.equal(await manager.submitPullRequest(title, body, submissionId, selection), prUrl);
  assert.notEqual(await manager.submitPullRequest(title, body, randomUUID(), selection), prUrl);
  const creates = calls.filter(({ args }) => args[0] === "pr" && args[1] === "create");
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].args[creates[0].args.indexOf("--head") + 1], creates[1].args[creates[1].args.indexOf("--head") + 1]);
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
  assert.equal((await manager.store.read()).pullRequests.length, 2);
});

test("changed source or an unmanaged branch cannot be published", async (t) => {
  const { manager, calls, tools } = await fixture(t);
  await writeFile(join(manager.source, "feature.txt"), "unchecked change\n");
  await assert.rejects(manager.submitPullRequest(title, body, randomUUID(), selection), /完成检查和构建/);
  assert.ok(!calls.some(({ args }) => args[0] === "repo" || args.includes("push") || args[0] === "pr"));
  await writeFile(join(manager.source, "feature.txt"), "custom harness\n");
  await run("git", ["switch", "-c", "unmanaged"], { cwd: manager.source, env: tools.env });
  await assert.rejects(manager.submitPullRequest(title, body, randomUUID(), selection), /只能提交 Cleo 管理/);
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
  await manager.submitPullRequest(title, body, randomUUID(), selection);
  await manager.submitPullRequest(title, body, randomUUID(), selection);
  assert.deepEqual(parsed, ["pr list", "repo fork", "pr create", "pr list", "repo fork", "pr create"]);
});

test("even an open PR on the workspace branch is historical, never reused by a new request", async (t) => {
  const { manager, calls, remotePrs } = await fixture(t);
  await manager.store.update({ pullRequest: { url: "https://github.com/StDoses72/Cleo-AI-agent/pull/35", state: "OPEN" } });
  remotePrs.push({ url: prUrl, state: "OPEN", headRefName: branch, headRepositoryOwner: { login: "fixture-user" } });
  await manager.submitPullRequest(title, body, randomUUID(), selection);
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
  assert.equal(await manager.submitPullRequest(title, body, randomUUID(), selection), prUrl);
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
});

test("remote closure creates a new branch even when the cache still says OPEN", async (t) => {
  const { manager, remotePrs, calls } = await fixture(t);
  remotePrs.push({ url: prUrl, state: "CLOSED", headRefName: branch, headRepositoryOwner: { login: "fixture-user" } });
  await manager.store.update({ pullRequest: { url: prUrl, state: "OPEN" } });
  await manager.submitPullRequest(title, body, randomUUID(), selection);
  const create = calls.find(({ args }) => args[1] === "create");
  assert.match(create.args[create.args.indexOf("--head") + 1], /^fixture-user:codex\/pr-/);
  assert.ok(!calls.some(({ args }) => args[0] === "switch"));
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
});

test("successful submission and failing CI remain distinct states", async (t) => {
  const { manager } = await fixture(t);
  await manager.submitPullRequest(title, body, randomUUID(), selection);
  await manager.refreshPullRequest();
  assert.equal(manager.submission.status, "success");
  assert.equal((await manager.store.read()).pullRequest.checks, "failed");
});

test("publishing a later version never advances the first PR's remote ref", async (t) => {
  const { manager, remote, tools } = await fixture(t);
  await manager.submitPullRequest(title, body, randomUUID(), selection);
  const first = (await manager.store.read()).pullRequest;
  const gitOptions = { cwd: manager.source, env: tools.env };
  const originalCommit = await run("git", ["--git-dir", remote, "rev-parse", first.headRefName], gitOptions);
  await writeFile(join(manager.source, "feature.txt"), "second independently published version\n");
  const sourceHash = await manager.sourceHash(tools);
  await manager.store.update({ builds: [{ id: "saved", kind: "local", sourceHash }] });
  await manager.submitPullRequest(title, body, randomUUID(), selection);
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
  await assert.rejects(manager.submitPullRequest(title, body, submissionId, selection), /GitHub unavailable/);
  const restarted = new EvolutionManager({ app: manager.app, root: manager.store.root, dataHome: manager.store.dataHome });
  restarted.tools.prepare = async () => tools;
  restarted.runCommand = command;
  assert.equal(await restarted.submitPullRequest(title, body, submissionId, selection), prUrl);
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
  assert.equal(calls.filter(({ args }) => args.includes("push")).length, 1);
});

test("local receipt failure keeps the pending identity for safe retry", async (t) => {
  const { manager, calls, remotePrs } = await fixture(t);
  const submissionId = randomUUID();
  const save = manager.savePullRequestReceipt.bind(manager);
  manager.savePullRequestReceipt = async () => { throw new Error("EPERM fixture"); };
  await assert.rejects(manager.submitPullRequest(title, body, submissionId, selection), /本地回执保存失败/);
  assert.equal((await manager.store.read()).pendingPullRequests[0].id, submissionId);
  remotePrs[0].state = "CLOSED";
  manager.savePullRequestReceipt = save;
  assert.equal(await manager.submitPullRequest(title, body, submissionId, selection), prUrl);
  assert.equal((await manager.store.read()).pullRequest.state, "CLOSED");
  assert.equal(calls.filter(({ args }) => args[1] === "create").length, 1);
  assert.ok(!calls.some(({ args }) => args[1] === "edit"));
});

test("refreshing an older historical PR does not replace the latest receipt", async (t) => {
  const { manager } = await fixture(t);
  const first = await manager.submitPullRequest(title, body, randomUUID(), selection);
  const second = await manager.submitPullRequest(title, body, randomUUID(), selection);
  await manager.refreshPullRequest(first);
  const state = await manager.store.read();
  assert.equal(state.pullRequest.url, second);
  assert.equal(state.pullRequests.find((pr) => pr.url === first).checks, "failed");
  assert.equal(state.pullRequests.find((pr) => pr.url === second).checks, "pending");
});
