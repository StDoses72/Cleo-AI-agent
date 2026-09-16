import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { CONTRIBUTION_REPOSITORY, requireTargetBranch } from "./evolution-contributions.mjs";

/** Purpose: Exclude machine state even if accidentally tracked. Input: repository path. Output: publishable source flag. */
export function isContributionSource(name) {
  return !/^(?:data|config|release|dist|build|workspace|\.git|\.venv|\.release-build|\.test-deps)(?:\/|$)/.test(name)
    && !/^\.(?:env(?:\.|$)|local-preview-)/.test(name)
    && !/^memory\/(?!MEMORY_POLICY\.md$)/.test(name)
    && !/^cleo\/config\/(?:cleo|harnesses)\.json$/.test(name)
    && !/(?:^|\/)(?:node_modules|__pycache__|\.pytest_cache|\.ruff_cache)(?:\/|$)/.test(name)
    && !/^ui\/(?:dist|output|\.npm-cache)(?:\/|$)/.test(name)
    && !/^ui\/runtime\/(?!package(?:-lock)?\.json$)/.test(name)
    && !/\.(?:pyc|tsbuildinfo|sqlite3?(?:-wal|-shm)?)$/.test(name);
}

/** Purpose: Recheck the target against the pinned parent. Input: branch and expected SHA. Output: verified current SHA. */
export async function assertSnapshotTarget(manager, tools, branch, expected) {
  const target = await requireTargetBranch(manager, tools, branch);
  const sha = target.commit?.sha;
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("无法读取目标分支提交，请刷新后重试。");
  if (expected && sha !== expected) throw new Error("目标分支已变化，已停止提交；请重新检查并发起新的 PR。");
  return sha;
}

/** Purpose: Remove only a controller-owned snapshot directory. Input: saved temporary directory. Output: local cleanup. */
export async function removeContributionSnapshot(manager, directory) {
  const root = resolve(manager.store.root, "submission-snapshots");
  if (dirname(resolve(directory)) !== root || !(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
    throw new Error("提交临时目录无效，未执行清理。");
  await rm(directory, { recursive: true, force: true });
}

/** Purpose: Export the selected source as a child of the empty target, never the developer's history.
 * Input: controller, tools, target and immutable build digest. Output: durable isolated Git repository and snapshot commit.
 */
export async function createContributionSnapshot(manager, tools, branch, sourceHash, expectedBase) {
  const baseSha = await assertSnapshotTarget(manager, tools, branch, expectedBase);
  const root = join(manager.store.root, "submission-snapshots");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "snapshot-"));
  const env = { ...tools.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args) => manager.runCommand(tools.git,
    ["-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], { cwd: directory, env });
  try {
    await git(["init", "--initial-branch", "codex/snapshot"]);
    const helper = `!'${tools.gh.replaceAll("\\", "/").replaceAll("'", "'\\''")}' auth git-credential`;
    await git(["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "fetch", "--no-tags",
      `https://github.com/${CONTRIBUTION_REPOSITORY}.git`, `refs/heads/${branch}`]);
    if (await git(["rev-parse", "FETCH_HEAD"]) !== baseSha) throw new Error("目标分支已变化，已停止提交；请重新检查。");
    if (await git(["ls-tree", "--name-only", baseSha]))
      throw new Error("目标分支不是空分支。请由维护者从 submission-base 创建新的空接收分支；不会覆盖已有文件。");
    const sourceOptions = { cwd: manager.source, env: tools.env, trimOutput: false, rejectStderr: true };
    const output = await manager.runCommand(tools.git, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], sourceOptions);
    const names = [...new Set(output.split("\0").filter(Boolean))].sort();
    const hash = createHash("sha256");
    const exported = [];
    for (const name of names) {
      const path = resolve(manager.source, name);
      const child = relative(resolve(manager.source), path);
      if (!child || child.startsWith("..") || isAbsolute(child) || /[\r\n\\]/.test(name))
        throw new Error(`快照导出已停止：源码路径无效：${JSON.stringify(name.slice(0, 2000))}。路径必须位于源码目录内，且不能包含换行或反斜杠。本次尚未生成提交、未推送或创建 PR。`);
      hash.update(name);
      let info;
      try { info = await lstat(path); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        hash.update("deleted"); continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`源码必须是普通文件：${name}`);
      for (let parent = dirname(path); parent !== resolve(manager.source); parent = dirname(parent)) {
        if ((await lstat(parent)).isSymbolicLink()) throw new Error(`源码不能通过目录链接读取：${name}`);
      }
      const bytes = await readFile(path);
      hash.update(createHash("sha256").update(bytes).digest("hex"));
      if (!isContributionSource(name)) continue;
      await mkdir(dirname(join(directory, name)), { recursive: true });
      await writeFile(join(directory, name), bytes, { mode: info.mode });
      exported.push(name);
    }
    if (hash.digest("hex") !== sourceHash || await manager.sourceHash(tools) !== sourceHash)
      throw new Error("导出期间本地版本发生变化，已停止提交；请重新检查和构建。");
    if (!exported.length) throw new Error("所选版本没有可提交的程序源码。");
    // Higher-priority attributes preserve exact snapshot bytes and disable configured clean filters.
    await writeFile(join(directory, ".git/info/attributes"), "* -text -filter -ident -working-tree-encoding\n");
    await git(["add", "--force", "--all"]);
    const modes = await manager.runCommand(tools.git, ["ls-files", "--stage", "-z"], sourceOptions);
    for (const entry of modes.split("\0")) {
      const name = entry.slice(entry.indexOf("\t") + 1);
      if (entry.startsWith("100755 ") && exported.includes(name)) await git(["update-index", "--chmod=+x", "--", name]);
    }
    const tree = await git(["write-tree"]);
    const commit = await git(["-c", "user.name=Cleo Local", "-c", "user.email=cleo-local@users.noreply.github.com",
      "commit-tree", tree, "-p", baseSha, "-m", "Submit selected Cleo source snapshot"]);
    await assertSnapshotTarget(manager, tools, branch, baseSha);
    return { directory, commit, tree, baseSha, fileCount: exported.length, format: "empty-target-snapshot-v1" };
  } catch (error) {
    await removeContributionSnapshot(manager, directory);
    throw error;
  }
}
