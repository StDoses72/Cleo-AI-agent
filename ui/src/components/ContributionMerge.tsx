import { getLanguage } from "../../electron/i18n.mjs";
import { t as tr } from "../../electron/i18n.mjs";
import { useAutomaticRead } from "../useAutomaticRead";

export interface MergeReport {
  url?: string; state?: string; targetBranch: string; headBranch?: string;
  headSha: string; baseSha: string; compatible?: boolean; conflicts?: string[];
  mergeable?: string; mergeStateStatus?: string; canUpdate?: boolean; permissionError?: string; probeError?: string; checkedAt: string;
  checks?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string }[];
  snapshotFormat?: string; fileCount?: number;
}
interface Props {
  params: Record<string, unknown>; busy: boolean;
  revision?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
}

/** Purpose: Show fresh merge evidence and an explicit repair handoff. Input: PR or selected target. Output: inspect/repair controls. */
export function ContributionMerge({ params, busy, onAction, revision = "" }: Props) {
  const check = useAutomaticRead(JSON.stringify([params, revision]), !busy, async () => {
    const value = await onAction(params.url ? "mergeAssistance" : "checkContribution", params);
    if (!value || typeof value !== "object" || !("baseSha" in value)) throw new Error(tr("contributionmerge.could_not_load_check_results_try_again"));
    return value as MergeReport;
  });
  const report = check.data;
  const conclusions = report?.checks?.map(item => item.conclusion || item.state || item.status || "UNKNOWN") ?? [];
  const failed = conclusions.some(value => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(value));
  const checking = conclusions.some(value => ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"].includes(value));
  const checksLabel = failed ? tr("contributionmerge.checks_failed") : checking ? tr("contributionmerge.checks_running") : conclusions.length && conclusions.every(value => value === "SUCCESS") ? tr("contributionmerge.checks_passed") : tr("contributionmerge.check_results_pending");
  const closed = report?.state === "MERGED" || report?.state === "CLOSED";
  const needsRepair = report?.state === "OPEN" && (report.compatible === false || failed || report.probeError);
  return <section ref={check.root} className="contribution-check" aria-label={params.url ? tr("contributionmerge.pr_merge_assistance") : tr("contributionmerge.submission_compatibility")}>
    {check.pending && !report && <p role="status">{tr("contributionmerge.loading")}{params.url ? tr("contributionmerge.pr_status") : tr("contributionmerge.submission_requirements")}…</p>}
    {check.error && <p role="alert">{check.error} <button type="button" disabled={busy || check.pending} onClick={() => void check.retry()}>{tr("app.retry")}</button></p>}
    {report && <div role="status">
      <p>{report.state === "MERGED" ? tr("contributionmerge.merged") : report.state === "CLOSED" ? tr("contributionmerge.closed") : report.snapshotFormat === "empty-target-snapshot-v1" ? tr("contributionmerge.changes_can_be_submitted_to_this_branch") : report.compatible === true ? tr("contributionmerge.no_textual_conflicts") : report.compatible === false ? tr("contributionmerge.merge_conflicts_found") : tr("contributionmerge.merge_requirements_pending")}
        {report.url && !closed && ` · ${checksLabel}`}</p>
      {report.probeError && <p role="alert">{report.probeError}</p>}
      {Boolean(report.conflicts?.length) && <ul>{report.conflicts?.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
      {report.url && <p><a href={`${report.url}/files`} target="_blank" rel="noreferrer">{tr("contributionmerge.view_changes")}</a> · <a href={`${report.url}/checks`} target="_blank" rel="noreferrer">{tr("contributionmerge.view_check_details")}</a></p>}
      {!closed && report.canUpdate === false && <p>{tr("contributionmerge.you_do_not_have_write_access_to_the_source_repository_the_author_or_a_maintainer_must")}</p>}
      {report.url && !closed && report.canUpdate === undefined && <p>{tr("contributionmerge.write_access_has_not_been_confirmed")}{report.permissionError}</p>}
      {needsRepair && <button type="button" disabled={busy || check.pending}
        onClick={() => void onAction("repairContribution", params)}>{tr("contributionmerge.investigate_and_fix_the_original_pr")}</button>}
      <details><summary>{tr("contributionmerge.check_details")}</summary>
        <p>{tr("contributionmerge.target")}{report.targetBranch} · {report.baseSha}<br />{tr("contributionmerge.source")}{report.headBranch || tr("contributionmerge.selected_version")} · {report.headSha}</p>
        {report.fileCount !== undefined && <p>{tr("contributionmerge.commit")}{report.fileCount} {tr("contributionmerge.source_files")}</p>}
        <small>{new Date(report.checkedAt).toLocaleString(getLanguage())} {tr("contributionmerge.having_no_textual_conflicts_does_not_mean_review_requirements_are_satisfied")}</small>
        {report.mergeStateStatus && <p>{tr("contributionmerge.github_merge_status")}{report.mergeStateStatus}</p>}
        {report.checks && (report.checks.length ? <ul>{report.checks.map((item, index) => <li key={index}>{item.name || item.context || tr("contributionmerge.checks")}{tr("punctuation.colon")}{item.conclusion || item.state || item.status || tr("contributionmerge.unknown")}</li>)}</ul> : <p>{tr("contributionmerge.no_ci_check_results_yet")}</p>)}
      </details>
    </div>}
  </section>;
}
