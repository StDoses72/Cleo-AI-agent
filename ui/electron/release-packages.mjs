import { t as tr } from "./i18n.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTRIBUTION_REPOSITORY as REPOSITORY } from "./evolution-contributions.mjs";
import { checkReleasePermission, releaseSource, mergedReleaseSource, tagCommit, findRelease, releaseTagPattern } from "./github-releases.mjs";

const endpoint = `repos/${REPOSITORY}`;
const workflow = "publish-release.yml";
const targets = ["windows-x64", "macos-arm64", "macos-x64", "linux-x64"];
const json = async (manager, tools, path) => JSON.parse(await manager.runCommand(tools.gh, ["api", path], { env: tools.env }));

async function checkedSource(manager, tools, params) {
  const access = await checkReleasePermission(manager, tools);
  if (!access.canRelease) throw new Error(access.message);
  if (params.login !== access.login) throw new Error(tr("release_packages.the_account_changed_verify_the_release_commit_again"));
  const source = await (params.sourceKind === "merged-pr" ? mergedReleaseSource : releaseSource)(manager, tools, params.url);
  if (source.commit !== params.commit) throw new Error(tr("release_packages.the_commit_changed_verify_the_release_commit_again"));
  return source;
}

/** Match complete, nonexpired platform artifacts to the exact successful build. */
async function buildArtifacts(manager, tools, run) {
  const { artifacts } = await json(manager, tools, `${endpoint}/actions/runs/${run.id}/artifacts?per_page=100`);
  return targets.every(target => artifacts?.some(item => item.name === `desktop-${target}` && !item.expired && item.size_in_bytes > 0));
}

export async function releaseBuilds(manager, params) {
  return manager.operation("checking", async () => {
    const tools = await manager.prepareTools(true);
    const source = await checkedSource(manager, tools, params);
    const { workflow_runs: runs } = await json(manager, tools,
      `${endpoint}/actions/workflows/desktop-platforms.yml/runs?head_sha=${source.commit}&event=workflow_dispatch&status=success&per_page=100`);
    const available = [];
    for (const run of runs || []) {
      if (run.head_sha === source.commit && run.status === "completed" && run.conclusion === "success"
          && run.event === "workflow_dispatch" && await buildArtifacts(manager, tools, run))
        available.push({ id: String(run.id), url: run.html_url, createdAt: run.created_at });
    }
    return available;
  }, { prune: false });
}

function validateSelection(params) {
  if (!/^\d+$/.test(String(params.runId)) || !releaseTagPattern.test(params.tag || "") || !params.tag.startsWith("v")
      || !/^[a-f0-9]{40}$/.test(params.commit || "")) throw new Error(tr("release_packages.choose_a_build_and_enter_a_tag_starting_with_v_that_matches_the_project_version"));
}

async function publicationRun(manager, tools, params) {
  const title = `release ${params.tag} build ${params.runId}`;
  const { workflow_runs: runs } = await json(manager, tools, `${endpoint}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`);
  return (runs || []).find(run => run.display_title === title && run.event === "workflow_dispatch");
}

function runResult(run) {
  return { status: run.status === "completed" ? (run.conclusion === "success" ? "completed" : "failed") : "running",
    workflowRunId: String(run.id), workflowUrl: run.html_url, conclusion: run.conclusion };
}

