import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
      assert.ok(["create", "edit"].includes(args[1]));
      assert.equal(args[args.indexOf("--repo") + 1], repository);
      assert.equal(args[args.indexOf("--title") + 1], title);
      assert.equal(await readFile(args[args.indexOf("--body-file") + 1], "utf8"), body);
      return prUrl;
    }
    if (args.includes("push")) {
      assert.equal(args.at(-2), "https://github.com/fixture-user/Cleo-AI-agent.git");
      assert.equal(args.at(-1), `HEAD:refs/heads/${branch}`);
      assert.ok(args.includes("credential.helper="));
      assert.ok(args.some((arg) => arg.includes("auth git-credential")));
      return run("git", ["push", remote, args.at(-1)], commandOptions);
    }
    return run(executable, args, commandOptions);
  };
  manager.runCommand = command;
  return { manager, root, remote, calls, command, tools };
}

test("submission forks noninteractively, commits, pushes the managed branch, and creates a PR", async (t) => {
  const { manager, remote, calls, tools } = await fixture(t);
  assert.equal(await manager.submitPullRequest(title, body), prUrl);
  const fork = calls.find(({ args }) => args[0] === "repo");
  assert.deepEqual(fork.args, ["repo", "fork", repository, "--clone=false"]);
  const create = calls.find(({ args }) => args[0] === "pr");
  assert.equal(create.args[create.args.indexOf("--head") + 1], `fixture-user:${branch}`);
  assert.equal(await run("git", ["--git-dir", remote, "show", `${branch}:feature.txt`], { env: tools.env }), "custom harness");
  assert.deepEqual((await manager.store.read()).pullRequest, { url: prUrl, state: "OPEN", merged: false });
});

test("retry after fork failure succeeds and an open PR is edited rather than duplicated", async (t) => {
  const { manager, calls, command } = await fixture(t);
  manager.runCommand = async (executable, args, options) => {
    if (args[0] === "repo") throw new Error("temporary GitHub failure");
    return command(executable, args, options);
  };
  await assert.rejects(manager.submitPullRequest(title, body), /temporary GitHub failure/);
  assert.equal((await manager.store.read()).pullRequest, null);
  assert.ok(!calls.some(({ args }) => args.includes("push") || args.includes("commit")));
  manager.runCommand = command;
  await manager.submitPullRequest(title, body);
  await manager.submitPullRequest(title, body);
  assert.deepEqual(calls.filter(({ args }) => args[0] === "pr").map(({ args }) => args[1]), ["create", "edit"]);
  assert.equal(calls.find(({ args }) => args[0] === "pr" && args[1] === "edit").args[2], prUrl);
});

test("changed source or an unmanaged branch cannot be published", async (t) => {
  const { manager, calls, tools } = await fixture(t);
  await writeFile(join(manager.source, "feature.txt"), "unchecked change\n");
  await assert.rejects(manager.submitPullRequest(title, body), /完成检查和构建/);
  assert.ok(!calls.some(({ args }) => args[0] === "repo" || args.includes("push") || args[0] === "pr"));
  await writeFile(join(manager.source, "feature.txt"), "custom harness\n");
  await run("git", ["switch", "-c", "unmanaged"], { cwd: manager.source, env: tools.env });
  await assert.rejects(manager.submitPullRequest(title, body), /只能提交 Cleo 管理/);
  assert.ok(!calls.some(({ args }) => args.includes("push") || args[0] === "pr"));
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
  assert.deepEqual(parsed, ["repo fork", "pr create", "repo fork", "pr edit"]);
});
