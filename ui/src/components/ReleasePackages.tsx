import { t as tr } from "../../electron/i18n.mjs";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";

interface BuildRun { id: string; url: string; createdAt: string }
interface PackageStatus { status: string; workflowUrl: string; releaseUrl?: string }
const labels: Record<string, string> = {
  get submitted() { return tr("releasepackages.publishing_requested_waiting_for_the_workflow_run_to_appear"); },
  get running() { return tr("releasepackages.publishing_installation_packages"); },
  get completed() { return tr("releasepackages.installation_packages_published_the_workflow_succeeded_and_packages_manifests_and_che"); },
  get failed() { return tr("releasepackages.package_publishing_failed_review_the_workflow_error_fix_it_and_retry_with_the_same_ta"); },
  get unknown() { return tr("releasepackages.no_matching_run_was_found_yet_the_request_may_still_be_processing_refresh_later"); },
  get incomplete() { return tr("releasepackages.the_workflow_succeeded_previously_but_remote_files_or_release_metadata_are_incomplete"); },
};

export function ReleasePackages({ params, disabled, onAction, onBusy }: {
  params: Record<string, unknown>;
  disabled: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
}) {
  const [builds, setBuilds] = useState<BuildRun[] | null>(null);
  const [runId, setRunId] = useState("");
  const [status, setStatus] = useState<PackageStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setStatus(null); setError(""); }, [params.tag, params.title, params.body, params.prerelease, runId]);
  const run = async (action: string) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setPending(true); onBusy?.(true); setError("");
    try {
      const value = await onAction(action, { ...params, runId });
      if (action === "releaseBuilds" && Array.isArray(value)) {
        setBuilds(value); setRunId(value[0]?.id || ""); setStatus(null);
      } else if (value && typeof value === "object" && "status" in value) setStatus(value as PackageStatus);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy?.(false); }
  };
  const locked = disabled || pending;
  return <section aria-label={tr("releasepackages.publish_installation_packages")}>
    <h4>{tr("overlays.installation_packages")}</h4>
    {!status && <p role="status">{tr("releasepackages.package_publication_has_not_been_confirmed")}</p>}
    <button disabled={locked} onClick={() => void run("releaseBuilds")}><RefreshCw size={14} />{tr("releasepackages.find_matching_build")}</button>
    {builds?.length === 0 && <p role="status">{tr("releasepackages.no_complete_build_exists_for_this_commit_a_successful_manual_desktop_platforms_build_")}<a href="https://github.com/StDoses72/Cleo-AI-agent/actions/workflows/desktop-platforms.yml" target="_blank" rel="noreferrer">{tr("releasepackages.view_desktop_platforms")}</a></p>}
    {!!builds?.length && <label>{tr("releasepackages.successful_build")}<select aria-label={tr("releasepackages.successful_build")} value={runId} disabled={locked} onChange={event => setRunId(event.target.value)}>
      {builds.map(build => <option key={build.id} value={build.id}>#{build.id} · {build.createdAt}</option>)}
    </select></label>}
    <label>{tr("releasepackages.build_run_id")}<input aria-label={tr("releasepackages.build_run_id")} inputMode="numeric" pattern="[0-9]+" value={runId} disabled={locked} onChange={event => setRunId(event.target.value)} /></label>
    {builds?.find(build => build.id === runId) && <p><a href={builds.find(build => build.id === runId)!.url} target="_blank" rel="noreferrer">{tr("releasepackages.view_build")}</a></p>}
    <button disabled={locked || !/^\d+$/.test(runId) || !params.tag || !params.title || status?.status === "running" || status?.status === "submitted" || status?.status === "completed"}
      onClick={() => void run("publishReleasePackages")}><Upload size={14} />{tr("releasepackages.publish_installation_packages")}</button>
    <button disabled={locked || !/^\d+$/.test(runId) || !params.tag} onClick={() => void run("releasePackageStatus")}><RefreshCw size={14} />{tr("releasepackages.refresh_package_status")}</button>
    {status && <p role="status">{labels[status.status] || tr("releasepackages.package_status_is_unconfirmed")} <a href={status.workflowUrl} target="_blank" rel="noreferrer">{tr("releasepackages.view_publishing_workflow")}</a>
      {status.releaseUrl && <> · <a href={status.releaseUrl} target="_blank" rel="noreferrer">{tr("releasepackages.view_packages")}</a></>}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
