import { t as tr } from "./i18n.mjs";
import { createHash } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export const CONTRIBUTION_REPOSITORY = "StDoses72/Cleo-AI-agent";

/** Purpose: Reject missing/protected targets before any remote mutation. Input: branch. Output: canonical branch name. */
export function contributionTarget(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error(tr("evolution_contributions.choose_a_target_branch_submitting_to_main_by_default_is_not_allowed"));
  const branch = value.trim().replace(/^refs\/heads\//, "");
  if (branch.toLowerCase() === "main") throw new Error(tr("evolution_contributions.the_main_branch_cannot_be_a_pr_target"));
  if (branch.toLowerCase() === "submission-base") throw new Error(tr("evolution_contributions.submission_base_is_an_empty_template_create_a_separate_receiving_branch_from_it_befor"));
  if (branch.length > 200 || branch.startsWith("-") || branch.startsWith("refs/")) throw new Error(tr("evolution_contributions.invalid_target_branch_name"));
  return branch;
}

/** Purpose: Validate Git syntax locally. Input: controller, tools, branch. Output: rejection before publishing. */
export async function validateContributionTarget(manager, tools, branch) {
  try { await manager.runCommand(tools.git, ["check-ref-format", `refs/heads/${branch}`], { env: tools.env }); }
  catch { throw new Error(tr("evolution_contributions.invalid_target_branch_name_use_a_valid_git_branch_name")); }
}

/** Purpose: Require a real upstream target. Input: validated name. Output: verified branch, never a newly created ref. */
export async function requireTargetBranch(manager, tools, branch) {
  let result;
  try {
    result = JSON.parse(await manager.runCommand(tools.gh,
      ["api", `repos/${CONTRIBUTION_REPOSITORY}/branches/${encodeURIComponent(branch)}`, "--method", "GET"], { env: tools.env }));
  } catch (error) {
    if (/HTTP 404/.test(error.message)) throw new Error(tr("evolution_contributions.the_target_branch_does_not_exist_or_your_account_cannot_view_it_wait_for_a_maintainer"));
    throw error;
  }
  if (result.name !== branch) throw new Error(tr("evolution_contributions.the_target_branch_has_not_been_created_wait_for_a_maintainer_to_create_it"));
  return result;
}

/** Purpose: List upstream choices without a main fallback. Input: manager. Output: target branch names. */
export async function listContributionBranches(manager) {
  return manager.operation("checking", async () => {
    const tools = await manager.tools.prepare(true);
    const output = await manager.runCommand(tools.gh, ["api", `repos/${CONTRIBUTION_REPOSITORY}/branches?per_page=100`,
      "--paginate", "--jq", ".[].name"], { env: tools.env });
    return output.split(/\r?\n/).filter((name) => name && !["main", "submission-base"].includes(name.toLowerCase()));
  }, { readOnly: true });
}

/** Purpose: Submit a durable branch-creation application via Issues, without pushing or creating any branch.
 * Input: explicit branch, explanation, selected build and stable request ID. Output: an issue receipt; readiness is checked separately.
 */
export async function requestTargetBranch(manager, { targetBranch, body, buildId, submissionId }) {
  const branch = contributionTarget(targetBranch);
  if (typeof body !== "string" || !body.trim() || body.length > 20000) throw new Error(tr("evolution_contributions.provide_a_description_for_the_new_target_branch_request"));
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(submissionId)) throw new Error(tr("evolution_contributions.invalid_request_identifier"));
  return manager.operation("submitting", async () => {
    const state = await manager.store.read();
    const build = state.builds.find((item) => item.id === buildId && item.kind === "local" && item.sourceHash);
    if (!build) throw new Error(tr("evolution_contributions.choose_a_valid_local_cleo_version"));
    const contentHash = createHash("sha256").update(JSON.stringify([branch, body, buildId, build.sourceHash])).digest("hex");
    const previous = state.branchRequests?.find((item) => item.id === submissionId);
    if (previous && previous.contentHash !== contentHash) throw new Error(tr("evolution_contributions.the_request_content_changed_submit_a_new_request"));
    if (previous?.url) return previous;
    const tools = await manager.tools.prepare(true);
    await validateContributionTarget(manager, tools, branch);
    await manager.runCommand(tools.gh, ["auth", "status"], { env: tools.env });
    const user = JSON.parse(await manager.runCommand(tools.gh, ["api", "user"], { env: tools.env }));
    if (previous && previous.owner !== user.login) throw new Error(tr("evolution_contributions.the_requesting_account_changed_submit_a_new_request"));
    const marker = `<!-- cleo-branch-request:${submissionId} -->`;
    const find = async () => {
      const issues = JSON.parse(await manager.runCommand(tools.gh, ["issue", "list", "--repo", CONTRIBUTION_REPOSITORY,
        "--state", "all", "--author", "@me", "--limit", "1000", "--json", "url,body"], { env: tools.env }));
      return issues.find((issue) => issue.body?.includes(marker))?.url;
    };
    const pending = previous || { id: submissionId, branch, body, buildId, sourceHash: build.sourceHash,
      buildName: build.name || buildId, owner: user.login, contentHash, createdAt: new Date().toISOString(), status: "pending" };
    if (!previous) await manager.store.update({ branchRequests: [...(state.branchRequests || []), pending] });
    let url = await find();
    if (!url) {
      const bodyFile = join(manager.store.root, `branch-request-${submissionId}.md`);
      try {
        await writeFile(bodyFile, tr("evolution_contributions.value_request_to_create_target_branch_value_value", { p0: marker, p1: branch, p2: body })
          + tr("evolution_contributions.local_cleo_version_value_source_digest_value", { p0: pending.buildName, p1: build.sourceHash })
          + tr("evolution_contributions.this_is_a_branch_creation_request_not_confirmation_that_a_branch_exists_the_repositor")
          + tr("evolution_contributions.to_create_it_in_github_s_create_a_branch_dialog_set_source_to_submission_base_and_the", { p0: branch })
          + tr("evolution_contributions.keep_the_new_branch_empty_do_not_add_a_readme_or_other_files")
          + tr("evolution_contributions.after_creation_the_requester_will_submit_a_separate_pr_containing_a_full_program_sour"), "utf8");
        try {
          url = await manager.runCommand(tools.gh, ["issue", "create", "--repo", CONTRIBUTION_REPOSITORY,
            "--title", tr("evolution_contributions.request_a_new_target_branch_value", { p0: branch }), "--body-file", bodyFile], { env: tools.env });
        } catch (error) { url = await find(); if (!url) throw error; }
      } finally { await rm(bodyFile, { force: true }); }
    }
    if (!new RegExp(`^https://github\\.com/${CONTRIBUTION_REPOSITORY}/issues/\\d+$`, "i").test(url))
      throw new Error(tr("evolution_contributions.github_did_not_return_a_valid_request_url_retry_to_confirm"));
    const receipt = { ...pending, url, status: "requested" };
    const current = await manager.store.read();
    await manager.store.update({ branchRequests: current.branchRequests.map((item) => item.id === submissionId ? receipt : item) });
    return receipt;
  });
}

/** Purpose: Check whether maintainers created an applied-for branch. Input: receipt ID. Output: refreshed readiness only. */
export async function refreshTargetBranch(manager, id) {
  return manager.operation("checking", async () => {
    const state = await manager.store.read();
    const request = state.branchRequests?.find((item) => item.id === id && item.url);
    if (!request) throw new Error(tr("evolution_contributions.the_submitted_target_branch_request_was_not_found"));
    const branch = contributionTarget(request.branch);
    const tools = await manager.tools.prepare(true);
    await requireTargetBranch(manager, tools, branch);
    const receipt = { ...request, status: "ready", checkedAt: new Date().toISOString() };
    await manager.store.update({ branchRequests: state.branchRequests.map((item) => item.id === id ? receipt : item) });
    return receipt;
  });
}
