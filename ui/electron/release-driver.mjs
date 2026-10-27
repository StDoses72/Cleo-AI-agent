import { t as tr } from "./i18n.mjs";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { CONTRIBUTION_REPOSITORY as REPOSITORY } from "./evolution-contributions.mjs";
import { run } from "./evolution-tools.mjs";
import { checkReleasePermission, mergedReleaseSource, findRelease, tagCommit, createVerifiedRelease, releaseTagPattern } from "./github-releases.mjs";
import { checkedRunResult } from "./release-packages.mjs";

const endpoint = `repos/${REPOSITORY}`;
const workflows = { build: "desktop-platforms.yml", publish: "publish-release.yml" };
const exists = path => access(path).then(() => true, () => false);
export const redactReleaseLog = value => String(value).replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[redacted]")
  .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)\S+/gi, "$1[redacted]").slice(-40000);

/** Own one isolated checkout per job. Remote refs are never borrowed from another release. */
export class GithubReleaseDriver {
  constructor(manager, { runtime, repair, runCommand = run }) {
    this.manager = manager; this.runtime = runtime; this.runRepair = repair; this.command = runCommand;
  }

  directory(job) {
    if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error(tr("release_driver.invalid_publishing_job_path"));
    return join(this.manager.store.root, "release-jobs", job.id);
  }

  async tools(signal) { return this.manager.tools.prepare(true, { signal }); }

  api(tools, path, signal) {
    return this.command(tools.gh, ["api", path], { env: tools.env, signal }).then(JSON.parse);
  }

  adapter(signal) {
    return { ...this.manager, runCommand: (command, args, options) => this.command(command, args, { ...options, signal }) };
  }

  async post(job, tools, path, payload, signal) {
    const file = join(this.directory(job), "request.json");
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
    const output = await this.command(tools.gh, ["api", "--method", "POST", path, "--input", file], { env: tools.env, signal });
    return output.trim() ? JSON.parse(output) : null;
  }

  git(job, tools, args, signal) {
    const helper = `!'${tools.gh.replaceAll("\\", "/").replaceAll("'", "'\\''")}' auth git-credential`;
    return this.command(tools.git, ["-c", "core.hooksPath=", "-c", "credential.helper=", "-c", `credential.helper=${helper}`,
      ...args], { cwd: join(this.directory(job), "source"), env: tools.env, signal });
  }

  async authorize(params) {
    const tag = String(params.tag || "").trim().replace(/^v?/, "v");
    if (!releaseTagPattern.test(tag) || tag.includes("+") || tag.length > 100) throw new Error(tr("release_driver.enter_a_valid_version_number_such_as_v0_4_8"));
    const title = typeof params.title === "string" ? params.title.trim() || tag : tag;
    const body = params.body ?? "", prerelease = params.prerelease ?? false;
    if (title.length > 200 || typeof body !== "string" || body.length > 20000 || typeof prerelease !== "boolean")
      throw new Error(tr("release_driver.invalid_release_title_notes_or_type"));
    const tools = await this.manager.tools.prepareGithub();
    const permission = await checkReleasePermission(this.manager, tools);
    if (!permission.canRelease) throw new Error(permission.message);
    if (params.login && params.login !== permission.login) throw new Error(tr("release_driver.the_github_account_changed_check_release_permission_again"));
    const source = await mergedReleaseSource(this.manager, tools, params.url);
    if (await findRelease(this.manager, tools, tag) || await tagCommit(this.manager, tools, tag))
      throw new Error(tr("release_driver.this_version_already_exists_use_a_new_version_number_existing_releases_will_not_be_ov"));
    return { ...source, sourceCommit: source.commit, login: permission.login, tag, title,
      body: body.replace(/\r\n/g, "\n"), prerelease, runtime: await this.runtime() };
  }

  async assertAccount(tools, job, signal) {
    if ((await this.api(tools, "user", signal)).login !== job.login) throw new Error(tr("release_driver.the_github_account_changed_publishing_is_paused"));
  }

