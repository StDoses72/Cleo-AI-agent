// Source control for a task's working directory: what the details panel and composer need to
// review, keep or isolate an agent's work (status, revert one file, commit, push, open a pull
// request, start an isolated worktree). Every command runs through execFile with an argument
// list, never a shell, and every path is checked to stay inside the repository it names.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const COMMAND_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 120_000;
const WORKTREE_DIR = join(".cleo", "worktrees");

/** Run a program without a shell; resolves with trimmed stdout or rejects with its stderr. */
export function runCommand(file, args, { cwd, timeout = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || "").trim().split(/\r?\n/).slice(-6).join("\n");
        reject(Object.assign(new Error(message || `${file} failed`), { code: error.code }));
        return;
      }
      resolvePromise(String(stdout).trim());
    });
  });
}

/** Purpose: Accept only an existing absolute directory as a repository root. */
function checkedRoot(root) {
  const value = String(root || "");
  if (!value || !isAbsolute(value) || !existsSync(value) || !statSync(value).isDirectory()) {
    throw new Error("The task's working directory is not available.");
  }
  return resolve(value);
}

/** Purpose: Keep a repository-relative path inside the repository. */
export function checkedRelativePath(root, path) {
  const value = String(path || "").replaceAll("\\", "/");
  if (!value || isAbsolute(value) || value.split("/").includes("..")) throw new Error("The file path is outside the project.");
  const absolute = resolve(root, value);
  const back = relative(root, absolute);
  if (!back || back.startsWith("..") || isAbsolute(back)) throw new Error("The file path is outside the project.");
  return { relativePath: back.split(sep).join("/"), absolute };
}

/** Purpose: Read a path from a `diff --git` header. Git quotes paths with spaces, quotes or
 * non-ASCII bytes as C strings ("a/\344\270\255.txt"); octal escapes are UTF-8 bytes. */
