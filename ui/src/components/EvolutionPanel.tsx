import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, GitBranch, GitPullRequest, History, ShieldCheck, PanelRightOpen, X, LoaderCircle, Save, Play, RotateCcw } from "lucide-react";
import type { EvolutionBuild, EvolutionPullRequest, EvolutionState } from "../evolution-types";
import { GithubLogin } from "./GithubLogin";

interface Props {
  children?: ReactNode;
  state: EvolutionState | null;
  error: string | null;
  busy: boolean;
  running: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
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

/** Purpose: Distinguish review status from CI in historical receipts. Input: PR. Output: compact status text. */
function pullRequestStatus(pr: EvolutionPullRequest) {
  const review = pr.merged ? "已合并" : pr.state === "CLOSED" ? "已关闭" : "等待审查";
  const checks = pr.checks === "failed" ? "CI 检查未通过" : pr.checks === "passed" ? "CI 检查通过"
    : pr.checks === "pending" ? "CI 检查待完成" : "";
  return [review, checks, pr.mergeable === "CONFLICTING" ? "存在合并冲突" : ""].filter(Boolean).join(" · ");
}

/** Purpose: Present only version identity and the next useful actions above the normal conversation.
 * Input: evolution state and commands. Output: persistent toolbar with contextual version and contribution dialogs.
 */
export function EvolutionPanel({ children, state, error, busy, running, inspectorOpen, onToggleInspector, onAction, onRetry, onRepair }: Props) {
  const [sheet, setSheet] = useState<"versions" | "contribute" | "history" | "save" | "discard" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [releaseTag, setReleaseTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submissionId = useRef<string | null>(null);
  const [submittedUrl, setSubmittedUrl] = useState<string | null>(null);
  useEffect(() => { if (sheet && !dialog.current?.open) dialog.current?.showModal(); }, [sheet]);
  const close = () => { if (submittingRef.current) return; dialog.current?.close(); setSheet(null); };
  /** Purpose: Start a fresh user intent, independent of every historical PR. Input: none. Output: empty form. */
  const openContribution = () => {
    if (submittingRef.current) return;
    submissionId.current = null; setTitle(""); setBody(""); setSubmittedUrl(null); setSheet("contribute");
  };
  /** Purpose: Close only after confirmed submission; retain the form on failure.
   * Input: current title/body. Output: one pending operation and an acknowledged PR receipt.
   */
  const submit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true);
    try {
      submissionId.current ||= crypto.randomUUID();
      const url = await onAction("submit", { title, body, submissionId: submissionId.current });
      if (typeof url === "string" && url.startsWith("https://github.com/")) {
        setSubmittedUrl(url); submissionId.current = null;
        setTitle(""); setBody(""); submittingRef.current = false; close();
      }
    } finally { submittingRef.current = false; setSubmitting(false); }
  };
  const act = (action: string, params?: Record<string, unknown>) => { close(); onAction(action, params); };
  const active = state?.builds.find((build) => build.id === state.active);
  const base = state?.builds.find((build) => build.id === (state.iteration?.base || state.active));
  const candidate = state?.builds.find((build) => build.id === state.candidate);
  const contribution = candidate || active;
  const hasContribution = contribution?.kind === "local" && Boolean(contribution.sourceHash);
  const versions = state?.builds.filter((build) => build.kind === "official" || build.savedAt) || [];
  const blocked = busy || running || submitting || Boolean(state?.transaction);
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => all.findIndex((item) => item.url === pr.url) === index);
  const validation = state?.validation;
  const verified = Boolean(validation?.status === "passed" && validation.sourceHash
    && validation.candidate === candidate?.id && validation.sourceHash === candidate?.sourceHash && !state?.draftDirty);
  const cases = state?.acceptance?.cases.filter((item) => item.enabled) || [];
  const behaviorPassed = !cases.length || Boolean(state?.acceptance?.fresh && cases.every((item) => {
    const result = state.acceptance?.report?.results.find((entry) => entry.id === item.id);
    return result?.after.status === "passed" && result.before.status !== "error";
  }));
  const canApply = Boolean(verified && behaviorPassed && candidate?.kind === "local" && candidate.id !== state?.active);
  const canSave = Boolean(state?.iteration && active?.kind === "local" && active.id !== state.iteration.base
    && state.candidate === state.active && verified && behaviorPassed);
  const checkFailed = validation?.status === "failed" || validation?.status === "interrupted";
  const failure = error || state?.error || (checkFailed ? validation.message : null);
  const needsCheck = Boolean(state?.iteration && !verified && validation?.status !== "unchanged");
  const details = state?.logs || validation?.details;
  const status = running ? "正在修改，完成后检查" : busy ? (validation?.status === "running" ? validation.message : phases[state?.phase || ""] || "正在准备")
    : state?.transaction ? "正在重启" : checkFailed ? "检查未通过，修改尚不可应用" : failure ? "操作未完成"
    : verified && !behaviorPassed ? "构建通过，行为验收待完成" : canApply ? "检查通过，可以应用" : canSave ? "修改已应用，尚未保存"
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
        {history.length > 0 && <button aria-label="PR 历史" title="PR 历史" onClick={() => setSheet("history")}><History size={16} /><span>历史</span></button>}
        <button aria-label="新建 PR" title="每次发起都会创建新的 PR" disabled={blocked} onClick={openContribution}><GitPullRequest size={17} />新建 PR</button>
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
    {state?.githubAuth?.status !== "connected" && <GithubLogin auth={state?.githubAuth} busy={blocked} onAction={onAction} onContribute={openContribution} />}
    {submittedUrl && <div className="evolution-pr-notice" aria-label="PR 提交结果" role="status">
      <GitPullRequest size={15} /><span>新 PR 已创建</span>
      <a href={submittedUrl} target="_blank" rel="noreferrer">查看 #{submittedUrl.split("/").at(-1)}</a>
      <button aria-label="关闭提交提示" onClick={() => setSubmittedUrl(null)}><X size={14} /></button>
    </div>}
    {failure && <div className="evolution-error" role="alert"><span>{failure}</span>
      {checkFailed && validation.repairable && <button disabled={blocked} onClick={onRepair}>让 Cleo 修复</button>}
      <button disabled={blocked} onClick={checkFailed ? () => onAction("build") : onRetry}>{checkFailed ? "重新检查" : "重试"}</button>
    </div>}
    {state?.lastRestartError && !failure && <p className="evolution-notice">{state.lastRestartError}</p>}
    {details && (busy || failure || canApply) && <details className="evolution-log"><summary>查看检查详情</summary><pre>{details}</pre></details>}
    {children}
    {sheet && <dialog ref={dialog} className="evolution-dialog" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="evolution-dialog-title"><h2>{sheet === "versions" ? "版本" : sheet === "contribute" ? "新建 Pull Request" : sheet === "history" ? "PR 历史" : sheet === "save" ? "保存本地版本" : "放弃本轮修改"}</h2><button aria-label="关闭" onClick={close}><X size={18} /></button></div>
      {sheet === "history" && <>
        <p>这里保留过去的提交。新建 PR 不会更新这些记录对应的远端分支。</p>
        <div className="evolution-pr-history">{history.map((pr) => <article key={pr.url}>
          <div><a href={pr.url} target="_blank" rel="noreferrer">#{pr.number || pr.url.split("/").at(-1)} · {pr.title || "Pull Request"}</a>
            <p>{pullRequestStatus(pr)}</p>
            {pr.submittedAt && <small>{new Date(pr.submittedAt).toLocaleString("zh-CN")}</small>}
          </div><button aria-label={`刷新 PR #${pr.number || pr.url.split("/").at(-1)}`} disabled={blocked} onClick={() => onAction("pullRequest", { url: pr.url })}><RotateCcw size={14} />刷新</button>
        </article>)}</div>
        <button className="evolution-primary" disabled={blocked} onClick={openContribution}><GitPullRequest size={15} />新建 PR</button>
      </>}
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
      {sheet === "contribute" && <><p>每次发起都会创建一个新的 PR，使用独立分支，不会覆盖之前的提交。</p>
        {state?.githubAuth?.status === "connected" ? <p>GitHub 已连接。</p>
          : <button disabled={blocked} onClick={() => act("login")}>连接 GitHub</button>}
        <p>提交版本：{versionLabel(contribution)}</p>
        <p>目标：StDoses72/Cleo-AI-agent · main</p>
        <p>源码基于 {contribution?.baseTag || state?.baseTag || "所选正式版本"}。将该版本包含的改动提交到 StDoses72/Cleo-AI-agent，供维护者审查。</p>
        {!hasContribution ? <p>当前没有经过构建检查的本地版本。请先完成修改和检查。</p>
          : !state?.prepared ? <><p>先恢复这个版本的源码，再提交。准备源码不会发布改动。</p>
            <button disabled={blocked} onClick={() => onAction("prepare")}>{busy && state?.phase === "preparing" ? "正在准备源码…" : "准备当前版本源码"}</button></>
          : <p>源码已准备，可以填写说明并提交。</p>}
        {failure && <p role="alert">{failure}</p>}
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label>PR 标题<input aria-label="PR 标题" placeholder="这次想贡献什么改动？" value={title} disabled={submitting} onChange={(event) => { submissionId.current = null; setTitle(event.target.value); }} required /></label>
          <label>PR 说明<textarea aria-label="PR 说明" placeholder="修改内容和验证结果" value={body} disabled={submitting} onChange={(event) => { submissionId.current = null; setBody(event.target.value); }} required /></label>
          {submitting && <p role="status">{state?.submission?.message || "正在提交到 GitHub，请稍候…"}</p>}
          <button className="evolution-primary" disabled={blocked || !hasContribution || !state?.prepared || !title.trim() || !body.trim()}>{submitting ? <><LoaderCircle size={14} className="evolution-spin" />正在提交…</> : "创建新 PR"}</button>
          <p className="evolution-contribution-hint">成功后自动关闭，可在历史中查看。相同内容的失败重试会确认同一次提交，避免重复创建；关闭后重新发起则是新的 PR。创建成功不代表 CI 通过或已合并。</p>
        </form></>}
    </dialog>}
  </header>;
}
