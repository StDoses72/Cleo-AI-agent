import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UpdateState } from "../types";

export function UpdateVersionPicker({ state, busy }: { state: UpdateState; busy: boolean }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const started = useRef(false);
  const check = async (tag?: string) => {
    setPending(true); setError("");
    try {
      const result = await window.cleoDesktop?.checkForUpdates(tag);
      if (result?.phase === "error") setError(result.error || "检查版本失败。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  };
  useEffect(() => {
    if (!started.current && !state.releases && !busy && state.phase === "idle") {
      started.current = true; void check();
    }
  }, [busy, state.phase, state.releases]);
  const selected = state.releases?.find(item => item.tag === state.selectedTag);
  return <div className="update-version-picker">
    <label>目标版本<select aria-label="目标更新版本" disabled={busy || pending || !state.releases?.length}
      value={state.selectedTag || ""} onChange={event => void check(event.target.value)}>
      <option value="" disabled>请选择版本（包括历史版本）</option>
      {state.releases?.map(release => <option key={release.tag} value={release.tag} disabled={!!release.reason}>
        {release.tag} · {release.prerelease ? "预发布版" : "正式版"}{release.tag.replace(/^v/, "") === state.currentVersion ? " · 正在使用" : ""}{release.reason ? ` · ${release.reason}` : ""}
      </option>)}
    </select></label>
    <button type="button" disabled={busy || pending || state.phase === "unsupported"} onClick={() => void check()}><RefreshCw size={14} />刷新版本列表</button>
    {selected && <p>{selected.prerelease ? "预发布版" : "正式版"} · {selected.tag}</p>}
    {state.currentPrerelease !== undefined && <p>当前运行：{state.currentVersion} · {state.currentPrerelease ? "预发布版" : "正式版"}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