function unquoteGitPath(value) {
  if (!value.startsWith("\"")) return value;
  const bytes = [];
  const escapes = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, "\\": 92, "\"": 34 };
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index];
    if (character !== "\\") { bytes.push(...Buffer.from(character, "utf8")); continue; }
    const next = value[index + 1];
    if (/[0-7]/.test(next)) { bytes.push(parseInt(value.slice(index + 1, index + 4), 8)); index += 3; continue; }
    bytes.push(escapes[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

export function diffHeaderPaths(line) {
  const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
  if (match) {
    const [left, right] = [unquoteGitPath(match[1]), unquoteGitPath(match[2])];
    if (!left.startsWith("a/") || !right.startsWith("b/")) return null;
    return { from: left.slice(2), to: right.slice(2) };
  }
  // Git leaves some paths with spaces unquoted ("a/my notes.txt b/my notes.txt"); when the two
  // sides name the same file the header splits evenly.
  const rest = line.startsWith("diff --git ") ? line.slice("diff --git ".length) : "";
  const length = (rest.length - 5) / 2;
  if (rest.startsWith("a/") && Number.isInteger(length) && length > 0 && rest.slice(2 + length, 5 + length) === " b/"
    && rest.slice(2, 2 + length) === rest.slice(5 + length)) {
    return { from: rest.slice(2, 2 + length), to: rest.slice(5 + length) };
  }
  return null;
}

/** Purpose: The file a patch changes, from its `---` / `+++` lines (the unambiguous source when
 * present, also for renames and paths with spaces). Output: { from, to } (null for /dev/null). */
export function patchFilePaths(text) {
  const lines = String(text).split("\n");
  const read = (prefix, side) => {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (!line) return undefined;
    const value = unquoteGitPath(line.slice(prefix.length).replace(/\t.*$/, ""));
    if (value === "/dev/null") return null;
    return value.startsWith(`${side}/`) ? value.slice(2) : undefined;
  };
  return { from: read("--- ", "a"), to: read("+++ ", "b") };
}

/** Purpose: Whether a folder sits inside a git working tree (a `.git` entry here or in a parent). */
function insideGitFolder(folder) {
  let current = resolve(folder);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Purpose: Turn free text into a short branch-safe slug (ASCII letters, digits and dashes). */
export function slugify(text, fallback = "task") {
  const slug = String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || fallback;
}

/** Purpose: Create the handler behind the `cleo:git` channel.
 * Input: optional command runner (tests inject one). Output: `handle(op, params)` returning plain data.
 */
export function createSourceControl({ run = runCommand } = {}) {
  const git = (root, args, timeout) => run("git", args, { cwd: root, timeout });
  /** The working tree's top folder. The task's diff lists paths from there, so file actions
   * resolve and run from it even when the project is a subfolder of the repository. */
  const topLevel = async (cwd) => resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));

  async function status({ root }) {
    const cwd = checkedRoot(root);
    const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "");
    if (!top) return { repository: false };
    const [branch, porcelain, upstream, remote] = await Promise.all([
      git(cwd, ["branch", "--show-current"]).catch(() => ""),
      git(cwd, ["status", "--porcelain=v1"]).catch(() => ""),
      git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => ""),
      git(cwd, ["remote", "get-url", "origin"]).catch(() => ""),
    ]);
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const counts = await git(cwd, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]).catch(() => "0\t0");
      [behind, ahead] = counts.split(/\s+/).map(Number);
    } else if (remote && branch) {
      // A branch that was never pushed: count what the remote's default branch lacks; unknown if
      // the remote has no default branch recorded locally.
      ahead = await git(cwd, ["rev-list", "--count", "refs/remotes/origin/HEAD..HEAD"]).then(Number, () => null);
    }
    const github = await run("gh", ["--version"], { cwd }).then(() => true, () => false);
    const lines = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
    return {
      repository: true,
      // The checkout's identity: two projects in one working tree share it.
      root: resolve(top),
      branch: branch || null,
      upstream: upstream || null,
      ahead,
      behind,
      changedFiles: lines.length,
      remote: remote || null,
      canCreatePullRequest: Boolean(remote && github),
    };
  }

  /** The working tree a folder belongs to (its top folder), or null outside git. Cheap: one git
   * call; the desktop uses it to tell which projects share a checkout. */
  async function root({ root: folder }) {
    const cwd = checkedRoot(folder);
    const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "");
    return { root: top ? resolve(top) : null };
  }

  /** Whether HEAD names a commit (true) or a branch with no commit yet (false), each decided on a
   * positive answer from git. A HEAD that resolves to a commit git cannot read, a detached HEAD that
   * does not resolve, or a branch that exists but does not resolve is an error. */
  async function headIsBorn(cwd) {
    // Without peeling, this reads the reference only: it succeeds even when the commit object is
    // missing, and fails (exit 1) when the branch has no commit.
    const resolved = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, (error) => {
      if (error?.code === 1) return false;
      throw error;
    });
    if (resolved) {
      await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch((error) => {
        throw new Error(`git cannot read the current commit (HEAD).${error?.message ? ` ${error.message}` : ""}`);
      });
      return true;
    }
    // Unborn: HEAD points at a branch, and no such branch exists yet.
    const branch = await git(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
    if (!branch.startsWith("refs/heads/")) throw new Error("git cannot resolve HEAD.");
    if (await git(cwd, ["for-each-ref", "--format=%(refname)", branch])) throw new Error(`git cannot resolve ${branch}.`);
    return false;
  }

  /** Return a file to its committed state. The decision is made against HEAD, not the index, so a
   * staged deletion is restored and a staged new file is unstaged and removed. `path` is relative
   * to the repository's top folder, as in the task's diff. */
  async function revertFile({ root, path }) {
    const cwd = await topLevel(checkedRoot(root));
    const { relativePath, absolute } = checkedRelativePath(cwd, path);
    // Every answer that leads to deleting the file must be a positive one: a repository, object or
    // index git cannot read is an error, never "not in HEAD" or "not tracked".
    const inHead = await headIsBorn(cwd) && Boolean(await git(cwd, ["ls-tree", "-z", "HEAD", "--", relativePath]));
    if (inHead) {
      await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", relativePath]);
      return { path: relativePath, action: "restored" };
    }
    const inIndex = Boolean(await git(cwd, ["ls-files", "-z", "--cached", "--", relativePath]));
    if (inIndex) {
      await git(cwd, ["rm", "--cached", "--force", "--quiet", "--", relativePath]);
    } else {
      // A file git has never tracked: removing it is the revert, unless git is told to ignore it.
      const ignored = await git(cwd, ["check-ignore", "-q", "--", relativePath]).then(() => true, (error) => {
        if (error?.code === 1) return false; // check-ignore's "not ignored"
        throw error;
      });
      if (ignored) throw new Error("This file is ignored by git; Cleo will not delete it.");
    }
    rmSync(absolute, { force: true });
    return { path: relativePath, action: "deleted" };
  }

  /** Undo one hunk of a file's change. `patch` is that file's diff header plus the one hunk, as
   * the details panel shows it; git applies it in reverse to the working tree only after checking
   * it still matches, so a stale view is refused instead of damaging the file. */
  async function revertHunk({ root, patch }) {
    const cwd = await topLevel(checkedRoot(root));
    const text = String(patch || "").replace(/\r\n/g, "\n");
    const headerLine = text.split("\n").find((line) => line.startsWith("diff --git "));
    const header = headerLine ? diffHeaderPaths(headerLine) : null;
    // The ---/+++ lines name the file unambiguously when present; the header covers the rest.
    const named = patchFilePaths(text);
    const to = named.to ?? (named.to === null ? named.from : undefined) ?? header?.to;
    const from = named.from ?? (named.from === null ? to : undefined) ?? header?.from;
    if (!headerLine || !to || !from || !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)) throw new Error("This change cannot be reverted piece by piece.");
    if ((text.match(/^diff --git /gm) ?? []).length !== 1 || (text.match(/^@@ /gm) ?? []).length !== 1) {
      throw new Error("Revert one hunk of one file at a time.");
    }
    // Every path the patch names (header and ---/+++ lines) must be inside this repository.
    for (const path of [header?.from, header?.to, named.from, named.to]) if (path) checkedRelativePath(cwd, path);
    const { relativePath } = checkedRelativePath(cwd, to);
    checkedRelativePath(cwd, from);
    const directory = mkdtempSync(join(tmpdir(), "cleo-hunk-"));
    const file = join(directory, "hunk.patch");
    try {
      writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
      await git(cwd, ["apply", "--reverse", "--check", "--recount", file]);
      await git(cwd, ["apply", "--reverse", "--recount", file]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    return { path: relativePath };
  }

  /** Commit exactly the listed files (the task's changes), never other edits in the checkout. */
  async function commit({ root, message, paths }) {
    const cwd = await topLevel(checkedRoot(root));
    const text = String(message || "").trim();
    if (!text) throw new Error("Write a commit message first.");
    const files = (Array.isArray(paths) ? paths : []).map((path) => checkedRelativePath(cwd, path).relativePath);
    if (!files.length) throw new Error("There are no changed files to commit.");
    await git(cwd, ["add", "--all", "--", ...files]);
    await git(cwd, ["commit", "--message", text, "--", ...files]);
    const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
    return { sha, files: files.length };
  }

  async function push({ root }) {
    const cwd = checkedRoot(root);
    const branch = await git(cwd, ["branch", "--show-current"]);
    if (!branch) throw new Error("Check out a branch before pushing.");
    await git(cwd, ["push", "--set-upstream", "origin", branch], NETWORK_TIMEOUT_MS);
    return { branch };
  }

  async function createPullRequest({ root, title, body, draft = false }) {
    const cwd = checkedRoot(root);
    const args = ["pr", "create"];
    const heading = String(title || "").trim();
    if (heading) args.push("--title", heading, "--body", String(body || ""));
    else args.push("--fill");
    if (draft) args.push("--draft");
    const output = await run("gh", args, { cwd, timeout: NETWORK_TIMEOUT_MS });
    const url = output.split(/\r?\n/).reverse().find((line) => /^https?:\/\//.test(line.trim()))?.trim() ?? null;
    return { url };
  }

  /** The open pull request for the current branch and a count of its checks (GitHub CLI). A branch
   * without a pull request, or a machine without `gh`, answers `null`. */
  async function pullRequest({ root }) {
    const cwd = checkedRoot(root);
    // There is no pull request when GitHub says so, when `gh` is not installed, or when the branch's
    // remotes are not on GitHub. Any other failure (network, sign-in) is an error, so the panel keeps
    // what it last knew instead of offering "Create PR" again.
    const output = await run("gh", ["pr", "view", "--json", "number,title,state,url,isDraft,statusCheckRollup"],
      { cwd, timeout: NETWORK_TIMEOUT_MS }).catch((error) => {
      if (error?.code === "ENOENT") return "";
      if (/no (open )?pull requests? found|no git remotes found|point to a known GitHub host/i.test(String(error?.message))) return "";
      throw error;
    });
    if (!output) return { pullRequest: null };
    let data;
    try { data = JSON.parse(output); } catch { return { pullRequest: null }; }
    const checks = { passed: 0, failed: 0, pending: 0 };
    for (const check of Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : []) {
      // Check runs report a conclusion once completed; status contexts report a state.
      const value = String(check?.conclusion || check?.state || "").toUpperCase();
      if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value)) checks.passed += 1;
      else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value)) checks.failed += 1;
      else checks.pending += 1;
    }
    return { pullRequest: { number: Number(data.number), title: String(data.title ?? ""), state: String(data.state ?? ""),
      url: String(data.url ?? ""), draft: Boolean(data.isDraft), checks } };
  }

  /** Files a message can mention with @: tracked and untracked files, without ignored ones. Paths
   * are relative to the task's folder. */
  async function listFiles({ root, limit = 20_000 }) {
    const cwd = checkedRoot(root);
    // Outside a repository there is simply nothing to list; a failing git inside one is an error
    // the composer shows with Retry, not an empty project.
    // Only git's own "not a git repository" answer means there is nothing to list; a missing git,
    // a permission or ownership refusal is an error the user can act on.
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).then((answer) => answer === "true", (error) => {
      // Decided from the folders, not git's (possibly translated) message: no `.git` here or above
      // means this simply is not a repository.
      if (!insideGitFolder(cwd)) return false;
      throw error;
    });
    if (!inside) return { repository: false, files: [] };
    const output = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    const files = [...new Set(output.split("\0").filter(Boolean))];
    const cap = Math.max(1, Math.min(Number(limit) || 20_000, 50_000));
    return { repository: true, files: files.slice(0, cap), truncated: files.length > cap };
  }

  /** Create `<repo>/.cleo/worktrees/<slug>` on a new `cleo/<slug>` branch from the current HEAD.
   * The folder is excluded locally through .git/info/exclude, so the repository's tracked files
   * never change. */
  async function createWorktree({ root, name }) {
    const cwd = checkedRoot(root);
    const top = resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
    const slug = slugify(name);
    const branchExists = (value) => git(top, ["show-ref", "--verify", "--quiet", `refs/heads/cleo/${value}`]).then(() => true, () => false);
    let candidate = slug;
    // Neither the folder nor the cleo/<slug> branch may already exist.
    for (let attempt = 2; existsSync(join(top, WORKTREE_DIR, candidate)) || await branchExists(candidate); attempt++) candidate = `${slug}-${attempt}`;
    const path = join(top, WORKTREE_DIR, candidate);
    const branch = `cleo/${candidate}`;
    mkdirSync(join(top, WORKTREE_DIR), { recursive: true });
    const gitDir = resolve(top, await git(top, ["rev-parse", "--git-common-dir"]));
    const exclude = join(gitDir, "info", "exclude");
    const pattern = "/.cleo/worktrees/";
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split(/\r?\n/).includes(pattern)) {
      mkdirSync(join(gitDir, "info"), { recursive: true });
      appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    }
    await git(top, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return { path, branch, name: `${basename(top)} · ${candidate}` };
  }

  /** Remove a Cleo worktree folder. Refuses folders outside `.cleo/worktrees` and, unless forced,
   * worktrees with uncommitted changes (git's own check). The branch is kept. */
  async function removeWorktree({ root, force = false }) {
    const cwd = checkedRoot(root);
    const normalized = cwd.split(sep).join("/");
    if (!/\/\.cleo\/worktrees\/[^/]+$/.test(normalized)) throw new Error("Only worktrees created by Cleo can be removed here.");
    const common = resolve(cwd, await git(cwd, ["rev-parse", "--git-common-dir"]));
    const main = resolve(common, "..");
    await git(main, ["worktree", "remove", ...(force ? ["--force"] : []), cwd]);
    return { path: cwd };
  }

  const ops = { status, root, revertFile, revertHunk, commit, push, createPullRequest, pullRequest, listFiles, createWorktree, removeWorktree };
  return async function handle(op, params = {}) {
    const action = ops[op];
    if (!action) throw new Error(`Unsupported source-control operation: ${op}`);
    return action(params && typeof params === "object" ? params : {});
  };
}