  async prepare(job, signal, checkpoint) {
    const tools = await this.tools(signal);
    await this.assertAccount(tools, job, signal);
    const source = join(this.directory(job), "source");
    await mkdir(source, { recursive: true });
    const branch = job.branch || `codex/release-${job.tag}-${job.id}`;
    await checkpoint({ branch });
    if (!await exists(join(source, ".git"))) await this.git(job, tools, ["init"], signal);
    if (!await this.git(job, tools, ["remote"], signal))
      await this.git(job, tools, ["remote", "add", "origin", `https://github.com/${REPOSITORY}.git`], signal);
    if (!job.commitPrepared) {
      await this.git(job, tools, ["fetch", "--no-tags", "origin", job.sourceCommit], signal);
      // A lost checkpoint may already have left a local commit. Reuse it after checking ancestry.
      const head = await this.git(job, tools, ["rev-parse", "--verify", "HEAD"], signal).catch(() => "");
      if (!head) await this.git(job, tools, ["checkout", "-b", branch, job.sourceCommit], signal);
      else await this.git(job, tools, ["merge-base", "--is-ancestor", job.sourceCommit, "HEAD"], signal);
      await setReleaseVersion(source, job.tag.slice(1));
      await this.git(job, tools, ["add", "--", "pyproject.toml", "ui/package.json", "ui/package-lock.json"], signal);
      const changed = await this.git(job, tools, ["diff", "--cached", "--name-only"], signal);
      if (changed) await this.commit(job, tools, `Prepare ${job.tag}`, signal);
      await checkpoint({ commit: await this.git(job, tools, ["rev-parse", "HEAD"], signal), commitPrepared: true });
    }
    await this.git(job, tools, ["push", "origin", `${job.commit}:refs/heads/${branch}`], signal);
    return { branch };
  }

  commit(job, tools, message, signal) {
    return this.git(job, tools, ["-c", "user.name=Cleo Release", "-c", "user.email=cleo-release@users.noreply.github.com",
      "commit", "--allow-empty", "-m", message], signal);
  }

  async poll(job, publishing, signal, checkpoint) {
    const tools = await this.tools(signal), manager = this.adapter(signal);
    await this.assertAccount(tools, job, signal);
    const kind = publishing ? "publish" : "build", key = `${kind}RunId`, intent = `${kind}DispatchedAt`;
    if (!publishing && !job[key]) await this.git(job, tools, ["push", "origin", `${job.commit}:refs/heads/${job.branch}`], signal);
    if (publishing && (!job.releaseUrl || job.tagUpdateFrom)) {
      if (job.tagUpdateFrom) {
        await this.assertEmptyDraft(job, tools, signal);
        const current = await tagCommit(manager, tools, job.tag);
        if (current !== job.commit) {
          if (current !== job.tagUpdateFrom) throw new Error(tr("release_driver.another_operation_changed_the_release_tag_publishing_stopped"));
          await this.git(job, tools, ["push", `--force-with-lease=refs/tags/${job.tag}:${job.tagUpdateFrom}`,
            "origin", `${job.commit}:refs/tags/${job.tag}`], signal);
        }
      }
      // Only the verified successful build gets a tag. A crash can safely reconcile the same draft.
      await checkpoint({ message: tr("release_driver.all_four_platforms_have_built_preparing_a_draft_release") });
      const result = await createVerifiedRelease(manager, tools, {}, job);
      if (!result.draft) throw new Error(tr("release_driver.this_version_is_already_public_check_the_remote_state_before_retrying"));
      await checkpoint({ releaseUrl: result.releaseUrl, releaseId: result.releaseId, tagUpdateFrom: null });
    }
    let workflowRun;
    if (job[key]) workflowRun = await this.api(tools, `${endpoint}/actions/runs/${job[key]}`, signal);
    else {
      const { workflow_runs: runs } = await this.api(tools,
        `${endpoint}/actions/workflows/${workflows[kind]}/runs?event=workflow_dispatch&head_sha=${job.commit}&per_page=100`, signal);
      workflowRun = runs?.find(r => r.head_sha === job.commit && r.event === "workflow_dispatch"
        && (publishing ? r.display_title === `release ${job.tag} build ${job.buildRunId}` : r.head_branch === job.branch));
      if (!workflowRun && !job[intent]) {
        await checkpoint({ [intent]: new Date().toISOString() });
        await this.post(job, tools, `${endpoint}/actions/workflows/${workflows[kind]}/dispatches`, {
          ref: publishing ? job.tag : job.branch,
          ...(publishing ? { inputs: { run_id: String(job.buildRunId), tag: job.tag, title: job.title,
            notes: job.body, prerelease: String(job.prerelease), allow_existing_release: "true" } } : {}),
        }, signal);
      }
      if (!workflowRun) {
        if (Date.now() - Date.parse(job[intent]) > 180000)
          throw new Error(tr("release_driver.the_submitted_build_was_not_found_check_actions_permissions_and_workflows_on_github_i"));
        return { status: "running", message: publishing ? tr("release_driver.queued_for_verification_and_package_upload") : tr("release_driver.platform_builds_submitted_waiting_for_execution") };
      }
      await checkpoint({ [key]: String(workflowRun.id), workflowUrl: workflowRun.html_url });
    }
    if (workflowRun.head_sha !== job.commit || workflowRun.event !== "workflow_dispatch") throw new Error(tr("release_driver.the_workflow_source_commit_does_not_match_publishing_stopped"));
    if (job.retryRun && Number(workflowRun.run_attempt) < job.retryRun.attempt) {
      if (Date.now() - Date.parse(job.retryRun.at) > 180000) throw new Error(tr("release_driver.could_not_confirm_that_the_retry_started_check_github_actions"));
      return { status: "running", message: tr("release_driver.waiting_for_build_retry") };
    }
    if (workflowRun.status !== "completed") {
      if (Date.now() - Date.parse(workflowRun.created_at) > 3 * 3600000) throw new Error(tr("release_driver.publishing_has_waited_over_three_hours_check_github_actions_before_continuing"));
      const { jobs } = await this.api(tools, `${endpoint}/actions/runs/${workflowRun.id}/jobs?per_page=100`, signal);
      return { status: "running", message: publishing ? tr("release_driver.verifying_and_uploading_assets_then_publishing")
        : tr("release_driver.building_platform_installation_packages_value_value", { p0: jobs.filter(j => j.conclusion === "success").length, p1: jobs.length || 4 }) };
    }
    if (workflowRun.conclusion === "success") return { status: "success" };
    const logs = await this.command(tools.gh, ["run", "view", String(workflowRun.id), "--repo", REPOSITORY, "--log-failed"],
      { env: tools.env, signal, outputMode: "tail" });
    return { status: "failed", diagnostics: redactReleaseLog(logs || tr("release_driver.workflow_result_value", { p0: workflowRun.conclusion })) };
  }

