import { createHash } from "node:crypto";
import { lstat, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { CONTRIBUTION_REPOSITORY as REPOSITORY } from "./evolution-contributions.mjs";
import { isContributionSource } from "./evolution-snapshot.mjs";

const endpoint = `repos/${REPOSITORY}`;
const shaPattern = /^[a-f0-9]{40}$/;
export const releaseTagPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const api = async (manager, tools, path) => JSON.parse(await manager.runCommand(tools.gh,
  ["api", path], { env: tools.env }));

// Authorization is transient and always replaced, including on lookup failure.
export async function checkReleasePermission(manager, tools) {
  const publish = access => { manager.setGithubAuth({ ...manager.githubAuth, repositoryAccess: access }); return access; };
  publish({ status: "checking", repository: REPOSITORY, canRelease: false, message: "正在检查仓库发布权限…" });
  try {
    tools ||= await manager.tools.prepareGithub({ signal: manager.operationAbort?.signal });
    const user = await api(manager, tools, "user");
    if (!/^[a-zA-Z0-9-]+$/.test(user.login || "")) throw new Error("Invalid identity");
    const repo = await api(manager, tools, endpoint);
    if (typeof repo.permissions?.push !== "boolean") throw new Error("Missing permission");
    const canRelease = repo.permissions.push && !repo.archived && !repo.disabled;
    const role = user.login.toLowerCase() === repo.owner?.login?.toLowerCase() ? "owner"
      : repo.permissions.push ? "collaborator" : "read-only";
    return publish({ status: "checked", repository: REPOSITORY, login: user.login, role, canRelease,
      message: canRelease ? "有仓库写权限，可以创建发布草稿。" : "当前账号没有直接发布权限，仍可提交 PR 或申请分支。" });
  } catch {
    return publish({ status: "failed", repository: REPOSITORY, canRelease: false,
      message: "未能确认仓库发布权限，请检查 GitHub 连接后重试。仍可使用 PR 或分支申请。" });
  }
}

/** Compare GitHub's complete merged tree with the prepared source, excluding local-only data. */
async function verifyReleaseTree(manager, tools, commit) {
  const tree = await api(manager, tools, `${endpoint}/git/trees/${commit}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("无法完整核验发布提交的源码。");
  const remote = new Map(tree.tree.filter(item => item.type !== "tree").map(item => [item.path, item]));
  const output = await manager.runCommand(tools.git, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: manager.source, env: tools.env, trimOutput: false, rejectStderr: true });
  const staged = await manager.runCommand(tools.git, ["ls-files", "--stage", "-z"],
    { cwd: manager.source, env: tools.env, trimOutput: false, rejectStderr: true });
  const modes = new Map(staged.split("\0").filter(Boolean).map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)]));
  let count = 0;
  for (const name of new Set(output.split("\0").filter(Boolean))) {
    if (!isContributionSource(name)) continue;
    const path = resolve(manager.source, name);
    const child = relative(resolve(manager.source), path);
    if (!child || child.startsWith("..") || isAbsolute(child) || /[\r\n\\]/.test(name)) throw new Error("源码路径无效。");
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("发布源码必须是普通文件。");
    for (let parent = dirname(path); parent !== resolve(manager.source); parent = dirname(parent)) {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error("发布源码不能通过目录链接读取。");
    }
    const bytes = await readFile(path);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const entry = remote.get(name);
    const mode = modes.get(name) || (process.platform !== "win32" && (info.mode & 0o111) ? "100755" : "100644");
    if (entry?.type !== "blob" || entry.mode !== mode || entry.sha !== hash)
      throw new Error("PR 合并后的源码与所选本地版本不一致，请重新准备并核验对应版本。");
    remote.delete(name); count++;
  }
  if (!count || remote.size) throw new Error("发布提交包含与所选版本不一致的文件，不能发布。");
}

export async function releaseSource(manager, tools, url) {
  const state = await manager.store.read();
  const receipt = [...(state.pullRequests || []), ...(state.pullRequest ? [state.pullRequest] : [])].find(item => item.url === url);
  if (!receipt || !new RegExp(`^https://github\\.com/${REPOSITORY}/pull/\\d+$`, "i").test(url))
    throw new Error("请选择 Cleo 中已登记的 PR。");
  const build = state.builds.find(item => item.id === receipt.buildId && item.kind === "local");
  if (!state.prepared || state.draftDirty || !build?.sourceHash || build.sourceHash !== receipt.sourceHash
      || ![state.active, state.candidate].includes(build.id) || build.sourceHash !== await manager.sourceHash(tools))
    throw new Error("请先切换到该 PR 对应的本地版本，准备并核验源码。");
  await manager.checkProtection();
  if (build.importHash) await manager.verifyImportedBundle(await manager.store.build(build.id));
  const pr = await api(manager, tools, `${endpoint}/pulls/${url.split("/").at(-1)}`);
  if (!pr.merged || !shaPattern.test(pr.merge_commit_sha || "")) throw new Error("PR 尚未合并，不能作为已合并成果发布。请合并后刷新。");
  if (pr.base?.repo?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() || pr.base.ref !== receipt.targetBranch)
    throw new Error("PR 的目标仓库或分支已变化，请重新核对。");
  await verifyReleaseTree(manager, tools, pr.merge_commit_sha);
  if (build.sourceHash !== await manager.sourceHash(tools)) throw new Error("核验期间源码发生变化，请重新检查。");
  return { repository: REPOSITORY, url, buildId: build.id, sourceHash: build.sourceHash,
    targetBranch: pr.base.ref, commit: pr.merge_commit_sha };
}

export async function previewRelease(manager, { url }) {
  return manager.operation("checking", async () => {
    const tools = await manager.prepareTools(true);
    const access = await checkReleasePermission(manager, tools);
    if (!access.canRelease) throw new Error(access.message);
    return { ...await releaseSource(manager, tools, url), login: access.login };
  }, { prune: false });
}

/** Input: a registered PR URL. Output: its verified remote merge source, without touching local code. */
export async function mergedReleaseSource(manager, tools, url) {
  const state = await manager.store.read();
  const receipt = [...(state.pullRequests || []), ...(state.pullRequest ? [state.pullRequest] : [])].find(item => item.url === url);
  if (!receipt || !new RegExp(`^https://github\\.com/${REPOSITORY}/pull/\\d+$`, "i").test(url))
    throw new Error("请选择 Cleo 中已登记的 PR 版本。");
  const pr = await api(manager, tools, `${endpoint}/pulls/${url.split("/").at(-1)}`);
  if (pr.merged !== true || !shaPattern.test(pr.merge_commit_sha || ""))
    throw new Error("该 PR 尚未合并，暂不可发布。合并后可使用当前选择和版本号重试。");
  if (pr.base?.repo?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() || !receipt.targetBranch || pr.base.ref !== receipt.targetBranch)
    throw new Error("PR 目标仓库或分支与记录不一致，无法核验发布来源。");
  // Pin the merge result, never the moving branch head or the current local build.
  const commit = await api(manager, tools, `${endpoint}/git/commits/${pr.merge_commit_sha}`);
  if (commit.sha !== pr.merge_commit_sha || !shaPattern.test(commit.tree?.sha || ""))
    throw new Error("无法核验 PR 的实际合并提交，未创建 Release。");
  const tree = await api(manager, tools, `${endpoint}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.sha !== commit.tree.sha || tree.truncated || !Array.isArray(tree.tree)
      || !tree.tree.some(item => item.type === "blob") || tree.tree.some(item => !shaPattern.test(item.sha || "")))
    throw new Error("无法完整获取所选 PR 合并提交的源码目录，未创建 Release，请稍后重试。");
  return { repository: REPOSITORY, url, buildId: receipt.buildId, targetBranch: pr.base.ref,
    commit: commit.sha, sourceKind: "merged-pr" };
}

/** Input: PR URL and release metadata. Output: one serialized verification-and-publication result. */
export async function publishMergedRelease(manager, params) {
  return manager.operation("publishing", async () => {
    const tag = typeof params.tag === "string" ? params.tag.trim() : "";
    const title = typeof params.title === "string" ? params.title.trim() || tag : tag;
    const body = params.body ?? "";
    const prerelease = params.prerelease ?? false;
    if (!releaseTagPattern.test(tag) || tag.length > 100)
      throw new Error("请输入合法版本号，例如 v1.2.3 或 v1.2.3-beta.1。");
    if (title.length > 200 || typeof body !== "string" || body.length > 20000 || typeof prerelease !== "boolean")
      throw new Error("发布标题、说明或发布类型无效，请修正后重试。");
    manager.log?.("正在核验 GitHub 发布权限和所选 PR…\n");
    const tools = await manager.tools.prepareGithub({ signal: manager.operationAbort?.signal });
    const access = await checkReleasePermission(manager, tools);
    if (!access.canRelease) throw new Error(access.message);
    if (params.login && params.login !== access.login) throw new Error("GitHub 账号已变化，请确认当前账号后再次发布。");
    const source = await mergedReleaseSource(manager, tools, params.url);
    manager.log?.(`已核验 PR 合并提交 ${source.commit}，正在创建发布草稿…\n`);
    return createVerifiedRelease(manager, tools, { ...source, login: access.login },
      { tag, title, body, prerelease, commit: source.commit });
  }, { prune: false });
}

/** Input: a registered PR URL. Output: remote source evidence for optional package-workflow recovery. */
export async function previewMergedRelease(manager, { url }) {
  return manager.operation("checking", async () => {
    const tools = await manager.tools.prepareGithub({ signal: manager.operationAbort?.signal });
    const access = await checkReleasePermission(manager, tools);
    if (!access.canRelease) throw new Error(access.message);
    return { ...await mergedReleaseSource(manager, tools, url), login: access.login };
  }, { prune: false });
}

async function optionalApi(manager, tools, path) {
  try { return await api(manager, tools, path); }
  catch (error) { if (/\bHTTP 404\b/.test(error.message)) return null; throw error; }
}

export async function tagCommit(manager, tools, tag) {
  const ref = await optionalApi(manager, tools, `${endpoint}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = ref?.object;
  for (let depth = 0; object?.type === "tag" && depth < 8; depth++) {
    object = (await api(manager, tools, `${endpoint}/git/tags/${object.sha}`)).object;
  }
  if (!object) return null;
  if (object.type !== "commit" || !shaPattern.test(object.sha)) throw new Error("无法核验已有标签的提交。");
  return object.sha;
}

/** Authenticated list queries also find drafts hidden by the release-by-tag endpoint. */
export async function findRelease(manager, tools, tag) {
  const published = await optionalApi(manager, tools, `${endpoint}/releases/tags/${encodeURIComponent(tag)}`);
  if (published) return published;
  for (let page = 1; ; page++) {
    const releases = await api(manager, tools, `${endpoint}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("无法读取已有 Release，请检查连接后重试。");
    const match = releases.find(item => item.tag_name === tag);
    if (match) return match;
    if (releases.length < 100) return null;
  }
}

export async function publishRelease(manager, params) {
  return manager.operation("publishing", async () => {
    const { tag, title, body, prerelease, commit, login } = params;
    if (typeof tag !== "string" || !releaseTagPattern.test(tag) || typeof prerelease !== "boolean"
        || typeof title !== "string" || !title.trim() || title.length > 200 || typeof body !== "string" || body.length > 20000)
      throw new Error("请填写有效版本标签、标题和发布类型。");
    const tools = await manager.prepareTools(true);
    const access = await checkReleasePermission(manager, tools);
    if (!access.canRelease) throw new Error(access.message);
    if (access.login !== login) throw new Error("GitHub 账号已变化，请重新预览发布提交。");
    const source = await releaseSource(manager, tools, params.url);
    if (source.commit !== commit) throw new Error("发布提交已变化，请重新预览。");
    return createVerifiedRelease(manager, tools, source, { tag, title, body, prerelease, commit });
  }, { prune: false });
}

/** Purpose: Reject tags that would produce an uninstallable release before creating remote state.
 * Input: immutable source commit and requested tag. Output: matching committed Python/UI versions or an error.
 */
async function verifyReleaseVersion(manager, tools, commit, tag) {
  const contents = async path => {
    const file = await api(manager, tools, `${endpoint}/contents/${path}?ref=${commit}`);
    if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error("无法读取发布源码版本。");
    return Buffer.from(file.content, "base64").toString("utf8");
  };
  const project = (await contents("pyproject.toml")).split(/^\[project\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0];
  const pythonVersion = project?.match(/^version\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
  const uiVersion = JSON.parse(await contents("ui/package.json")).version;
  if (pythonVersion !== tag.replace(/^v/, "") || uiVersion !== pythonVersion)
    throw new Error(`版本号不一致：发布标签 ${tag}，Python ${pythonVersion || "未知"}，桌面 ${uiVersion || "未知"}。请先在 PR 中更新项目版本，再创建发布草稿。`);
}

/** Purpose: Prepare a private release until the package workflow verifies every platform.
 * Input: verified immutable source and metadata. Output: reconciled draft or existing release without publishing it.
 */
async function createVerifiedRelease(manager, tools, source, { tag, title, body, prerelease, commit }) {
  await verifyReleaseVersion(manager, tools, commit, tag);
  const directory = await mkdtemp(join(tmpdir(), "cleo-release-"));
  const post = async (path, payload, method = "POST") => {
    const file = join(directory, "request.json");
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    return JSON.parse(await manager.runCommand(tools.gh, ["api", "--method", method, path, "--input", file], { env: tools.env }));
  };
  try {
    let existingCommit = await tagCommit(manager, tools, tag);
    if (existingCommit && existingCommit !== commit) throw new Error("该标签已指向其他提交，请使用新的版本标签。");
    if (!existingCommit) {
      // Create the exact ref first: GitHub ignores target_commitish when a tag already exists.
      try { await post(`${endpoint}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit }); }
      catch (error) { if (await tagCommit(manager, tools, tag) !== commit) throw error; }
      existingCommit = await tagCommit(manager, tools, tag);
      if (existingCommit !== commit) throw new Error("发布标签与确认的提交不一致。");
    }
    let result = await findRelease(manager, tools, tag);
    if (!result) {
      try { result = await post(`${endpoint}/releases`, { tag_name: tag, target_commitish: commit,
        name: title.trim(), body, draft: true, prerelease, make_latest: "false" }); }
      catch (error) { result = await findRelease(manager, tools, tag); if (!result) throw error; }
    }
    if (result.tag_name !== tag || result.prerelease !== prerelease
        || result.name !== title.trim() || (result.body || "") !== body || await tagCommit(manager, tools, tag) !== commit)
      throw new Error("该标签已有不同的发布内容，请在 GitHub 核对后使用新的版本标签。");
    if (!result.html_url?.startsWith(`https://github.com/${REPOSITORY}/releases/`)) throw new Error("GitHub 未返回有效的 Release 地址，请检查发布结果。");
    return { ...source, tag, title: title.trim(), body, prerelease, draft: result.draft, releaseUrl: result.html_url };
  } catch (error) {
    throw new Error(`${error.message}\n恢复连接或权限后，可重新核对并使用相同标签重试；已有标签和 Release 会先被核验。`, { cause: error });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
