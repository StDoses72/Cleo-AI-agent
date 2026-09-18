import type { UpdateState } from "../types";

export function UpdateVersionPicker({ state, busy, onSelect }: {
  state: UpdateState; busy: boolean; onSelect: (tag: string) => void;
}) {
  if (state.phase === "unsupported") return null;
  return <details className="update-version-picker">
    <summary>其他版本</summary>
    <label>选择版本<select aria-label="目标更新版本" disabled={busy || !state.releases?.length}
      value={state.selectedTag || ""} onChange={event => onSelect(event.target.value)}>
      <option value="" disabled>请选择版本</option>
      {state.releases?.map(release => <option key={release.tag} value={release.tag} disabled={!!release.reason}>
        {release.tag} · {release.prerelease ? "预发布版" : "正式版"}{release.tag.replace(/^v/, "") === state.currentVersion ? " · 正在使用" : ""}{release.reason ? ` · ${release.reason}` : ""}
      </option>)}
    </select></label>
  </details>;
}
