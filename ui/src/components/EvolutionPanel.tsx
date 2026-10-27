import { getLanguage } from "../../electron/i18n.mjs";
import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GitBranch, GitPullRequest, History, ShieldCheck, PanelRightOpen, X, LoaderCircle, Save, Play, RotateCcw } from "lucide-react";
import type { EvolutionBuild, EvolutionState } from "../evolution-types";
import { useAutomaticRead } from "../useAutomaticRead";
import { EvolutionContribution } from "./EvolutionContribution";
import { GithubLogin } from "./GithubLogin";
import { ContributionMerge } from "./ContributionMerge";
import { ReleasePublisher } from "./ReleasePublisher";
import { handleDialogKeyDown } from "./Modal";

interface Props {
  children?: ReactNode;
  state: EvolutionState | null;
  error: string | null;
  busy: boolean;
  running: boolean;
  otherTasksRunning?: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onRetry: () => void;
  onRepair: () => void;
}
const phases: Record<string, string> = {
  get preparing() { return tr("evolutionpanel.preparing"); }, get building() { return tr("evolutionpanel.checking_and_building"); }, get applying() { return tr("evolutionpanel.restarting"); },
  get downloading() { return tr("evolutionpanel.downloading_the_official_release"); }, get authenticating() { return tr("evolutionpanel.connecting_to_github"); }, get submitting() { return tr("evolutionpanel.submitting_pr"); },
  get checking() { return tr("dependencysetup.checking"); }, get selecting() { return tr("evolutionpanel.switching_versions"); }, get saving() { return tr("evolutionpanel.saving"); },
  get validating() { return tr("evolutionpanel.checking_changes"); },
  get publishing() { return tr("evolutionpanel.creating_github_release"); },
};
/** Purpose: Keep formal releases distinct from dated local saves. Input: build. Output: display label. */
const releaseVersionLabel = (version: string) => version.endsWith("-alpha") ? `α ${version.slice(0, -6)}` : `v${version}`;
export function versionLabel(build?: EvolutionBuild, prerelease?: boolean) {
  if (!build) return tr("evolutionpanel.current_version");
  if (build.name) return build.name;
  if (build.kind === "official") return `${build.version?.endsWith("-alpha") ? tr("evolutionpanel.experimental_version") : prerelease === undefined ? tr("evolutionpanel.release") : prerelease ? tr("evolutionpanel.pre_release") : tr("evolutionpanel.stable_release")} ${releaseVersionLabel(build.version || "—")}`;
  if (build.savedAt) {
    const date = new Date(build.savedAt);
    return Number.isNaN(date.getTime()) ? tr("evolutionpanel.saved_local_version") : tr("evolutionpanel.local_version_value", { p0: date.toLocaleString(getLanguage(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) });
  }
  return tr("evolutionpanel.unsaved_changes");
}

/** Purpose: Present only version identity and the next useful actions above the normal conversation.
 * Input: evolution state and commands. Output: persistent toolbar with contextual version and contribution dialogs.
 */
export function EvolutionPanel({ children, state, error, busy, running, otherTasksRunning = false, inspectorOpen, onToggleInspector, onAction, onRetry, onRepair }: Props) {
  const [sheet, setSheet] = useState<"versions" | "contribute" | "history" | "publish" | "save" | "discard" | null>(null);
  const [releasePr, setReleasePr] = useState("");
  const [releaseBuild, setReleaseBuild] = useState("");
  const [contributionBuild, setContributionBuild] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [releaseTag, setReleaseTag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);
  const releases = useAutomaticRead("releases", sheet === "versions" && !busy, async () => {
    const result = await onAction("releases");
    if (!Array.isArray(result)) throw new Error(tr("evolutionpanel.could_not_load_releases_try_again"));
    return result as EvolutionState["releases"];
  });
  const releaseOptions = releases.data ?? state?.releases ?? [];
  useEffect(() => { if (sheet && !dialog.current?.open) dialog.current?.showModal(); }, [sheet]);
  const close = () => { if (submittingRef.current) return; dialog.current?.close(); setSheet(null); };
  /** Purpose: Start a fresh user intent, independent of every historical PR. Input: none. Output: empty form. */
  const openContribution = (buildId?: unknown) => {
    if (submittingRef.current) return;
    setContributionBuild(typeof buildId === "string" ? buildId : "");
    setSubmittedUrl(null); setSheet("contribute");
  };
  /** Purpose: Release starts by choosing a local version. Input: preselected version or PR. Output: release dialog. */
  const openRelease = (buildId = "", prUrl = "") => {
    if (submittingRef.current) return;
    setReleaseBuild(buildId); setReleasePr(prUrl); setSheet("publish");
  };
  const act = (action: string, params?: Record<string, unknown>) => { close(); onAction(action, params); };
  /** Purpose: Release dialog focus before entering a repair conversation. Input: contribution action. Output: forwarded operation. */
  const contributionAction = (action: string, params?: Record<string, unknown>) => {
    if (action === "repairContribution") close();
    return onAction(action, params);
  };
  const active = state?.builds.find((build) => build.id === state.active);
  const base = state?.builds.find((build) => build.id === (state.iteration?.base || state.active));
  const candidate = state?.builds.find((build) => build.id === state.candidate);
  const versions = state?.builds.filter((build) => build.kind === "official" || build.savedAt) || [];
  const releaseJob = state?.releaseJob;
  const releasing = Boolean(releaseJob && !["completed", "failed", "cancelled"].includes(releaseJob.phase));
  const blocked = busy || running || otherTasksRunning || submitting || Boolean(state?.transaction);
  const authorizing = ["starting", "waiting", "checking"].includes(state?.githubAuth?.status || "");
  const awaitingAuthorization = state?.githubAuth?.status === "waiting";
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => all.findIndex((item) => item.url === pr.url) === index);
  const validation = state?.validation;
  const verified = Boolean(validation?.status === "passed" && validation.sourceHash
    && validation.candidate === candidate?.id && validation.sourceHash === candidate?.sourceHash && !state?.draftDirty);
  const canApply = Boolean(verified && candidate?.kind === "local" && candidate.id !== state?.active);
  const canSave = Boolean(state?.iteration && active?.kind === "local" && active.id !== state.iteration.base
    && state.candidate === state.active && verified);
  const checkFailed = validation?.status === "failed" || validation?.status === "interrupted";
  const failure = error || state?.error || (checkFailed ? validation.message : null);
  const needsCheck = Boolean(state?.iteration && !verified && validation?.status !== "unchanged");
  const details = state?.logs || validation?.details;
  const status = running ? tr("evolutionpanel.editing") : awaitingAuthorization ? tr("evolutionpanel.waiting_for_github_authorization") : busy ? (state?.phase === "building" && validation?.status === "running" ? validation.message : phases[state?.phase || ""] || tr("evolutionpanel.preparing"))
    : otherTasksRunning ? tr("evolutionpanel.other_tasks_are_running")
    : state?.transaction ? tr("evolutionpanel.restarting") : checkFailed ? tr("evolutionpanel.checks_failed_changes_cannot_be_applied_yet") : failure ? tr("evolutionpanel.operation_incomplete")
    : canApply ? tr("evolutionpanel.checks_passed_ready_to_apply") : canSave ? tr("evolutionpanel.the_current_version_can_be_saved")
    : validation?.status === "unchanged" ? tr("evolutionpanel.no_program_changes") : state?.iteration ? tr("evolutionpanel.changes_need_checking") : "";
  const showStatus = running || busy || otherTasksRunning || canApply || canSave || state?.iteration || releaseJob || state?.transaction;
  const sheetTitle = sheet === "versions" ? tr("evolutionpanel.version") : sheet === "contribute" ? tr("evolutionpanel.submit_and_publish") : sheet === "history" ? tr("evolutionpanel.pr_history") : sheet === "publish" ? tr("evolutioncontribution.publish_release") : sheet === "save" ? tr("evolutionpanel.save_local_version") : tr("evolutionpanel.discard_current_changes");
  return <header className="evolution-toolbar" aria-label={tr("evolutionpanel.evolution_actions")}>
    <div className="evolution-topline">
      <GitBranch size={19} className="evolution-accent" /><strong>{tr("app.evolution")}</strong>
      <button className="evolution-version-trigger" onClick={() => setSheet("versions")} aria-label={tr("evolutionpanel.choose_version")} disabled={busy}>
        <span>{tr("evolutionpanel.in_use")}</span><b>{active ? versionLabel(active, state?.releaseTypes?.[active.baseTag || ""]) : releaseVersionLabel(state?.currentVersion || "—")}</b><ChevronDown size={14} />
      </button>
      <div className="evolution-top-actions">
        <button onClick={() => onAction("monitor")}>{tr("evolutionpanel.evolution_status")}</button>
        <button aria-label={tr("evolutionpanel.view_code_changes")} aria-pressed={inspectorOpen} title={tr("evolutionpanel.view_code_changes")} onClick={onToggleInspector}><PanelRightOpen size={18} /></button>
        {history.length > 0 && <button aria-label={tr("evolutionpanel.pr_history")} title={tr("evolutionpanel.pr_history")} onClick={() => setSheet("history")}><History size={16} /><span>{tr("evolutionpanel.history")}</span></button>}
        <button aria-label={authorizing ? tr("evolutionpanel.continue_connecting_to_github") : tr("evolutionpanel.new_pr")} disabled={blocked && !authorizing} onClick={openContribution}><GitPullRequest size={17} />{authorizing ? tr("evolutionpanel.continue_connecting") : tr("evolutionpanel.new_pr")}</button>
      </div>
    </div>
    {showStatus && <div className="evolution-actionbar" role="region" aria-label={tr("evolutionpanel.editing_actions")}>
      <div className="evolution-status" role="status">
        {!awaitingAuthorization && (busy || running || releasing || state?.transaction) && <LoaderCircle size={15} className="evolution-spin" />}
        <strong>{releasing ? `${releaseJob?.tag} · ${releaseJob?.message}` : status}</strong>
      </div>
      {releaseJob && <div className="evolution-release-progress">
        {releaseJob.workflowUrl && <a href={releaseJob.workflowUrl} target="_blank" rel="noreferrer">{tr("evolutionpanel.release_logs")}</a>}
        {(releasing || releaseJob.phase === "failed") && <button onClick={() => onAction("cancelRelease")}>{tr("evolutionpanel.stop_publishing")}</button>}
        {releaseJob.phase === "failed" && <><span>{tr("evolutionpanel.publishing_incomplete")}</span><button onClick={() => onAction("retryRelease")}>{tr("evolutionpanel.continue_publishing")}</button></>}
        {releaseJob.phase === "completed" && releaseJob.releaseUrl && <a href={releaseJob.releaseUrl} target="_blank" rel="noreferrer">{releaseJob.tag} {tr("evolutionpanel.published")}</a>}
      </div>}
      <div className="evolution-actions">
        {needsCheck && !failure && !running && !busy && <button disabled={blocked} onClick={() => onAction("build")}>{tr("evolutionpanel.check_changes")}</button>}
        {canApply && <button className="evolution-primary" disabled={blocked} onClick={() => onAction("apply", { id: candidate?.id })}><Play size={14} />{tr("evolutionpanel.apply")}</button>}
        {canSave && <button className="evolution-primary" disabled={blocked} onClick={() => { setName(""); setSheet("save"); }}><Save size={14} />{tr("computerpanel.save")}</button>}
      </div>
    </div>}
    {releaseJob?.phase === "failed" && <details className="evolution-log"><summary>{tr("evolutionpanel.view_publishing_failure")}</summary><pre>{releaseJob.error}</pre></details>}
    {submittedUrl && <div className="evolution-pr-notice" aria-label={tr("evolutionpanel.pr_submission_result")} role="status">
      <GitPullRequest size={15} /><span>{tr("evolutionpanel.new_pr_created")}</span>
      <a href={submittedUrl} target="_blank" rel="noreferrer">{tr("evolutionpanel.view")}{submittedUrl.split("/").at(-1)}</a>
      <button onClick={() => setSheet("history")}>{tr("evolutionpanel.view_status")}</button>
      <button aria-label={tr("evolutionpanel.dismiss_submission_notice")} onClick={() => setSubmittedUrl(null)}><X size={14} /></button>
    </div>}
    {failure && <div className="evolution-error" role="alert"><span>{failure}</span>
      {checkFailed && validation.repairable && <button disabled={blocked} onClick={onRepair}>{tr("evolutionpanel.let_cleo_fix_this")}</button>}
      <button disabled={blocked} onClick={checkFailed ? () => onAction("build") : onRetry}>{checkFailed ? tr("dependencysetup.check_again") : tr("app.retry")}</button>
    </div>}
    {state?.lastRestartError && !failure && <p className="evolution-notice">{state.lastRestartError} <button disabled={blocked} onClick={onRepair}>{tr("evolutionpanel.let_cleo_fix_this")}</button></p>}
    {details && (busy || failure || canApply) && <details className="evolution-log"><summary>{tr("contributionmerge.view_check_details")}</summary><pre>{details}</pre></details>}
    {children}
    {sheet && <dialog ref={dialog} className="evolution-dialog" aria-label={sheetTitle} onKeyDown={handleDialogKeyDown} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="evolution-dialog-title"><h2>{sheetTitle}</h2><button aria-label={tr("app.close")} onClick={close}><X size={18} /></button></div>
      {sheet === "publish" && <>
        {state?.githubAuth?.status !== "connected" && <GithubLogin auth={state?.githubAuth} busy={blocked} onAction={onAction} onContribute={openContribution} />}
        <ReleasePublisher key={`${releasePr}|${releaseBuild}`} state={state} initialUrl={releasePr} buildId={releaseBuild} onContribute={openContribution} onStarted={() => { submittingRef.current = false; setSubmitting(false); close(); }} busy={busy || running || otherTasksRunning || Boolean(state?.transaction)} onAction={contributionAction}
          onBusy={value => { submittingRef.current = value; setSubmitting(value); }} />
      </>}
      {sheet === "history" && <>
        <div className="evolution-pr-history">{history.map((pr) => <article key={pr.url}>
          <div><a href={pr.url} target="_blank" rel="noreferrer">#{pr.number || pr.url.split("/").at(-1)} · {pr.title || "Pull Request"}</a>
            {pr.submittedAt && <small>{new Date(pr.submittedAt).toLocaleString(getLanguage())}</small>}
            <ContributionMerge params={{ url: pr.url }} busy={blocked} onAction={contributionAction} />
            {state?.githubAuth?.repositoryAccess?.canRelease && <button disabled={blocked} onClick={() => openRelease("", pr.url)}>{tr("evolutionpanel.publish_this_pr_version")}</button>}
          </div>
        </article>)}</div>
        <button className="evolution-primary" disabled={blocked} onClick={openContribution}><GitPullRequest size={15} />{tr("evolutionpanel.new_pr")}</button>
      </>}
      {sheet === "versions" && <section ref={releases.root}>
        {failure && <p role="alert">{failure}</p>}
        {state?.iteration && <p className="evolution-notice">{tr("evolutionpanel.save_or_discard_the_current_changes_before_switching_versions")}</p>}
        <div className="evolution-version-list">{versions.map((build) => <button key={build.id} disabled={blocked || Boolean(state?.iteration) || build.id === state?.active} onClick={() => act("select", { id: build.id })}>
          <span>{versionLabel(build, state?.releaseTypes?.[build.baseTag || ""])}<small>{build.kind === "local" ? tr("evolutionpanel.based_on_value", { p0: build.baseTag || tr("evolutionpanel.selected_version") }) : "GitHub Release"}</small></span><small>{build.id === state?.active ? tr("evolutionpanel.in_use") : tr("evolutionpanel.use_this_version")}</small>
        </button>)}</div>
        <details className="evolution-release"><summary>{tr("evolutionpanel.find_a_release")}</summary>
          {releases.pending && !releases.data && <p role="status">{tr("evolutionpanel.loading_releases")}</p>}
          {releases.error && <p role="alert">{releases.error} <button disabled={busy || releases.pending} onClick={() => void releases.retry()}>{tr("app.retry")}</button></p>}
          {Boolean(releaseOptions.length) && <><select aria-label={tr("evolutioncontribution.publish_release")} disabled={blocked} value={releaseTag} onChange={(event) => {
            setReleaseTag(event.target.value); void onAction("selectUpdate", { tag: event.target.value });
          }}>
            <option value="" disabled>{tr("evolutionpanel.choose_a_version")}</option>
            {releaseTag && !releaseOptions.some(item => item.tag === releaseTag) && <option value={releaseTag} disabled>{releaseTag} {tr("evolutionpanel.no_longer_available")}</option>}
            {releaseOptions.map((release) => <option key={release.tag} value={release.tag} disabled={!!release.reason}>
              {release.tag} · {release.prerelease ? tr("evolutionpanel.pre_release") : tr("evolutionpanel.stable_release")}{release.tag === active?.baseTag ? tr("evolutionpanel.in_use_2") : ""}{release.reason ? ` · ${release.reason}` : ""}
            </option>)}
          </select>
            <button disabled={blocked || !releaseOptions.some(item => item.tag === releaseTag && !item.reason) || Boolean(state?.iteration)} onClick={() => onAction("download", { tag: releaseTag })}>{tr("evolutionpanel.download_selected_version")}</button></>}
        </details>
        {state?.iteration && <p>{tr("evolutionpanel.starting_version")}{versionLabel(base)} <button disabled={blocked} onClick={() => setSheet("discard")}><RotateCcw size={14} />{tr("evolutionpanel.discard_changes")}</button></p>}
        <button disabled={blocked || !state?.baseline} onClick={() => act("recovery")}><ShieldCheck size={16} />{tr("evolutionpanel.independent_version_recovery")}</button>
      </section>}
      {sheet === "save" && <form onSubmit={(event) => { event.preventDefault(); act("save", { name }); }}>
        <p>{tr("evolutionpanel.this_replaces_the_last_saved_local_version")}</p>
        <label>{tr("evolutionpanel.name_optional")}<input autoFocus aria-label={tr("evolutionpanel.local_version_name")} value={name} onChange={(event) => setName(event.target.value)} placeholder={state?.suggestedVersionName ? tr("evolutionpanel.leave_blank_to_use_value", { p0: state.suggestedVersionName }) : tr("evolutionpanel.leave_blank_to_use_the_default_name")} maxLength={80} /></label>
        <button className="evolution-primary" disabled={blocked || !canSave}>{tr("evolutionpanel.confirm_save")}</button>
      </form>}
      {sheet === "discard" && <><p>{tr("evolutionpanel.return_to")}{versionLabel(base)}{tr("punctuation.closeQuote")}{active?.id !== base?.id ? tr("evolutionpanel.cleo_will_restart_automatically") : ""}{tr("punctuation.period")}</p><button className="evolution-primary" disabled={blocked} onClick={() => act("discard")}>{tr("evolutionpanel.confirm_discard")}</button></>}
      {sheet === "contribute" && <>
        {state?.githubAuth?.status === "connected" ? <EvolutionContribution state={state} busy={busy || running || otherTasksRunning || Boolean(state?.transaction)} onAction={contributionAction}
          initialBuildId={contributionBuild} onRelease={id => openRelease(id)}
          onBusy={(value) => { submittingRef.current = value; setSubmitting(value); }}
          onSubmitted={(url) => { setSubmittedUrl(url); submittingRef.current = false; close(); }} />
          : <GithubLogin auth={state?.githubAuth} busy={blocked} onAction={onAction} onContribute={openContribution} />}
      </>}
    </dialog>}
  </header>;
}
