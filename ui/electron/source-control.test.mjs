import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedRelativePath, createSourceControl, diffHeaderPaths, patchFilePaths, runCommand, slugify } from "./source-control.mjs";

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "cleo-git-"));
  const git = (...args) => runCommand("git", args, { cwd: root });
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "cleo@example.test");
  await git("config", "user.name", "Cleo Test");
  await git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "app.txt"), "one\n");
  await git("add", "app.txt");
  await git("commit", "-m", "initial");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("paths outside the repository are refused", () => {
  const root = tmpdir();
  assert.throws(() => checkedRelativePath(root, "../secret"), /outside/);
  assert.throws(() => checkedRelativePath(root, "C:/Windows/system.ini"), /outside/);
  assert.throws(() => checkedRelativePath(root, ""), /outside/);
  assert.equal(checkedRelativePath(root, "src\\app.ts").relativePath, "src/app.ts");
});

test("slugs are branch safe", () => {
  assert.equal(slugify("Fix the login bug!"), "fix-the-login-bug");
  assert.equal(slugify("修复登录"), "task");
});

test("revert restores a tracked file and deletes an untracked one", async () => {
  const repo = await repository();
  try {
    const handle = createSourceControl();
    writeFileSync(join(repo.root, "app.txt"), "two\n");
    writeFileSync(join(repo.root, "new.txt"), "new\n");
    assert.deepEqual(await handle("revertFile", { root: repo.root, path: "app.txt" }), { path: "app.txt", action: "restored" });
    assert.equal(readFileSync(join(repo.root, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "one\n");
    assert.deepEqual(await handle("revertFile", { root: repo.root, path: "new.txt" }), { path: "new.txt", action: "deleted" });
    assert.equal(existsSync(join(repo.root, "new.txt")), false);
    await assert.rejects(handle("revertFile", { root: repo.root, path: "../escape.txt" }), /outside/);
  } finally { repo.cleanup(); }
});

test("a git that cannot read HEAD or the index never leads to deleting a tracked file", async () => {
  const repo = await repository();
  try {
    writeFileSync(join(repo.root, "app.txt"), "edited\n");
    writeFileSync(join(repo.root, "added.txt"), "staged\n");
    await repo.git("add", "added.txt");
    // A committed file when HEAD cannot be read; a staged file when the index cannot be read.
    for (const [broken, path] of [["ls-tree", "app.txt"], ["rev-parse --verify --quiet HEAD^{commit}", "app.txt"], ["rev-parse --verify --quiet HEAD", "app.txt"], ["ls-files", "added.txt"]]) {
      const handle = createSourceControl({ run: (file, args, options) => args.join(" ").includes(broken)
        ? Promise.reject(Object.assign(new Error(`fatal: unable to read (${broken})`), { code: 128 }))
        : runCommand(file, args, options) });
      await assert.rejects(handle("revertFile", { root: repo.root, path }), /unable to read/);
      assert.equal(existsSync(join(repo.root, path)), true, `${broken} failure must not delete ${path}`);
    }
    // HEAD names a commit whose object git cannot read (here: removed from the object store). The
    // branch still exists, so this is not an unborn repository and nothing may be deleted.
    const commit = await repo.git("rev-parse", "HEAD");
    const object = join(repo.root, ".git", "objects", commit.slice(0, 2), commit.slice(2));
    chmodSync(object, 0o666);
    rmSync(object);
    await assert.rejects(createSourceControl()("revertFile", { root: repo.root, path: "app.txt" }), /HEAD/);
    assert.equal(existsSync(join(repo.root, "app.txt")), true, "an unreadable HEAD commit must not delete app.txt");
    // In a repository with no commit yet, a new file is still reverted by removing it.
    const fresh = mkdtempSync(join(tmpdir(), "cleo-unborn-"));
    try {
      await runCommand("git", ["init", "--initial-branch=main"], { cwd: fresh });
      writeFileSync(join(fresh, "first.txt"), "first\n");
      assert.deepEqual(await createSourceControl()("revertFile", { root: fresh, path: "first.txt" }), { path: "first.txt", action: "deleted" });
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  } finally { repo.cleanup(); }
});

test("revert restores a staged deletion and drops a staged new file", async () => {
  const repo = await repository();
  try {
    const handle = createSourceControl();
    await repo.git("rm", "--quiet", "app.txt");
    writeFileSync(join(repo.root, "added.txt"), "added\n");
    await repo.git("add", "added.txt");
    assert.deepEqual(await handle("revertFile", { root: repo.root, path: "app.txt" }), { path: "app.txt", action: "restored" });
    assert.equal(readFileSync(join(repo.root, "app.txt"), "utf8").replace(/\r\n/g, "\n"), "one\n");
    assert.deepEqual(await handle("revertFile", { root: repo.root, path: "added.txt" }), { path: "added.txt", action: "deleted" });
    assert.equal(existsSync(join(repo.root, "added.txt")), false);
    assert.equal(await repo.git("status", "--porcelain"), "");
  } finally { repo.cleanup(); }
});

test("status, commit and worktree work against a real repository", async () => {
  const repo = await repository();
  try {
    const handle = createSourceControl();
    writeFileSync(join(repo.root, "app.txt"), "changed\n");
    writeFileSync(join(repo.root, "user-notes.txt"), "not part of the task\n");
    const before = await handle("status", { root: repo.root });
    assert.equal(before.repository, true);
    assert.equal(before.branch, "main");
    assert.equal(before.changedFiles, 2);
    await assert.rejects(handle("commit", { root: repo.root, message: "  ", paths: ["app.txt"] }), /commit message/);
    await assert.rejects(handle("commit", { root: repo.root, message: "Change app", paths: [] }), /no changed files/);
    const { sha, files } = await handle("commit", { root: repo.root, message: "Change app", paths: ["app.txt"] });
    assert.match(sha, /^[0-9a-f]{7,}$/);
    assert.equal(files, 1);
    // Only the task's file was committed; the user's own edit is still pending.
    assert.equal(await repo.git("status", "--porcelain"), "?? user-notes.txt");
    rmSync(join(repo.root, "user-notes.txt"));
    const worktree = await handle("createWorktree", { root: repo.root, name: "Try the idea" });
    assert.equal(worktree.branch, "cleo/try-the-idea");
    assert.equal(existsSync(join(worktree.path, "app.txt")), true);
    // The worktree folder is excluded locally, so the main checkout stays clean.
    assert.equal((await handle("status", { root: repo.root })).changedFiles, 0);
    const second = await handle("createWorktree", { root: repo.root, name: "Try the idea" });
    assert.equal(second.branch, "cleo/try-the-idea-2");
    // A leftover branch without a folder is not reused either.
    await repo.git("branch", "cleo/fresh");
    assert.equal((await handle("createWorktree", { root: repo.root, name: "fresh" })).branch, "cleo/fresh-2");
    // Removal is limited to Cleo worktrees and keeps uncommitted work unless forced.
    await assert.rejects(handle("removeWorktree", { root: repo.root }), /Only worktrees created by Cleo/);
    writeFileSync(join(worktree.path, "draft.txt"), "draft\n");
    await assert.rejects(handle("removeWorktree", { root: worktree.path }));
    await handle("removeWorktree", { root: worktree.path, force: true });
    assert.equal(existsSync(worktree.path), false);
    await handle("removeWorktree", { root: second.path });
    assert.equal(existsSync(second.path), false);
    await repo.git("worktree", "remove", "--force", join(repo.root, ".cleo", "worktrees", "fresh-2"));
  } finally { repo.cleanup(); }
});

test("a project in a subfolder acts on repository-root paths, as its diff lists them", async () => {
  const repo = await repository();
  try {
    const handle = createSourceControl();
    const sub = join(repo.root, "ui");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, "src", "app.ts"), "one\n");
    await repo.git("add", ".");
    await repo.git("commit", "-m", "ui");
    writeFileSync(join(sub, "src", "app.ts"), "two\n");
    writeFileSync(join(sub, "src", "new.ts"), "new\n");
    const status = await handle("status", { root: sub });
    assert.equal(realpathSync(status.root), realpathSync(repo.root), "projects in one checkout share its root");
    await handle("commit", { root: sub, message: "Change ui", paths: ["ui/src/app.ts"] });
    assert.equal(await repo.git("status", "--porcelain"), "?? ui/src/new.ts");
    assert.deepEqual(await handle("revertFile", { root: sub, path: "ui/src/new.ts" }), { path: "ui/src/new.ts", action: "deleted" });
    assert.equal(existsSync(join(sub, "src", "new.ts")), false);
    // @-mention files are listed from the project's own folder, without ignored files.
    writeFileSync(join(repo.root, ".gitignore"), "*.log\n");
    writeFileSync(join(sub, "debug.log"), "noise\n");
    writeFileSync(join(sub, "src", "fresh.ts"), "fresh\n");
    const listed = await handle("listFiles", { root: sub });
    assert.equal(listed.repository, true);
    assert.deepEqual(listed.files.sort(), ["src/app.ts", "src/fresh.ts"]);
  } finally { repo.cleanup(); }
});

test("one hunk is reverted and the rest of the file's change is kept", async () => {
  const repo = await repository();
  try {
    const handle = createSourceControl();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    writeFileSync(join(repo.root, "app.txt"), `${lines.join("\n")}\n`);
    await repo.git("commit", "-am", "thirty lines");
    const edited = [...lines];
    edited[1] = "changed near the top";
    edited[27] = "changed near the bottom";
    writeFileSync(join(repo.root, "app.txt"), `${edited.join("\n")}\n`);
    const diff = (await repo.git("diff", "--no-color", "HEAD", "--", "app.txt")).replace(/\r\n/g, "\n").split("\n");
    const firstHunk = diff.findIndex((line) => line.startsWith("@@"));
    const secondHunk = diff.findIndex((line, index) => index > firstHunk && line.startsWith("@@"));
    // The second hunk only, with the file's header, as the details panel builds it.
    const patch = [...diff.slice(0, firstHunk), ...diff.slice(secondHunk)].join("\n");
    assert.deepEqual(await handle("revertHunk", { root: repo.root, patch }), { path: "app.txt" });
    const after = readFileSync(join(repo.root, "app.txt"), "utf8").replace(/\r\n/g, "\n").split("\n");
    assert.equal(after[1], "changed near the top");
    assert.equal(after[27], "line 28");
    // A stale hunk (already reverted) is refused rather than applied to the wrong text.
    await assert.rejects(handle("revertHunk", { root: repo.root, patch }));
    await assert.rejects(handle("revertHunk", { root: repo.root, patch: patch.replace("a/app.txt", "a/../outside.txt") }), /outside/);
    await assert.rejects(handle("revertHunk", { root: repo.root, patch: diff.join("\n") }), /one hunk/);
  } finally { repo.cleanup(); }
});

test("quoted and non-ASCII file names in a diff header are read as git wrote them", async () => {
  assert.deepEqual(diffHeaderPaths("diff --git a/src/app.ts b/src/app.ts"), { from: "src/app.ts", to: "src/app.ts" });
  assert.deepEqual(diffHeaderPaths("diff --git \"a/my notes.txt\" \"b/my notes.txt\""), { from: "my notes.txt", to: "my notes.txt" });
  assert.deepEqual(diffHeaderPaths("diff --git \"a/\\344\\270\\255\\346\\226\\207.txt\" \"b/\\344\\270\\255\\346\\226\\207.txt\""),
    { from: "中文.txt", to: "中文.txt" });
  assert.equal(diffHeaderPaths("diff --git x/a y/b"), null);
  // Git can leave a path with spaces unquoted; the two equal halves are found.
  assert.deepEqual(diffHeaderPaths("diff --git a/my notes.txt b/my notes.txt"), { from: "my notes.txt", to: "my notes.txt" });
  assert.deepEqual(patchFilePaths("diff --git a/x b/x\n--- a/old name.txt\n+++ b/new name.txt\n@@ -1 +1 @@"), { from: "old name.txt", to: "new name.txt" });
  assert.deepEqual(patchFilePaths("--- /dev/null\n+++ b/fresh.txt"), { from: null, to: "fresh.txt" });
  // A hunk of a file whose name git quotes is reverted like any other.
  const repo = await repository();
  try {
    await repo.git("config", "core.quotepath", "true");
    const name = "中文 notes.txt";
    writeFileSync(join(repo.root, name), "one\ntwo\n");
    await repo.git("add", "--", name);
    await repo.git("commit", "-m", "quoted");
    writeFileSync(join(repo.root, name), "one\nchanged\n");
    const patch = await repo.git("diff", "--no-color", "HEAD", "--", name);
    assert.match(patch, /^diff --git "a\//);
    assert.deepEqual(await createSourceControl()("revertHunk", { root: repo.root, patch }), { path: name });
    assert.equal(readFileSync(join(repo.root, name), "utf8").replace(/\r\n/g, "\n"), "one\ntwo\n");
  } finally { repo.cleanup(); }
});

test("push is only offered for commits the remote lacks", async () => {
  const repo = await repository();
  const remote = mkdtempSync(join(tmpdir(), "cleo-remote-"));
  try {
    await runCommand("git", ["init", "--bare", "--initial-branch=main"], { cwd: remote });
    await repo.git("remote", "add", "origin", remote);
    await repo.git("push", "--quiet", "origin", "main");
    await repo.git("remote", "set-head", "origin", "main");
    await repo.git("checkout", "--quiet", "-b", "feature");
    // What execFile reports when the GitHub CLI is not installed.
    const handle = createSourceControl({ run: (file, args, options) => file === "gh"
      ? Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" })) : runCommand(file, args, options) });
    const fresh = await handle("status", { root: repo.root });
    assert.equal(fresh.upstream, null);
    assert.equal(fresh.ahead, 0, "a new branch with no commits of its own has nothing to push");
    writeFileSync(join(repo.root, "app.txt"), "feature\n");
    await handle("commit", { root: repo.root, message: "Feature", paths: ["app.txt"] });
    assert.equal((await handle("status", { root: repo.root })).ahead, 1);
    // Without the GitHub CLI there is no pull request to report.
    assert.deepEqual(await handle("pullRequest", { root: repo.root }), { pullRequest: null });
  } finally { repo.cleanup(); rmSync(remote, { recursive: true, force: true }); }
});

test("a git failure while listing files is an error, not an empty project", async () => {
  const root = mkdtempSync(join(tmpdir(), "cleo-list-"));
  try {
    const failing = createSourceControl({ run: async (file, args) => {
      if (args[0] === "rev-parse") return "true";
      throw new Error("fatal: index file corrupt");
    } });
    await assert.rejects(failing("listFiles", { root }), /index file corrupt/);
    // A plain folder is not a repository: nothing to list and no error, whatever language git speaks.
    const translated = createSourceControl({ run: async () => { throw new Error("致命错误：不是 git 仓库（或者任何父目录）"); } });
    assert.deepEqual(await translated("listFiles", { root }), { repository: false, files: [] });
    assert.deepEqual(await createSourceControl()("listFiles", { root }), { repository: false, files: [] });
    // Inside a repository, a git that cannot even tell whether it is one is an error, not an empty project.
    mkdirSync(join(root, ".git"));
    const refusing = createSourceControl({ run: async () => { throw new Error("fatal: detected dubious ownership in repository"); } });
    await assert.rejects(refusing("listFiles", { root }), /dubious ownership/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pull request checks are counted by outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "cleo-pr-"));
  try {
    const answer = JSON.stringify({ number: 7, title: "Desktop UI", state: "OPEN", url: "https://github.com/o/r/pull/7", isDraft: false,
      statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { status: "IN_PROGRESS", conclusion: "" }, { state: "SUCCESS" }] });
    const handle = createSourceControl({ run: async (file) => { assert.equal(file, "gh"); return answer; } });
    assert.deepEqual(await handle("pullRequest", { root }), { pullRequest: { number: 7, title: "Desktop UI", state: "OPEN",
      url: "https://github.com/o/r/pull/7", draft: false, checks: { passed: 2, failed: 1, pending: 1 } } });
    // "No pull request" is an answer; a failed request is an error the panel shows next to what it knew.
    const none = createSourceControl({ run: async () => { throw new Error("no pull requests found for branch \"feature\""); } });
    assert.deepEqual(await none("pullRequest", { root }), { pullRequest: null });
    const elsewhere = createSourceControl({ run: async () => { throw new Error("none of the git remotes configured for this repository point to a known GitHub host"); } });
    assert.deepEqual(await elsewhere("pullRequest", { root }), { pullRequest: null });
    const offline = createSourceControl({ run: async () => { throw new Error("HTTP 503: Service Unavailable"); } });
    await assert.rejects(offline("pullRequest", { root }), /503/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a folder that is not a repository reports so instead of failing", async () => {
  const root = mkdtempSync(join(tmpdir(), "cleo-plain-"));
  try {
    assert.deepEqual(await createSourceControl()("status", { root }), { repository: false });
    await assert.rejects(createSourceControl()("unknown", { root }), /Unsupported/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
