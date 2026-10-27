import { getLanguage } from "../../electron/i18n.mjs";
import { t as tr } from "../../electron/i18n.mjs";
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useAutomaticRead } from "../useAutomaticRead";
import type { EvolutionBuild, EvolutionPullRequest, EvolutionState } from "../evolution-types";

interface Props {
  state: EvolutionState | null;
  busy: boolean;
  initialUrl?: string;
  buildId?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
  onStarted?: () => void;
  onContribute?: (buildId: string) => void;
}

interface ReleaseSource { key: string; build?: EvolutionBuild; pr?: EvolutionPullRequest }

const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Input: a PR and retained builds. Output: a source label that survives local build pruning. */
function sourceLabel(pr: EvolutionPullRequest, builds: EvolutionBuild[]) {
  const build = builds.find(item => item.id === pr.buildId);
  const name = build?.name || pr.title || (pr.buildId ? tr("releasepublisher.local_version_value", { p0: pr.buildId }) : tr("releasepublisher.merged_pr_version"));
  const version = build?.version || build?.baseTag;
  return `PR #${pr.number || pr.url.split("/").at(-1)} · ${name}${version ? ` (${version})` : ""} · ${pr.targetBranch || tr("releasepublisher.target_branch_needs_verification")}`;
}

/** Input: a retained local build. Output: the name users gave it, or where it came from. */
function buildLabel(build: EvolutionBuild, state: EvolutionState | null) {
  const saved = build.savedAt && !Number.isNaN(new Date(build.savedAt).getTime())
    ? tr("evolutionpanel.local_version_value", { p0: new Date(build.savedAt).toLocaleString(getLanguage(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) }) : "";
  const name = build.name || saved || (build.id === state?.active ? tr("releasepublisher.currently_running_version") : build.id === state?.candidate ? tr("releasepublisher.changes_awaiting_application") : tr("releasepublisher.local_version_value", { p0: build.id }));
  return `${name}${build.version ? ` (${build.version})` : ""}`;
}

/** Input: evolution state. Output: local versions (each with its best PR), then PR versions whose local copy was pruned. */
function releaseSources(state: EvolutionState | null) {
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => all.findIndex(item => item.url === pr.url) === index);
  const builds = (state?.builds || []).filter(build => build.kind === "local" && (build.sourceHash || build.importHash)
    && (build.savedAt || build.id === state?.active || build.id === state?.candidate || history.some(pr => pr.buildId === build.id)));
  // Prefer a merged PR, then the most recent submission for the same local version.
  const prFor = (id: string) => history.filter(pr => pr.buildId === id)
    .sort((a, b) => Number(b.merged) - Number(a.merged) || String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")))[0];
  const locals: ReleaseSource[] = builds.map(build => ({ key: `build:${build.id}`, build, pr: prFor(build.id) }));
  const others: ReleaseSource[] = history.filter(pr => !builds.some(build => build.id === pr.buildId)).map(pr => ({ key: `pr:${pr.url}`, pr }));
  return { history, locals, others };
}

const prState = (pr?: EvolutionPullRequest) => !pr ? tr("releasepublisher.no_pr_submitted") : `PR #${pr.number || pr.url.split("/").at(-1)} ${pr.merged ? tr("contributionmerge.merged") : tr("releasepublisher.awaiting_merge")}`;

/** Input: retained local versions, their PRs and desktop actions. Output: choose a local version, then one-click release. */
export function ReleasePublisher({ state, busy, initialUrl = "", buildId, onAction, onBusy, onStarted, onContribute }: Props) {
  const { history, locals, others } = releaseSources(state);
  const [choice, setChoice] = useState(() => {
    const initial = history.find(pr => pr.url === initialUrl);
    if (initial) return locals.find(source => source.build?.id === initial.buildId)?.key || `pr:${initial.url}`;
    return locals.find(source => source.build?.id === buildId)?.key || "";
  });
  const source = [...locals, ...others].find(item => item.key === choice);
  const [url, setUrl] = useState(() => {
    const initial = history.find(pr => pr.url === initialUrl);
    return initial ? initial.url : source?.pr?.url || "";
  });
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [result, setResult] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const access = state?.githubAuth?.repositoryAccess;
  const receipt = history.find(pr => pr.url === url);
  const releasing = Boolean(state?.releaseJob && !["completed", "failed", "cancelled"].includes(state.releaseJob.phase));
  const locked = !!pending || releasing;
  const connected = state?.githubAuth?.status === "connected";
  const knownLogin = useRef(access?.login);
  if (access?.login) knownLogin.current = access.login;
  if (!connected) knownLogin.current = undefined;
  const checkKey = JSON.stringify([connected, url, knownLogin.current]);
  const check = useAutomaticRead(checkKey, connected && !busy && !locked && !result, async () => {
    const value = await onAction(url ? "previewMergedRelease" : "releasePermission", url ? { url } : undefined);
    if (!value || typeof value !== "object") throw new Error(tr("releasepublisher.could_not_confirm_release_requirements_try_again"));
    if (url) {
      if (!("url" in value) || value.url !== url || !("commit" in value) || !("login" in value)) throw new Error(tr("releasepublisher.could_not_verify_the_selected_pr_try_again"));
    } else if (!("status" in value) || value.status !== "checked" || !("canRelease" in value) || !value.canRelease) {
      throw new Error("message" in value ? String(value.message) : tr("releasepublisher.could_not_confirm_release_permission_try_again"));
    }
    return { login: "login" in value ? String(value.login) : undefined };
  });
  const checked = check.data;
  const accessError = connected && access && access.status !== "checking" && !access.canRelease ? access.message : "";
  const canPublish = checked && !check.pending && !check.error && access?.canRelease !== false && (!access?.login || access.login === checked.login);
  const validVersion = versionPattern.test(tag.trim()) && !tag.includes("+") && tag.trim().length <= 100;
  const publish = async () => {
    if (inFlight.current || locked || busy || !canPublish || !receipt) return;
    if (!validVersion) {
      setError(tr("releasepublisher.enter_a_valid_version_such_as_v1_2_3_or_v1_2_3_beta_1")); return;
    }
    inFlight.current = true; setPending("startRelease"); onBusy?.(true); setError("");
    try {
      const value = await onAction("startRelease", { url, tag: tag.trim(), title: title.trim() || tag.trim(), body, prerelease, login: checked?.login });
      if (!value || typeof value !== "object" || !("id" in value)) throw new Error(tr("releasepublisher.no_publishing_job_was_received_retry_to_confirm"));
      setResult(true);
      onBusy?.(false);
      onStarted?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(null); onBusy?.(false); }
  };
  return <section ref={check.root} className="release-publisher" aria-label={tr("releasepublisher.create_github_release")}>
    <label>{tr("releasepublisher.publish_local_version")}<select aria-label={tr("releasepublisher.publish_local_version")} disabled={locked} value={choice} onChange={event => {
      const next = [...locals, ...others].find(item => item.key === event.target.value);
      setChoice(event.target.value); setUrl(next?.pr?.url || ""); setResult(false); setError("");
    }}>
      <option value="">{tr("releasepublisher.choose_a_local_version_to_publish")}</option>
      {locals.length > 0 && <optgroup label={tr("releasepublisher.local_version")}>
        {locals.map(item => <option key={item.key} value={item.key}>{buildLabel(item.build!, state)} · {prState(item.pr)}</option>)}
      </optgroup>}
      {others.length > 0 && <optgroup label={tr("releasepublisher.other_pr_versions_local_copies_removed")}>
        {others.map(item => <option key={item.key} value={item.key}>{sourceLabel(item.pr!, state?.builds || [])} · {item.pr!.merged ? tr("contributionmerge.merged") : tr("releasepublisher.merge_status_needs_verification")}</option>)}
      </optgroup>}
    </select></label>
    {!locals.length && !others.length && <p role="status">{tr("releasepublisher.no_local_versions_available_to_publish")}</p>}
    {source?.build && !source.pr && <p role="status" className="release-needs-pr">{tr("releasepublisher.this_version_has_no_pr_yet_it_can_be_published_after_merging")}{onContribute && <button type="button" disabled={locked} onClick={() => onContribute(source.build!.id)}>{tr("releasepublisher.create_a_pr_for_this_version")}</button>}</p>}
    {receipt && <a href={url} target="_blank" rel="noreferrer">{tr("releasepublisher.view_pr")}</a>}
    <form noValidate onSubmit={event => { event.preventDefault(); void publish(); }}>
      <label>{tr("releasepublisher.release_version")}<input aria-label={tr("releasepublisher.version_tag")} value={tag} disabled={locked || !!result} required maxLength={100} placeholder="v1.2.3"
        aria-invalid={!!tag && !validVersion} onChange={event => { setTag(event.target.value); setError(""); }} /></label>
      {tag && !validVersion && <p>{tr("releasepublisher.version_format_v1_2_3_or_v1_2_3_beta_1")}</p>}
      <label>{tr("releasepublisher.release_type")}<select aria-label={tr("releasepublisher.release_type")} value={prerelease ? "pre" : "stable"} disabled={locked || !!result} onChange={event => setPrerelease(event.target.value === "pre")}>
        <option value="stable">{tr("evolutionpanel.stable_release")}</option><option value="pre">{tr("evolutionpanel.pre_release")}</option>
      </select></label>
      <details><summary>{tr("releasepublisher.title_and_description_optional")}</summary>
      <label>{tr("releasepublisher.release_title")}<input aria-label={tr("releasepublisher.release_title")} value={title} disabled={locked || !!result} maxLength={200} placeholder={tag.trim() || tr("releasepublisher.defaults_to_the_version_number")} onChange={event => setTitle(event.target.value)} /></label>
      <label>{tr("releasepublisher.release_notes")}<textarea aria-label={tr("releasepublisher.release_notes")} value={body} disabled={locked || !!result} maxLength={20000} onChange={event => setBody(event.target.value)} /></label>
      </details>
      {!connected && <p role="status">{tr("releasepublisher.connect_github_first")}</p>}
      {connected && check.pending && <p role="status">{url ? tr("releasepublisher.checking_the_release_source") : tr("releasepublisher.confirming_release_permission")}</p>}
      {connected && (check.error || accessError) && <p role="alert">{check.error || accessError} <button type="button" disabled={busy || locked} onClick={() => void check.retry()}>{tr("app.retry")}</button></p>}
      {canPublish && checked?.login && <p className="release-account">{tr("releasepublisher.publishing_account")}{checked.login}</p>}
      <button className="evolution-primary" disabled={busy || locked || !connected || !canPublish || !receipt || !!result}><Upload size={14} />{pending === "startRelease" ? tr("releasepublisher.starting_publication") : tr("releasepublisher.publish")}</button>
    </form>
    {pending === "startRelease" && <p role="status">{state?.logs.trim().split("\n").at(-1) || tr("releasepublisher.checking_release_permission_pr_merge_status_and_committed_source")}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{tr("releasepublisher.publishing_job_started")}</p>}
  </section>;
}
