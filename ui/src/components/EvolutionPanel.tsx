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
  preparing: "正在准备", building: "正在检查并构建", applying: "正在重启",
  downloading: "正在下载正式版", authenticating: "正在连接 GitHub", submitting: "正在提交 PR",
  checking: "正在检查…", selecting: "正在切换版本", saving: "正在保存",
  validating: "正在检查修改",
  publishing: "正在创建 GitHub Release",
};
/** Purpose: Keep formal releases distinct from dated local saves. Input: build. Output: display label. */
const releaseVersionLabel = (version: string) => version.endsWith("-alpha") ? `α ${version.slice(0, -6)}` : `v${version}`;
export function versionLabel(build?: EvolutionBuild, prerelease?: boolean) {
  if (!build) return "当前版本";
  if (build.name) return build.name;
  if (build.kind === "official") return `${build.version?.endsWith("-alpha") ? "实验版" : prerelease === undefined ? "发布版" : prerelease ? "预发布版" : "正式版"} ${releaseVersionLabel(build.version || "—")}`;
  if (build.savedAt) {
    const date = new Date(build.savedAt);
    return Number.isNaN(date.getTime()) ? "已保存的本地版" : `本地版 · ${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
  }
  return "未保存的修改";
}

/** Purpose: Present only version identity and the next useful actions above the normal conversation.
 * Input: evolution state and commands. Output: persistent toolbar with contextual version and contribution dialogs.
 */
export function EvolutionPanel({ children, state, error, busy, running, otherTasksRunning = false, inspectorOpen, onToggleInspector, onAction, onRetry, onRepair }: Props) {
  const [sheet, setSheet] = useState<"versions" | "contribute" | "history" | "publish" | "save" | "discard" | null>(null);
  const [releasePr, setReleasePr] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [releaseTag, setReleaseTag] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);
  const releases = useAutomaticRead("releases", sheet === "versions" && !busy, async () => {
    const result = await onAction("releases");
    if (!Array.isArray(result)) throw new Error("未能读取发布版本，请重试。");
    return result as EvolutionState["releases"];
  });
  const releaseOptions = releases.data ?? state?.releases ?? [];
  useEffect(() => { if (sheet && !dialog.current?.open) dialog.current?.showModal(); }, [sheet]);
  const close = () => { if (submittingRef.current) return; dialog.current?.close(); setSheet(null); };
  /** Purpose: Start a fresh user intent, independent of every historical PR. Input: none. Output: empty form. */
  const openContribution = () => {
    if (submittingRef.current) return;
    setSubmittedUrl(null); setSheet("contribute");
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
  const status = running ? "正在修改…" : awaitingAuthorization ? "等待 GitHub 授权" : busy ? (state?.phase === "building" && validation?.status === "running" ? validation.message : phases[state?.phase || ""] || "正在准备")
    : otherTasksRunning ? "其他任务正在运行"
    : state?.transaction ? "正在重启" : checkFailed ? "检查未通过，修改尚不可应用" : failure ? "操作未完成"
    : canApply ? "检查通过，可以应用" : canSave ? "可以保存当前版本"
    : validation?.status === "unchanged" ? "暂无程序改动" : state?.iteration ? "改动待检查" : "";
  const showStatus = running || busy || otherTasksRunning || canApply || canSave || state?.iteration || releaseJob || state?.transaction;
  const sheetTitle = sheet === "versions" ? "版本" : sheet === "contribute" ? "提交与发布" : sheet === "history" ? "PR 历史" : sheet === "publish" ? "发布版本" : sheet === "save" ? "保存本地版本" : "放弃本轮修改";
  return <header className="evolution-toolbar" aria-label="进化操作">
    <div className="evolution-topline">
      <GitBranch size={19} className="evolution-accent" /><strong>进化</strong>
      <button className="evolution-version-trigger" onClick={() => setSheet("versions")} aria-label="选择版本" disabled={busy}>
        <span>正在使用</span><b>{active ? versionLabel(active, state?.releaseTypes?.[active.baseTag || ""]) : releaseVersionLabel(state?.currentVersion || "—")}</b><ChevronDown size={14} />
      </button>
      <div className="evolution-top-actions">
        <button onClick={() => onAction("monitor")}>进化状态</button>
        <button aria-label="查看代码变更" aria-pressed={inspectorOpen} title="查看代码变更" onClick={onToggleInspector}><PanelRightOpen size={18} /></button>
        {history.length > 0 && <button aria-label="PR 历史" title="PR 历史" onClick={() => setSheet("history")}><History size={16} /><span>历史</span></button>}
        <button aria-label={authorizing ? "继续连接 GitHub" : "新建 PR"} disabled={blocked && !authorizing} onClick={openContribution}><GitPullRequest size={17} />{authorizing ? "继续连接" : "新建 PR"}</button>
      </div>
    </div>
    {showStatus && <div className="evolution-actionbar" role="region" aria-label="修改操作">
      <div className="evolution-status" role="status">
        {!awaitingAuthorization && (busy || running || releasing || state?.transaction) && <LoaderCircle size={15} className="evolution-spin" />}
        <strong>{releasing ? `${releaseJob?.tag} · ${releaseJob?.message}` : status}</strong>
      </div>
      {releaseJob && <div className="evolution-release-progress">
        {releaseJob.workflowUrl && <a href={releaseJob.workflowUrl} target="_blank" rel="noreferrer">发布日志</a>}
        {(releasing || releaseJob.phase === "failed") && <button onClick={() => onAction("cancelRelease")}>停止发布</button>}
        {releaseJob.phase === "failed" && <><span>发布未完成</span><button onClick={() => onAction("retryRelease")}>继续发布</button></>}
        {releaseJob.phase === "completed" && releaseJob.releaseUrl && <a href={releaseJob.releaseUrl} target="_blank" rel="noreferrer">{releaseJob.tag} 已发布</a>}
      </div>}
      <div className="evolution-actions">
        {needsCheck && !failure && !running && !busy && <button disabled={blocked} onClick={() => onAction("build")}>检查改动</button>}
        {canApply && <button className="evolution-primary" disabled={blocked} onClick={() => onAction("apply", { id: candidate?.id })}><Play size={14} />应用</button>}
        {canSave && <button className="evolution-primary" disabled={blocked} onClick={() => { setName(""); setSheet("save"); }}><Save size={14} />保存</button>}
      </div>
    </div>}
    {releaseJob?.phase === "failed" && <details className="evolution-log"><summary>查看发布失败原因</summary><pre>{releaseJob.error}</pre></details>}
    {submittedUrl && <div className="evolution-pr-notice" aria-label="PR 提交结果" role="status">
      <GitPullRequest size={15} /><span>新 PR 已创建</span>
      <a href={submittedUrl} target="_blank" rel="noreferrer">查看 #{submittedUrl.split("/").at(-1)}</a>
      <button onClick={() => setSheet("history")}>查看状态</button>
      <button aria-label="关闭提交提示" onClick={() => setSubmittedUrl(null)}><X size={14} /></button>
    </div>}
    {failure && <div className="evolution-error" role="alert"><span>{failure}</span>
      {checkFailed && validation.repairable && <button disabled={blocked} onClick={onRepair}>让 Cleo 修复</button>}
      <button disabled={blocked} onClick={checkFailed ? () => onAction("build") : onRetry}>{checkFailed ? "重新检查" : "重试"}</button>
    </div>}
    {state?.lastRestartError && !failure && <p className="evolution-notice">{state.lastRestartError} <button disabled={blocked} onClick={onRepair}>让 Cleo 修复</button></p>}
    {details && (busy || failure || canApply) && <details className="evolution-log"><summary>查看检查详情</summary><pre>{details}</pre></details>}
    {children}
    {sheet && <dialog ref={dialog} className="evolution-dialog" aria-label={sheetTitle} onKeyDown={handleDialogKeyDown} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="evolution-dialog-title"><h2>{sheetTitle}</h2><button aria-label="关闭" onClick={close}><X size={18} /></button></div>
      {sheet === "publish" && <>
        {state?.githubAuth?.status !== "connected" && <GithubLogin auth={state?.githubAuth} busy={blocked} onAction={onAction} onContribute={openContribution} />}
        <ReleasePublisher state={state} initialUrl={releasePr} onStarted={() => { submittingRef.current = false; setSubmitting(false); close(); }} busy={busy || running || otherTasksRunning || Boolean(state?.transaction)} onAction={contributionAction}
          onBusy={value => { submittingRef.current = value; setSubmitting(value); }} />
      </>}
      {sheet === "history" && <>
        <div className="evolution-pr-history">{history.map((pr) => <article key={pr.url}>
          <div><a href={pr.url} target="_blank" rel="noreferrer">#{pr.number || pr.url.split("/").at(-1)} · {pr.title || "Pull Request"}</a>
            {pr.submittedAt && <small>{new Date(pr.submittedAt).toLocaleString("zh-CN")}</small>}
            <ContributionMerge params={{ url: pr.url }} busy={blocked} onAction={contributionAction} />
            {state?.githubAuth?.repositoryAccess?.canRelease && <button disabled={blocked} onClick={() => { setReleasePr(pr.url); setSheet("publish"); }}>发布该 PR 版本</button>}
          </div>
        </article>)}</div>
        <button className="evolution-primary" disabled={blocked} onClick={openContribution}><GitPullRequest size={15} />新建 PR</button>
      </>}
      {sheet === "versions" && <section ref={releases.root}>
        {failure && <p role="alert">{failure}</p>}
        <p>切换版本会保留聊天、记忆与配置。</p>
        {state?.iteration && <p className="evolution-notice">请先保存或放弃本轮修改，再切换版本。</p>}
        <div className="evolution-version-list">{versions.map((build) => <button key={build.id} disabled={blocked || Boolean(state?.iteration) || build.id === state?.active} onClick={() => act("select", { id: build.id })}>
          <span>{versionLabel(build, state?.releaseTypes?.[build.baseTag || ""])}<small>{build.kind === "local" ? `基于 ${build.baseTag || "所选版本"}` : "GitHub Release"}</small></span><small>{build.id === state?.active ? "正在使用" : "使用此版本"}</small>
        </button>)}</div>
        <details className="evolution-release"><summary>查找发布版本</summary>
          {releases.pending && !releases.data && <p role="status">正在读取发布版本…</p>}
          {releases.error && <p role="alert">{releases.error} <button disabled={busy || releases.pending} onClick={() => void releases.retry()}>重试</button></p>}
          {Boolean(releaseOptions.length) && <><select aria-label="发布版本" disabled={blocked} value={releaseTag} onChange={(event) => {
            setReleaseTag(event.target.value); void onAction("selectUpdate", { tag: event.target.value });
          }}>
            <option value="" disabled>请选择版本</option>
            {releaseTag && !releaseOptions.some(item => item.tag === releaseTag) && <option value={releaseTag} disabled>{releaseTag} · 已不可用</option>}
            {releaseOptions.map((release) => <option key={release.tag} value={release.tag} disabled={!!release.reason}>
              {release.tag} · {release.prerelease ? "预发布版" : "正式版"}{release.tag === active?.baseTag ? " · 正在使用" : ""}{release.reason ? ` · ${release.reason}` : ""}
            </option>)}
          </select>
            <button disabled={blocked || !releaseOptions.some(item => item.tag === releaseTag && !item.reason) || Boolean(state?.iteration)} onClick={() => onAction("download", { tag: releaseTag })}>下载所选版本</button></>}
        </details>
        {state?.iteration && <p>本轮起点：{versionLabel(base)} <button disabled={blocked} onClick={() => setSheet("discard")}><RotateCcw size={14} />放弃修改</button></p>}
        <button disabled={blocked || !state?.baseline} onClick={() => act("recovery")}><ShieldCheck size={16} />独立版本恢复</button>
      </section>}
      {sheet === "save" && <form onSubmit={(event) => { event.preventDefault(); act("save", { name }); }}>
        <p>保存当前效果，替换上一次保存的本地版本。基础版本继续保留。</p>
        <label>名称（可选）<input autoFocus aria-label="本地版本名称" value={name} onChange={(event) => setName(event.target.value)} placeholder={state?.suggestedVersionName ? `留空使用 ${state.suggestedVersionName}` : "留空使用默认名称"} maxLength={80} /></label>
        <button className="evolution-primary" disabled={blocked || !canSave}>确认保存</button>
      </form>}
      {sheet === "discard" && <><p>放弃本轮修改，回到「{versionLabel(base)}」。聊天、记忆和配置不变。{active?.id !== base?.id ? "Cleo 会自动重启。" : ""}</p><button className="evolution-primary" disabled={blocked} onClick={() => act("discard")}>确认放弃</button></>}
      {sheet === "contribute" && <>
        {state?.githubAuth?.status === "connected" ? <EvolutionContribution state={state} busy={busy || running || otherTasksRunning || Boolean(state?.transaction)} onAction={contributionAction}
          onBusy={(value) => { submittingRef.current = value; setSubmitting(value); }}
          onSubmitted={(url) => { setSubmittedUrl(url); submittingRef.current = false; close(); }} />
          : <GithubLogin auth={state?.githubAuth} busy={blocked} onAction={onAction} onContribute={openContribution} />}
      </>}
    </dialog>}
  </header>;
}
