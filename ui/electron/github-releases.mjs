import { t as tr } from "./i18n.mjs";
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
  publish({ status: "checking", repository: REPOSITORY, canRelease: false, message: tr("github_releases.checking_repository_release_permission") });
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
      message: canRelease ? tr("github_releases.you_have_repository_write_access_and_can_create_a_draft_release") : tr("github_releases.this_account_cannot_publish_directly_but_can_still_submit_prs_or_request_branches") });
  } catch {
    return publish({ status: "failed", repository: REPOSITORY, canRelease: false,
      message: tr("github_releases.could_not_confirm_repository_release_permission_check_the_github_connection_and_retry") });
  }
}

/** Compare GitHub's complete merged tree with the prepared source, excluding local-only data. */
async function verifyReleaseTree(manager, tools, commit) {
  const tree = await api(manager, tools, `${endpoint}/git/trees/${commit}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error(tr("github_releases.could_not_fully_verify_the_release_commit_s_source"));
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
    if (!child || child.startsWith("..") || isAbsolute(child) || /[\r\n\\]/.test(name)) throw new Error(tr("github_releases.invalid_source_path"));
    let info;
    try { info = await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(tr("github_releases.release_source_must_consist_of_regular_files"));
    for (let parent = dirname(path); parent !== resolve(manager.source); parent = dirname(parent)) {
      if ((await lstat(parent)).isSymbolicLink()) throw new Error(tr("github_releases.release_source_cannot_be_read_through_directory_links"));
    }
    const bytes = await readFile(path);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const entry = remote.get(name);
    const mode = modes.get(name) || (process.platform !== "win32" && (info.mode & 0o111) ? "100755" : "100644");
    if (entry?.type !== "blob" || entry.mode !== mode || entry.sha !== hash)
      throw new Error(tr("github_releases.the_merged_pr_source_differs_from_the_selected_local_version_prepare_and_verify_the_c"));
    remote.delete(name); count++;
  }
  if (!count || remote.size) throw new Error(tr("github_releases.the_release_commit_contains_files_that_differ_from_the_selected_version_and_cannot_be"));
}

export async function releaseSource(manager, tools, url) {
  const state = await manager.store.read();
  const receipt = [...(state.pullRequests || []), ...(state.pullRequest ? [state.pullRequest] : [])].find(item => item.url === url);
  if (!receipt || !new RegExp(`^https://github\\.com/${REPOSITORY}/pull/\\d+$`, "i").test(url))
    throw new Error(tr("github_releases.choose_a_pr_registered_in_cleo"));
  const build = state.builds.find(item => item.id === receipt.buildId && item.kind === "local");
  if (!state.prepared || state.draftDirty || !build?.sourceHash || build.sourceHash !== receipt.sourceHash
      || ![state.active, state.candidate].includes(build.id) || build.sourceHash !== await manager.sourceHash(tools))
    throw new Error(tr("github_releases.switch_to_the_local_version_associated_with_that_pr_then_prepare_and_verify_its_sourc"));
  await manager.checkProtection();
  if (build.importHash) await manager.verifyImportedBundle(await manager.store.build(build.id));
  const pr = await api(manager, tools, `${endpoint}/pulls/${url.split("/").at(-1)}`);
  if (!pr.merged || !shaPattern.test(pr.merge_commit_sha || "")) throw new Error(tr("github_releases.the_pr_has_not_merged_and_cannot_be_published_as_a_merged_result_refresh_after_mergin"));
  if (pr.base?.repo?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() || pr.base.ref !== receipt.targetBranch)
    throw new Error(tr("github_releases.the_pr_s_target_repository_or_branch_changed_check_again"));
  await verifyReleaseTree(manager, tools, pr.merge_commit_sha);
  if (build.sourceHash !== await manager.sourceHash(tools)) throw new Error(tr("github_releases.the_source_changed_during_verification_check_again"));
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
    throw new Error(tr("github_releases.choose_a_pr_version_registered_in_cleo"));
  const pr = await api(manager, tools, `${endpoint}/pulls/${url.split("/").at(-1)}`);
  if (pr.merged !== true || !shaPattern.test(pr.merge_commit_sha || ""))
    throw new Error(tr("github_releases.this_pr_has_not_merged_and_cannot_be_published_yet_retry_with_the_same_selection_and_"));
  if (pr.base?.repo?.full_name?.toLowerCase() !== REPOSITORY.toLowerCase() || !receipt.targetBranch || pr.base.ref !== receipt.targetBranch)
    throw new Error(tr("github_releases.the_pr_s_target_repository_or_branch_does_not_match_the_record_the_release_source_can"));
  // Pin the merge result, never the moving branch head or the current local build.
  const commit = await api(manager, tools, `${endpoint}/git/commits/${pr.merge_commit_sha}`);
  if (commit.sha !== pr.merge_commit_sha || !shaPattern.test(commit.tree?.sha || ""))
    throw new Error(tr("github_releases.could_not_verify_the_pr_s_actual_merge_commit_no_release_was_created"));
  const tree = await api(manager, tools, `${endpoint}/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.sha !== commit.tree.sha || tree.truncated || !Array.isArray(tree.tree)
      || !tree.tree.some(item => item.type === "blob") || tree.tree.some(item => !shaPattern.test(item.sha || "")))
    throw new Error(tr("github_releases.could_not_fully_retrieve_the_selected_pr_merge_commit_s_source_tree_no_release_was_cr"));
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
      throw new Error(tr("releasepublisher.enter_a_valid_version_such_as_v1_2_3_or_v1_2_3_beta_1"));
    if (title.length > 200 || typeof body !== "string" || body.length > 20000 || typeof prerelease !== "boolean")
      throw new Error(tr("github_releases.the_release_title_notes_or_type_is_invalid_correct_it_and_retry"));
    manager.log?.(tr("github_releases.verifying_github_release_permission_and_the_selected_pr"));
    const tools = await manager.tools.prepareGithub({ signal: manager.operationAbort?.signal });
    const access = await checkReleasePermission(manager, tools);
    if (!access.canRelease) throw new Error(access.message);
    if (params.login && params.login !== access.login) throw new Error(tr("github_releases.the_github_account_changed_confirm_the_current_account_and_publish_again"));
    const source = await mergedReleaseSource(manager, tools, params.url);
    manager.log?.(tr("github_releases.verified_pr_merge_commit_value_creating_a_draft_release", { p0: source.commit }));
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
  }, { readOnly: true });
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
  if (object.type !== "commit" || !shaPattern.test(object.sha)) throw new Error(tr("github_releases.could_not_verify_the_existing_tag_s_commit"));
  return object.sha;
}

/** Authenticated list queries also find drafts hidden by the release-by-tag endpoint. */
export async function findRelease(manager, tools, tag) {
  const published = await optionalApi(manager, tools, `${endpoint}/releases/tags/${encodeURIComponent(tag)}`);
  if (published) return published;
  for (let page = 1; ; page++) {
    const releases = await api(manager, tools, `${endpoint}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error(tr("github_releases.could_not_read_the_existing_release_check_the_connection_and_retry"));
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
      throw new Error(tr("github_releases.enter_a_valid_version_tag_title_and_release_type"));
    const tools = await manager.prepareTools(true);
    const access = await checkReleasePermission(manager, tools);
    if (!access.canRelease) throw new Error(access.message);
    if (access.login !== login) throw new Error(tr("github_releases.the_github_account_changed_preview_the_release_commit_again"));
    const source = await releaseSource(manager, tools, params.url);
    if (source.commit !== commit) throw new Error(tr("github_releases.the_release_commit_changed_preview_again"));
    return createVerifiedRelease(manager, tools, source, { tag, title, body, prerelease, commit });
  }, { prune: false });
}