  async repair(job, signal, checkpoint) {
    const tools = await this.tools(signal);
    await this.assertAccount(tools, job, signal);
    if (job.retryRun) return { changed: false };
    if (job.repairResult) {
      await this.git(job, tools, ["push", "origin", `${job.commit}:refs/heads/${job.branch}`], signal);
      return job.repairResult;
    }
    if (job.repairCommitBase) return this.finishRepair(job, tools, signal, checkpoint);
    const source = join(this.directory(job), "source");
    // The agent cannot push. Only this controller publishes checked changes on the job's own branch.
    await this.runRepair({ source, runtime: job.runtime, diagnostics: job.diagnostics, publishing: job.repairPhase === "publishing" }, signal);
    const changes = await this.git(job, tools, ["status", "--porcelain", "--untracked-files=all"], signal);
    if (changes && job.repairPhase === "publishing") await this.assertEmptyDraft(job, tools, signal);
    if (changes) {
      const names = (await this.git(job, tools, ["diff", "--name-only", "HEAD"], signal)) + "\n"
        + await this.git(job, tools, ["ls-files", "--others", "--exclude-standard"], signal);
      if (names.split(/\r?\n/).some(name => /^(\.github\/|ui\/electron\/release-|AGENTS\.md$)/.test(name)))
        throw new Error(tr("release_driver.the_automatic_repair_touches_release_verification_or_workflows_the_repair_is_preserve"));
      await setReleaseVersion(source, job.tag.slice(1));
      await this.validateRepair(job, tools, signal);
      await checkpoint({ repairCommitBase: job.commit });
      return this.finishRepair(job, tools, signal, checkpoint);
    }
    const runId = job.repairPhase === "publishing" ? job.publishRunId : job.buildRunId;
    const current = await this.api(tools, `${endpoint}/actions/runs/${runId}`, signal);
    await checkpoint({ retryRun: { attempt: Number(current.run_attempt) + 1, at: new Date().toISOString() } });
    await this.post(job, tools, `${endpoint}/actions/runs/${runId}/rerun-failed-jobs`, {}, signal);
    return { changed: false };
  }

