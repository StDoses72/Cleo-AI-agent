import { t as tr } from "../../electron/i18n.mjs";
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useAutomaticRead } from "../useAutomaticRead";
import type { EvolutionBranchRequest, EvolutionState } from "../evolution-types";
import { ContributionMerge } from "./ContributionMerge";

interface Props {
  state: EvolutionState | null;
  busy: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy: (busy: boolean) => void;
  onSubmitted: (url: string) => void;
  /** Open the release dialog, preselecting the local version chosen here. */
  onRelease?: (buildId: string) => void;
  initialBuildId?: string;
}
const forbidden = (value: string) => ["main", "submission-base"].includes(value.trim().replace(/^refs\/heads\//, "").toLowerCase());

/** Purpose: Separate a fork PR from an application for an upstream target branch.
 * Input: saved versions, controller actions. Output: explicit target/version selection and truthful application receipts.
 */
export function EvolutionContribution({ state, busy, onAction, onBusy, onSubmitted, onRelease, initialBuildId }: Props) {
  const [mode, setMode] = useState("existing");
  const [target, setTarget] = useState("");
  const [buildId, setBuildId] = useState(initialBuildId || state?.candidate || state?.active || "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<EvolutionBranchRequest | null>(null);
  const attempt = useRef<string | null>(null);
  const inFlight = useRef(false);
  const versions = state?.builds.filter((b) => b.kind === "local" && (b.sourceHash || b.importHash) && (b.savedAt || b.id === state.active || b.id === state.candidate)) || [];
  const version = versions.find((b) => b.id === buildId);
  const locked = busy || pending;
  const account = useRef(state?.githubAuth?.repositoryAccess?.login);
  if (state?.githubAuth?.repositoryAccess?.login) account.current = state.githubAuth.repositoryAccess.login;
  const catalog = useAutomaticRead(`branches:${account.current ?? ""}`, !locked && state?.githubAuth?.status === "connected", async () => {
    const result = await onAction("contributionBranches");
    if (!Array.isArray(result) || result.some(name => typeof name !== "string")) throw new Error(tr("evolutioncontribution.could_not_read_the_target_branch_try_again"));
    return result.filter((name: string) => !forbidden(name)) as string[];
  });
  const branches = catalog.data ?? [];
  const change = () => { attempt.current = null; setReceipt(null); setError(""); };
  /** Purpose: Pin one explicit user intent through retries. Input: form. Output: PR or branch application, never a merge. */
  const submit = async () => {
    if (inFlight.current || locked || (mode === "existing" && (!branches.includes(target) || catalog.error))) return;
    if (!target.trim() || forbidden(target)) { setError(tr("evolutioncontribution.choose_a_separate_receiving_branch_the_main_branch_and_submission_base_template_canno")); return; }
    if (!version?.sourceHash) { setError(tr("evolutioncontribution.prepare_and_verify_the_source_for_the_selected_version_first")); return; }
    inFlight.current = true; setPending(true); onBusy(true); setError("");
    try {
      attempt.current ||= crypto.randomUUID();
      const result = await onAction(mode === "existing" ? "submit" : "requestBranch", {
        targetBranch: target, buildId, title, body, submissionId: attempt.current,
      });
      if (mode === "existing" && typeof result === "string" && /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(result)) {
        onSubmitted(result);
      } else if (mode === "request" && result && typeof result === "object" && "url" in result) {
        setReceipt(result as EvolutionBranchRequest);
      } else throw new Error(tr("evolutioncontribution.no_submission_result_was_received_retry_to_confirm"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy(false); }
  };
  return <section ref={catalog.root} aria-label={tr("evolutioncontribution.contribute_changes")}>
    {state?.githubAuth?.repositoryAccess?.canRelease && onRelease && <div className="evolution-release-entry">
      <span>{tr("evolutioncontribution.publish_release")}</span>
      <button type="button" className="evolution-primary" disabled={locked} onClick={() => onRelease(buildId)}><Upload size={14} />Release</button>
    </div>}
    <label>{tr("evolutioncontribution.submission_method")}<select aria-label={tr("evolutioncontribution.submission_method")} value={mode} disabled={pending} onChange={(e) => { change(); setMode(e.target.value); setTarget(""); }}>
      <option value="existing">{tr("evolutioncontribution.submit_a_pr_to_an_existing_branch")}</option>
      <option value="request">{tr("evolutioncontribution.request_a_new_target_branch")}</option>
    </select></label>
    <label>{tr("evolutioncontribution.submit_local_version")}<select aria-label={tr("evolutioncontribution.submit_local_version")} disabled={pending} value={buildId} onChange={(e) => { change(); setBuildId(e.target.value); }}>
      <option value="" disabled>{tr("evolutioncontribution.choose_a_local_version")}</option>
      {versions.map((b) => <option key={b.id} value={b.id}>{b.name || tr("evolutioncontribution.local_version_value", { p0: b.id })}{!b.sourceHash ? tr("evolutioncontribution.source_preparation_required") : ""}</option>)}
    </select></label>
    {mode === "existing" && version && buildId !== (state?.candidate || state?.active) && <p>{tr("evolutioncontribution.switch_to_this_version_and_prepare_its_source_first")}</p>}
    {(!state?.prepared || !version?.sourceHash) && <button disabled={locked || buildId !== state?.active} onClick={() => onAction("prepare")}>{tr("evolutioncontribution.prepare_source_for_the_current_version")}</button>}
    {catalog.error && <p role="alert">{catalog.error} <button disabled={locked || catalog.pending} onClick={() => void catalog.retry()}>{tr("app.retry")}</button></p>}
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {mode === "existing" ? <>
        <label>{tr("evolutioncontribution.target_branch")}<select aria-label={tr("evolutioncontribution.target_branch")} value={target} disabled={pending || !catalog.data} onChange={(e) => { change(); setTarget(e.target.value); }} required>
          <option value="" disabled>{!catalog.data && catalog.pending ? tr("evolutioncontribution.loading_branches") : tr("evolutioncontribution.choose_a_target_branch")}</option>
          {target && !branches.includes(target) && <option value={target} disabled>{target} {tr("evolutioncontribution.unavailable")}</option>}
          {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select></label>
        {catalog.data && !branches.length && <p>{tr("evolutioncontribution.no_receiving_branches")}</p>}
        <label>{tr("evolutioncontribution.pr_title")}<input aria-label={tr("evolutioncontribution.pr_title")} value={title} disabled={pending} onChange={(e) => { change(); setTitle(e.target.value); }} required /></label>
      </> : <>
        <label>{tr("evolutioncontribution.requested_branch_name")}<input aria-label={tr("evolutioncontribution.requested_branch_name")} value={target} maxLength={200} disabled={pending} onChange={(e) => { change(); setTarget(e.target.value); }} required /></label>
      </>}
      <label>{mode === "existing" ? tr("evolutioncontribution.pr_description") : tr("evolutioncontribution.request_description")}<textarea aria-label={mode === "existing" ? tr("evolutioncontribution.pr_description") : tr("evolutioncontribution.request_description")} value={body} disabled={pending} maxLength={20000} onChange={(e) => { change(); setBody(e.target.value); }} required /></label>
      {forbidden(target) && <p role="alert">{tr("evolutioncontribution.the_main_branch_and_submission_base_template_cannot_be_used_as_target_branches")}</p>}
      {error && <p role="alert">{error}</p>}
      {mode === "existing" && target && version && <ContributionMerge params={{ targetBranch: target, buildId }}
        revision={`${version.sourceHash}:${state?.draftDirty}`} busy={locked || !state?.prepared || !version.sourceHash || !branches.includes(target)} onAction={onAction} />}
      <button className="evolution-primary" disabled={locked || !!receipt || !version?.sourceHash || !target.trim() || forbidden(target) || !body.trim()
        || (mode === "existing" && (!branches.includes(target) || !!catalog.error || !title.trim() || !state?.prepared))}>
        {pending ? tr("evolutioncontribution.submitting") : mode === "existing" ? tr("evolutioncontribution.create_new_pr") : tr("evolutioncontribution.submit_branch_request")}
      </button>
    </form>
    {receipt?.url && <p role="status">{tr("evolutioncontribution.request_submitted_the_target_branch_has_not_been_created_yet")}<a href={receipt.url} target="_blank" rel="noreferrer">{tr("evolutioncontribution.view_request")}</a></p>}
    {Boolean(state?.branchRequests?.length) && <div className="evolution-pr-history" aria-label={tr("evolutioncontribution.target_branch_request")}>
      <h3>{tr("evolutioncontribution.target_branch_request")}</h3>
      {state?.branchRequests?.filter((request) => request.url).map((request) => <article key={request.id}>
        <div><a href={request.url} target="_blank" rel="noreferrer">{request.branch}</a>
          <p>{!catalog.data ? tr("evolutioncontribution.checking_branch_status") : branches.includes(request.branch) ? tr("evolutioncontribution.branch_ready") : tr("evolutioncontribution.waiting_for_branch_creation")}</p>
          <small>{tr("evolutioncontribution.requested_version")}{request.buildName}</small>
          {branches.includes(request.branch) && <button disabled={pending || !!catalog.error} onClick={() => {
            change(); setMode("existing"); setTarget(request.branch); setBuildId(request.buildId);
            setBody(request.body); setTitle("");
          }}>{tr("evolutioncontribution.submit_a_pr_to_this_branch")}</button>}
        </div>
      </article>)}
    </div>}
  </section>;
}