/** Purpose: Reject tags that would produce an uninstallable release before creating remote state.
 * Input: immutable source commit and requested tag. Output: matching committed Python/UI versions or an error.
 */
async function verifyReleaseVersion(manager, tools, commit, tag) {
  const contents = async path => {
    const file = await api(manager, tools, `${endpoint}/contents/${path}?ref=${commit}`);
    if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error(tr("github_releases.could_not_read_the_release_source_version"));
    return Buffer.from(file.content, "base64").toString("utf8");
  };
  const project = (await contents("pyproject.toml")).split(/^\[project\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0];
  const pythonVersion = project?.match(/^version\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
  const uiVersion = JSON.parse(await contents("ui/package.json")).version;
  if (pythonVersion !== tag.replace(/^v/, "") || uiVersion !== pythonVersion)
    throw new Error(tr("github_releases.version_mismatch_release_tag_value_python_value_desktop_value_update_project_versions", { p0: tag, p1: pythonVersion || tr("contributionmerge.unknown"), p2: uiVersion || tr("contributionmerge.unknown") }));
}

/** Purpose: Prepare a private release until the package workflow verifies every platform.
 * Input: verified immutable source and metadata. Output: reconciled draft or existing release without publishing it.
 */
export async function createVerifiedRelease(manager, tools, source, { tag, title, body, prerelease, commit }) {
  await verifyReleaseVersion(manager, tools, commit, tag);
  const directory = await mkdtemp(join(tmpdir(), "cleo-release-"));
  const post = async (path, payload, method = "POST") => {
    const file = join(directory, "request.json");
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    return JSON.parse(await manager.runCommand(tools.gh, ["api", "--method", method, path, "--input", file], { env: tools.env }));
  };
  try {
    let existingCommit = await tagCommit(manager, tools, tag);
    if (existingCommit && existingCommit !== commit) throw new Error(tr("github_releases.this_tag_points_to_another_commit_use_a_new_version_tag"));
    if (!existingCommit) {
      // Create the exact ref first: GitHub ignores target_commitish when a tag already exists.
      try { await post(`${endpoint}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit }); }
      catch (error) { if (await tagCommit(manager, tools, tag) !== commit) throw error; }
      existingCommit = await tagCommit(manager, tools, tag);
      if (existingCommit !== commit) throw new Error(tr("github_releases.the_release_tag_does_not_match_the_confirmed_commit"));
    }
    let result = await findRelease(manager, tools, tag);
    if (!result) {
      try { result = await post(`${endpoint}/releases`, { tag_name: tag, target_commitish: commit,
        name: title.trim(), body, draft: true, prerelease, make_latest: "false" }); }
      catch (error) { result = await findRelease(manager, tools, tag); if (!result) throw error; }
    }
    if (result.tag_name !== tag || result.prerelease !== prerelease
        || result.name !== title.trim() || (result.body || "") !== body || await tagCommit(manager, tools, tag) !== commit)
      throw new Error(tr("github_releases.this_tag_already_has_different_release_content_check_it_on_github_and_use_a_new_versi"));
    if (!result.html_url?.startsWith(`https://github.com/${REPOSITORY}/releases/`)) throw new Error(tr("github_releases.github_did_not_return_a_valid_release_url_check_the_publishing_result"));
    return { ...source, tag, title: title.trim(), body, prerelease, draft: result.draft, releaseId: result.id, releaseUrl: result.html_url };
  } catch (error) {
    throw new Error(tr("github_releases.value_after_restoring_connectivity_or_permissions_verify_again_and_retry_with_the_sam", { p0: error.message }), { cause: error });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