export async function checkedRunResult(manager, tools, params, run) {
  const result = runResult(run);
  if (result.status !== "completed") return result;
  if (await tagCommit(manager, tools, params.tag) !== params.commit) throw new Error(tr("release_packages.the_tag_s_commit_changed_check_github_package_publication_cannot_be_confirmed"));
  const build = await json(manager, tools, `${endpoint}/actions/runs/${params.runId}`);
  if (build.head_sha !== params.commit) throw new Error(tr("release_packages.the_build_and_release_commits_do_not_match"));
  const release = await findRelease(manager, tools, params.tag);
  const names = new Set(release?.assets?.map(item => item.name));
  const expected = targets.flatMap(target => [`Cleo-${target}${target === "linux-x64" ? ".tar.gz" : ".zip"}`,
    `Cleo-${target}.sha256`, target === "windows-x64" ? "release.json" : `release-${target}.json`]);
  expected.push("Cleo-linux-x64.deb", "Cleo-linux-x64.deb.sha256");
  const installers = ["Cleo-windows-x64-setup.exe", "Cleo-macos-arm64.pkg", "Cleo-macos-x64.pkg"]
    .flatMap(name => [name, `${name}.sha256`]);
  // Legacy releases have no installer assets; a new release must have the whole set.
  if (installers.some(name => names.has(name))) expected.push(...installers);
  if (!release || release.draft || release.name !== params.title?.trim() || (release.body || "") !== params.body
      || release.prerelease !== params.prerelease || !expected.every(name => names.has(name)) || names.size !== expected.length
      || release.assets.length !== expected.length
      || release.assets.some(asset => asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")))
    return { ...result, status: "incomplete" };
  return { ...result, releaseUrl: release.html_url };
}

/** Dispatch is explicit; a matching in-flight/successful run reconciles a lost response. */
export async function publishReleasePackages(manager, params) {
  validateSelection(params);
  if (typeof params.body !== "string") throw new Error(tr("release_packages.invalid_release_notes_format_check_again"));
  return manager.operation("publishing", async () => {
    const tools = await manager.prepareTools(true);
    const source = await checkedSource(manager, tools, params);
    const run = await json(manager, tools, `${endpoint}/actions/runs/${params.runId}`);
    const desktop = await json(manager, tools, `${endpoint}/actions/workflows/desktop-platforms.yml`);
    if (run.workflow_id !== desktop.id || run.head_sha !== source.commit || run.status !== "completed"
        || run.conclusion !== "success" || run.event !== "workflow_dispatch" || !await buildArtifacts(manager, tools, run))
      throw new Error(tr("release_packages.the_build_must_be_a_successful_manual_desktop_platforms_run_for_this_commit_with_unex"));
    if (await tagCommit(manager, tools, params.tag) !== source.commit) throw new Error(tr("release_packages.the_tag_and_build_commits_differ_the_tag_will_not_be_rewritten"));
    const release = await findRelease(manager, tools, params.tag);
    if (!release || release.name !== params.title?.trim() || (release.body || "") !== params.body || release.prerelease !== params.prerelease)
      throw new Error(tr("release_packages.create_or_verify_the_release_for_this_tag_first_its_title_notes_and_type_must_match_t"));
    const existing = await publicationRun(manager, tools, params);
    if (existing && (existing.status !== "completed" || existing.conclusion === "success")) {
      const current = await checkedRunResult(manager, tools, params, existing);
      if (current.status !== "incomplete") return current;
    }
    // Use the verified release ref so snapshot releases do not depend on an older default branch.
    const file = await json(manager, tools, `${endpoint}/contents/.github/workflows/${workflow}?ref=${encodeURIComponent(params.tag)}`);
    const text = file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : "";
    if (!text.includes("allow_existing_release:") || !text.includes("prerelease:"))
      throw new Error(tr("release_packages.this_version_s_publishing_workflow_does_not_yet_support_app_integration_update_publis"));
    const directory = await mkdtemp(join(tmpdir(), "cleo-package-dispatch-"));
    try {
      const input = join(directory, "dispatch.json");
      await writeFile(input, JSON.stringify({ ref: params.tag, inputs: {
        run_id: String(params.runId), tag: params.tag, notes: params.body, title: params.title.trim(),
        prerelease: String(params.prerelease), allow_existing_release: "true",
      } }), { mode: 0o600 });
      try {
        await manager.runCommand(tools.gh, ["api", "--method", "POST", `${endpoint}/actions/workflows/${workflow}/dispatches`, "--input", input], { env: tools.env });
      } catch {
        const accepted = await publicationRun(manager, tools, params).catch(() => null);
        if (accepted && accepted.id !== existing?.id) return checkedRunResult(manager, tools, params, accepted);
        throw new Error(tr("release_packages.could_not_confirm_whether_the_workflow_accepted_the_request_refresh_package_status_fi"));
      }
      const accepted = await publicationRun(manager, tools, params).catch(() => null);
      return accepted && accepted.id !== existing?.id ? checkedRunResult(manager, tools, params, accepted)
        : { status: "submitted", workflowUrl: `https://github.com/${REPOSITORY}/actions/workflows/${workflow}` };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, { prune: false });
}

/** Only a successful workflow AND the complete asset set can report package publication. */
export async function releasePackageStatus(manager, params) {
  validateSelection(params);
  return manager.operation("checking", async () => {
    const tools = await manager.tools.prepareGithub({ signal: manager.operationAbort?.signal });
    const run = await publicationRun(manager, tools, params);
    if (!run) return { status: "unknown", workflowUrl: `https://github.com/${REPOSITORY}/actions/workflows/${workflow}` };
    return checkedRunResult(manager, tools, params, run);
  }, { prune: false });
}
