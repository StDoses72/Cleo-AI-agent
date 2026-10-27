import { t as tr } from "../../electron/i18n.mjs";
import type { UpdateState } from "../types";

export function UpdateVersionPicker({ state, busy, onSelect }: {
  state: UpdateState; busy: boolean; onSelect: (tag: string) => void;
}) {
  if (state.phase === "unsupported") return null;
  return <details className="update-version-picker">
    <summary>{tr("updateversionpicker.other_versions")}</summary>
    <label>{tr("evolutionpanel.choose_version")}<select aria-label={tr("updateversionpicker.target_update_version")} disabled={busy || !state.releases?.length}
      value={state.selectedTag || ""} onChange={event => onSelect(event.target.value)}>
      <option value="" disabled>{tr("evolutionpanel.choose_a_version")}</option>
      {state.releases?.map(release => <option key={release.tag} value={release.tag} disabled={!!release.reason}>
        {release.tag} · {release.prerelease ? tr("evolutionpanel.pre_release") : tr("evolutionpanel.stable_release")}{release.tag.replace(/^v/, "") === state.currentVersion ? tr("evolutionpanel.in_use_2") : ""}{release.reason ? ` · ${release.reason}` : ""}
      </option>)}
    </select></label>
  </details>;
}