  /** Purpose: Catch compilation failures before publishing an automatic repair.
   * Input: isolated job checkout, managed tools and cancellation signal.
   * Output: successful local release checks, or an error before commit and push.
   */
  async validateRepair(job, tools, signal) {
    const options = { cwd: join(this.directory(job), "source", "ui"), env: tools.env, signal };
    await this.command(tools.node, [tools.npm, "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], options);
    await this.command(tools.node, [tools.npm, "run", "check:release"], options);
  }

  /** Reconcile a controller commit or push interrupted between Git and the journal write. */
  async finishRepair(job, tools, signal, checkpoint) {
    let commit = await this.git(job, tools, ["rev-parse", "HEAD"], signal);
    if (commit === job.repairCommitBase) {
      await this.git(job, tools, ["add", "--all"], signal);
      await this.commit(job, tools, `Fix ${job.tag} build (attempt ${job.attempt})`, signal);
      commit = await this.git(job, tools, ["rev-parse", "HEAD"], signal);
    } else {
      const lineage = await this.git(job, tools, ["rev-list", "--parents", "-n", "1", "HEAD"], signal);
      if (lineage !== `${commit} ${job.repairCommitBase}`) throw new Error(tr("release_driver.repair_commit_history_changed_check_the_isolated_release_workspace"));
    }
    await checkpoint({ ...(job.repairPhase === "publishing" ? { tagUpdateFrom: job.repairCommitBase,
      publishRunId: null, publishDispatchedAt: null } : {}), commit,
      repairCommitBase: null, repairResult: { changed: true }, buildRunId: null, buildDispatchedAt: null, retryRun: null });
    await this.git(job, tools, ["push", "origin", `${commit}:refs/heads/${job.branch}`], signal);
    return job.repairResult;
  }

  async verify(job, signal) {
    const tools = await this.tools(signal);
    const workflowRun = await this.api(tools, `${endpoint}/actions/runs/${job.publishRunId}`, signal);
    const result = await checkedRunResult(this.adapter(signal), tools, { ...job, runId: job.buildRunId }, workflowRun);
    if (result.status !== "completed") throw new Error(tr("release_driver.remote_packages_checksums_or_version_manifests_are_incomplete_publication_cannot_be_c"));
    return { releaseUrl: result.releaseUrl };
  }

  async assertEmptyDraft(job, tools, signal) {
    const release = await findRelease(this.adapter(signal), tools, job.tag);
    if (!job.releaseId || release?.id !== job.releaseId || !release.draft || release.assets?.length)
      throw new Error(tr("release_driver.existing_release_content_cannot_be_replaced_automatically_the_repair_is_preserved_rev"));
  }

  async cancel(job) {
    const tools = await this.tools();
    await this.assertAccount(tools, job);
    const ids = new Set([job.buildRunId, job.publishRunId].filter(Boolean));
    for (const kind of ["build", "publish"]) {
      if (!job[`${kind}DispatchedAt`] || job[`${kind}RunId`]) continue;
      const { workflow_runs: runs } = await this.api(tools,
        `${endpoint}/actions/workflows/${workflows[kind]}/runs?event=workflow_dispatch&head_sha=${job.commit}&per_page=100`);
      const matched = runs?.find(r => r.head_sha === job.commit && (kind === "build" ? r.head_branch === job.branch
        : r.display_title === `release ${job.tag} build ${job.buildRunId}`));
      if (!matched) throw new Error(tr("release_driver.the_remote_service_has_not_returned_the_submitted_workflow_yet_check_github_actions_a"));
      ids.add(String(matched.id));
    }
    for (const id of ids) {
      const current = await this.api(tools, `${endpoint}/actions/runs/${id}`);
      if (current.status !== "completed") await this.post(job, tools, `${endpoint}/actions/runs/${id}/cancel`, {});
    }
  }
}

/** Update the three committed version declarations together before remote build dispatch. */
export async function setReleaseVersion(source, version) {
  const path = join(source, "pyproject.toml");
  const original = await readFile(path, "utf8");
  const project = /(^\[project\][\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  let replaced = false;
  const updated = original.replace(project, section => section.replace(/^version\s*=\s*["'][^"']+["']/m, () => {
    replaced = true; return `version = "${version}"`;
  }));
  if (!replaced) throw new Error(tr("release_driver.project_version_number_not_found_cannot_prepare_the_release"));
  await writeFile(path, updated);
  for (const name of ["package.json", "package-lock.json"]) {
    const file = join(source, "ui", name), value = JSON.parse(await readFile(file, "utf8"));
    value.version = version;
    if (value.packages?.[""]) value.packages[""].version = version;
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  }
}
