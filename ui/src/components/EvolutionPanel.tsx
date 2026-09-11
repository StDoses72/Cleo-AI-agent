import { useEffect, useRef, useState } from "react";
import { ChevronDown, GitBranch, MoreHorizontal, ShieldCheck, PanelRightOpen, X, LoaderCircle, Save, Play, RotateCcw } from "lucide-react";
import type { EvolutionBuild, EvolutionState } from "../evolution-types";

interface Props {
  state: EvolutionState | null;
  error: string | null;
  busy: boolean;
  running: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onAction: (action: string, params?: Record<string, unknown>) => void;
  onRetry: () => void;
  onRepair: () => void;
}
const phases: Record<string, string> = {
  preparing: "正在准备", building: "正在检查并构建", applying: "正在重启",
  downloading: "正在下载正式版", authenticating: "正在连接 GitHub", submitting: "正在提交 PR",
  checking: "正在检查版本", selecting: "正在切换版本", saving: "正在保存",
};
/** Purpose: Keep formal releases distinct from dated local saves. Input: build. Output: display label. */
export function versionLabel(build?: EvolutionBuild) {
  if (!build) return "当前版本";
  if (build.name) return build.name;
  if (build.kind === "official") return `正式版 v${build.version}`;
  if (build.savedAt) {
    const date = new Date(build.savedAt);
    return Number.isNaN(date.getTime()) ? "已保存的本地版" : `本地版 · ${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
  }
  return "未保存的修改";
}

/** Purpose: Present only version identity and the next useful actions above the normal conversation.
 * Input: evolution state and commands. Output: persistent toolbar with contextual version and contribution dialogs.
 */
export function EvolutionPanel({ state, error, busy, running, inspectorOpen, onToggleInspector, onAction, onRetry, onRepair }: Props) {
  const [sheet, setSheet] = useState<"versions" | "contribute" | "save" | "discard" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [releaseTag, setReleaseTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => { if (sheet && !dialog.current?.open) dialog.current?.showModal(); }, [sheet]);
  const close = () => { dialog.current?.close(); setSheet(null); };
  const act = (action: string, params?: Record<string, unknown>) => { close(); onAction(action, params); };
  const active = state?.builds.find((build) => build.id === state.active);
  const base = state?.builds.find((build) => build.id === (state.iteration?.base || state.active));
  const candidate = state?.builds.find((build) => build.id === state.candidate);
  const versions = state?.builds.filter((build) => build.kind === "official" || build.savedAt) || [];
  const blocked = busy || running || Boolean(state?.transaction);
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
  const status = running ? "正在修改，完成后检查" : busy ? (validation?.status === "running" ? validation.message : phases[state?.phase || ""] || "正在准备")
    : state?.transaction ? "正在重启" : checkFailed ? "检查未通过，修改尚不可应用" : failure ? "操作未完成"
    : canApply ? "检查通过，可以应用" : canSave ? "修改已应用，尚未保存"
    : validation?.status === "unchanged" ? "检查完成，暂无程序改动" : state?.iteration ? "修改待检查" : "直接描述你想改进的地方";
  return <header className="evolution-toolbar" aria-label="进化操作">
    <div className="evolution-topline">
      <GitBranch size={19} className="evolution-accent" /><strong>进化</strong>
      <button className="evolution-version-trigger" onClick={() => setSheet("versions")} aria-label="选择版本" disabled={busy}>
        <span>正在使用</span><b>{active ? versionLabel(active) : `v${state?.currentVersion || "—"}`}</b><ChevronDown size={14} />
      </button>
      <div className="evolution-top-actions">
        <button aria-label="独立版本恢复" title="独立版本恢复" disabled={blocked || !state?.baseline} onClick={() => onAction("recovery")}><ShieldCheck size={18} /></button>
        <button aria-label="查看代码变更" aria-pressed={inspectorOpen} title="查看代码变更" onClick={onToggleInspector}><PanelRightOpen size={18} /></button>
        <button aria-label="贡献与发布" title="贡献与发布" onClick={() => setSheet("contribute")}><MoreHorizontal size={19} /></button>
      </div>
    </div>
    <div className="evolution-actionbar" role="region" aria-label="修改操作">
      <div className="evolution-status" role="status">
        {blocked ? <LoaderCircle size={15} className="evolution-spin" /> : <span className={failure ? "evolution-status-dot error" : "evolution-status-dot"} />}
        <div><strong>{status}</strong>{state?.iteration && <small>本轮起点：{versionLabel(base)}</small>}</div>
      </div>
      <div className="evolution-actions">
        {needsCheck && !checkFailed && <button disabled={blocked} onClick={() => onAction("build")}>重新检查</button>}
        <button className={canApply ? "evolution-primary" : ""} disabled={blocked || !canApply} onClick={() => onAction("apply", { id: candidate?.id })}><Play size={14} />应用</button>
        <button className={canSave ? "evolution-primary" : ""} disabled={blocked || !canSave} onClick={() => { setName(""); setSheet("save"); }}><Save size={14} />保存</button>
        <button disabled={blocked || !state?.iteration} onClick={() => setSheet("discard")}><RotateCcw size={14} />放弃修改</button>
      </div>
    </div>
    {failure && <div className="evolution-error" role="alert"><span>{failure}</span>
      {checkFailed && validation.repairable && <button disabled={blocked} onClick={onRepair}>让 Cleo 修复</button>}
      <button disabled={blocked} onClick={checkFailed ? () => onAction("build") : onRetry}>{checkFailed ? "重新检查" : "重试"}</button>
    </div>}
    {state?.lastRestartError && !failure && <p className="evolution-notice">{state.lastRestartError}</p>}
    {details && (busy || failure || canApply) && <details className="evolution-log"><summary>查看检查详情</summary><pre>{details}</pre></details>}
    {sheet && <dialog ref={dialog} className="evolution-dialog" onCancel={close} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="evolution-dialog-title"><h2>{sheet === "versions" ? "版本" : sheet === "contribute" ? "贡献与发布" : sheet === "save" ? "保存本地版本" : "放弃本轮修改"}</h2><button aria-label="关闭" onClick={close}><X size={18} /></button></div>
      {sheet === "versions" && <>
        <p>程序版本独立保存，聊天、记忆和配置始终保留。</p>
        {state?.iteration && <p className="evolution-notice">请先保存或放弃本轮修改，再切换版本。</p>}
        <div className="evolution-version-list">{versions.map((build) => <button key={build.id} disabled={blocked || Boolean(state?.iteration) || build.id === state?.active} onClick={() => act("select", { id: build.id })}>
          <span>{versionLabel(build)}<small>{build.kind === "local" ? `基于 ${build.baseTag || "所选版本"}` : "GitHub Release"}</small></span><small>{build.id === state?.active ? "正在使用" : "使用此版本"}</small>
        </button>)}</div>
        <details className="evolution-release"><summary>查找正式版本</summary>
          <button disabled={blocked} onClick={() => onAction("releases")}>检查正式版本</button>
          {Boolean(state?.releases.length) && <><select aria-label="正式版本" value={releaseTag || state?.releases[0]?.tag} onChange={(event) => setReleaseTag(event.target.value)}>{state?.releases.map((release) => <option key={release.tag} value={release.tag}>{release.title}</option>)}</select>
            <button disabled={blocked || Boolean(state?.iteration)} onClick={() => onAction("download", { tag: releaseTag || state?.releases[0]?.tag })}>下载所选版本</button></>}
        </details>
      </>}
      {sheet === "save" && <form onSubmit={(event) => { event.preventDefault(); act("save", { name }); }}>
        <p>保存当前效果，替换上一次保存的本地版本。基础版本继续保留。</p>
        <label>名称（可选）<input autoFocus aria-label="本地版本名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="留空使用保存时间" maxLength={80} /></label>
        <button className="evolution-primary" disabled={blocked || !canSave}>确认保存</button>
      </form>}
      {sheet === "discard" && <><p>放弃本轮修改，回到「{versionLabel(base)}」。聊天、记忆和配置不变。{active?.id !== base?.id ? "Cleo 会自动重启。" : ""}</p><button className="evolution-primary" disabled={blocked} onClick={() => act("discard")}>确认放弃</button></>}
      {sheet === "contribute" && <><p>本地保存不会发布正式版本。普通用户提交 PR，维护者在 GitHub 决定合并与发布 Release。</p>
        {state?.pullRequest && <a href={state.pullRequest.url} target="_blank" rel="noreferrer">查看已有 PR</a>}
        <button disabled={blocked} onClick={() => onAction("login")}>连接 GitHub</button>
        <form onSubmit={(event) => { event.preventDefault(); act("submit", { title, body }); }}>
          <input aria-label="PR 标题" placeholder="贡献标题" value={title} onChange={(event) => setTitle(event.target.value)} required />
          <textarea aria-label="PR 说明" placeholder="修改内容和验证结果" value={body} onChange={(event) => setBody(event.target.value)} required />
          <button className="evolution-primary" disabled={blocked || !state?.prepared || !title.trim() || !body.trim()}>提交 PR</button>
        </form></>}
    </dialog>}
  </header>;
}
