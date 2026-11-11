import { t as tr } from "../../electron/i18n.mjs";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { UpdateState } from "../types";

export function UpdateVersionPicker({ state, busy, onSelect }: {
  state: UpdateState; busy: boolean; onSelect: (tag: string) => void;
}) {
  if (state.phase === "unsupported") return null;
  return <details className="update-version-picker">
    <summary>{tr("updateversionpicker.other_versions")}</summary>
    <label>{tr("updateversionpicker.choose_version")}<select aria-label={tr("updateversionpicker.target_update_version")} disabled={busy || !state.releases?.length}
      value={state.selectedTag || ""} onChange={event => onSelect(event.target.value)}>
      <option value="" disabled>{tr("updateversionpicker.choose_a_version")}</option>
      {state.releases?.map(release => <option key={release.tag} value={release.tag} disabled={!!release.reason}>
        {release.tag} · {release.prerelease ? tr("updateversionpicker.pre_release") : tr("updateversionpicker.stable_release")}{release.tag.replace(/^v/, "") === state.currentVersion ? tr("updateversionpicker.in_use") : ""}{release.reason ? ` · ${release.reason}` : ""}
      </option>)}
    </select></label>
  </details>;
}

/** Purpose: Reach the version and recovery chooser from inside the app, for example to return to a
 * version saved before an update. Input: whether another version operation is running. Output: the
 * desktop's own chooser; picking a version restarts Cleo, and chats, memory and settings stay as they are.
 * The standalone recovery entry outside the app still works when Cleo cannot start.
 */
export function VersionRecovery({ busy }: { busy: boolean }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const openRecovery = window.cleoDesktop?.openRecovery;
  if (!openRecovery) return null;
  const open = async () => {
    setOpening(true); setError("");
    try { await openRecovery(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : tr("app.operation_failed")); }
    finally { setOpening(false); }
  };
  return <details className="update-version-picker update-recovery">
    <summary>{tr("overlays.version_recovery")}</summary>
    <p>{tr("overlays.version_recovery_hint")}</p>
    <button type="button" disabled={busy || opening} onClick={() => void open()}>
      {opening ? <LoaderCircle className="spin" size={13} /> : null}{tr("overlays.open_version_recovery")}
    </button>
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
