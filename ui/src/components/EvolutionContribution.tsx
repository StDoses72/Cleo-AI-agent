import { useRef, useState } from "react";
import { useAutomaticRead } from "../useAutomaticRead";
import type { EvolutionBranchRequest, EvolutionState } from "../evolution-types";
import { ContributionMerge } from "./ContributionMerge";
import { ReleasePublisher } from "./ReleasePublisher";

interface Props {
  state: EvolutionState | null;
  busy: boolean;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy: (busy: boolean) => void;
  onSubmitted: (url: string) => void;
}
const forbidden = (value: string) => ["main", "submission-base"].includes(value.trim().replace(/^refs\/heads\//, "").toLowerCase());

/** Purpose: Separate a fork PR from an application for an upstream target branch.
 * Input: saved versions, controller actions. Output: explicit target/version selection and truthful application receipts.
 */
export function EvolutionContribution({ state, busy, onAction, onBusy, onSubmitted }: Props) {
  const [mode, setMode] = useState("existing");
  const [target, setTarget] = useState("");
  const [buildId, setBuildId] = useState(state?.candidate || state?.active || "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<EvolutionBranchRequest | null>(null);
  const attempt = useRef<string | null>(null);
  const inFlight = useRef(false);
  const versions = state?.builds.filter((b) => b.kind === "local" && (b.sourceHash || b.importHash) && (b.savedAt || b.id === state.active || b.id === state.candidate)) || [];
  const version = versions.find((b) => b.id === buildId);
  const locked = busy || pending;
  const account = useRef(state?.githubAuth?.repositoryAccess?.login);
  if (state?.githubAuth?.repositoryAccess?.login) account.current = state.githubAuth.repositoryAccess.login;
  const catalog = useAutomaticRead(`branches:${account.current ?? ""}`, !locked && state?.githubAuth?.status === "connected", async () => {
    const result = await onAction("contributionBranches");
    if (!Array.isArray(result) || result.some(name => typeof name !== "string")) throw new Error("未能读取目标分支，请重试。");
    return result.filter((name: string) => !forbidden(name)) as string[];
  });
  const branches = catalog.data ?? [];
  const change = () => { attempt.current = null; setReceipt(null); setError(""); };
  /** Purpose: Pin one explicit user intent through retries. Input: form. Output: PR or branch application, never a merge. */
  const submit = async () => {
    if (inFlight.current || locked || (mode === "existing" && (!branches.includes(target) || catalog.error))) return;
    if (!target.trim() || forbidden(target)) { setError("请选择独立的接收分支，不能使用 main 或 submission-base 模板。"); return; }
    if (!version?.sourceHash) { setError("请先准备并核验所选版本的源码。"); return; }
    inFlight.current = true; setPending(true); onBusy(true); setError("");
    try {
      attempt.current ||= crypto.randomUUID();
      const result = await onAction(mode === "existing" ? "submit" : "requestBranch", {
        targetBranch: target, buildId, title, body, submissionId: attempt.current,
      });
      if (mode === "existing" && typeof result === "string" && /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(result)) {
        onSubmitted(result);
      } else if (mode === "request" && result && typeof result === "object" && "url" in result) {
        setReceipt(result as EvolutionBranchRequest);
      } else throw new Error("未收到提交结果，请重试核对。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy(false); }
  };
  return <section ref={catalog.root} aria-label="贡献提交">
    <p>提交至 StDoses72/Cleo-AI-agent，由维护者审查。</p>
    <label>提交方式<select aria-label="提交方式" value={mode} disabled={pending} onChange={(e) => { change(); setMode(e.target.value); setTarget(""); }}>
      <option value="existing">向已有分支提交 PR</option>
      <option value="request">申请新建目标分支</option>
    </select></label>
    <label>提交本地版本<select aria-label="提交本地版本" disabled={pending} value={buildId} onChange={(e) => { change(); setBuildId(e.target.value); }}>
      <option value="" disabled>请选择本地版本</option>
      {versions.map((b) => <option key={b.id} value={b.id}>{b.name || `本地版本 · ${b.id}`}{!b.sourceHash ? " · 待准备源码" : ""}</option>)}
    </select></label>
    {version && buildId !== (state?.candidate || state?.active) && <p>提交 PR 前，请先在顶部“选择版本”切换到此版本并准备源码；申请新分支无需切换。</p>}
    {(!state?.prepared || !version?.sourceHash) && <button disabled={locked || buildId !== state?.active} onClick={() => onAction("prepare")}>准备当前版本源码</button>}
    <p>只提交程序源码，不上传本机配置、对话和记忆。</p>
    {catalog.error && <p role="alert">{catalog.error} <button disabled={locked || catalog.pending} onClick={() => void catalog.retry()}>重试</button></p>}
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {mode === "existing" ? <>
        <label>目标分支<select aria-label="目标分支" value={target} disabled={pending || !catalog.data} onChange={(e) => { change(); setTarget(e.target.value); }} required>
          <option value="" disabled>{!catalog.data && catalog.pending ? "正在读取分支…" : "请选择目标分支"}</option>
          {target && !branches.includes(target) && <option value={target} disabled>{target} · 不可用</option>}
          {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select></label>
        {catalog.data && !branches.length && <p>暂无接收分支，可选择“申请新建目标分支”。</p>}
        <label>PR 标题<input aria-label="PR 标题" value={title} disabled={pending} onChange={(e) => { change(); setTitle(e.target.value); }} required /></label>
      </> : <>
        <p>将创建 GitHub Issue 申请；分支就绪后，再提交 PR。</p>
        <label>申请分支名称<input aria-label="申请分支名称" value={target} maxLength={200} disabled={pending} onChange={(e) => { change(); setTarget(e.target.value); }} required /></label>
      </>}
      <label>{mode === "existing" ? "PR 说明" : "申请说明"}<textarea aria-label={mode === "existing" ? "PR 说明" : "申请说明"} value={body} disabled={pending} maxLength={20000} onChange={(e) => { change(); setBody(e.target.value); }} required /></label>
      {forbidden(target) && <p role="alert">不允许以 main 或 submission-base 模板为目标分支。</p>}
      {error && <p role="alert">{error}</p>}
      {mode === "existing" && target && version && <ContributionMerge params={{ targetBranch: target, buildId }}
        revision={`${version.sourceHash}:${state?.draftDirty}`} busy={locked || !state?.prepared || !version.sourceHash || !branches.includes(target)} onAction={onAction} />}
      <button className="evolution-primary" disabled={locked || !!receipt || !version?.sourceHash || !target.trim() || forbidden(target) || !body.trim()
        || (mode === "existing" && (!branches.includes(target) || !!catalog.error || !title.trim() || !state?.prepared))}>
        {pending ? "正在提交…" : mode === "existing" ? "创建新 PR" : "提交分支申请"}
      </button>
    </form>
    <details className="evolution-contribution-hint"><summary>提交规则</summary>
      <p>通过自己的 fork 提交完整源码。接收分支须由维护者从 submission-base 创建并保持为空；main 与模板分支不可直接提交。</p>
      {version?.sourceOrigin === "bundled-import" && <p>此版本的随包源码已核验；这不代表后续构建和测试已通过。</p>}
    </details>
    {state?.githubAuth?.repositoryAccess?.canRelease && <details className="evolution-release">
      <summary>直接创建 Release</summary>
      <ReleasePublisher key={buildId} state={state} buildId={buildId} busy={locked} onAction={onAction} onBusy={onBusy} />
    </details>}
    {receipt?.url && <p role="status">申请已提交，目标分支尚待创建。<a href={receipt.url} target="_blank" rel="noreferrer">查看申请</a></p>}
    {Boolean(state?.branchRequests?.length) && <div className="evolution-pr-history" aria-label="目标分支申请">
      <h3>目标分支申请</h3>
      {state?.branchRequests?.filter((request) => request.url).map((request) => <article key={request.id}>
        <div><a href={request.url} target="_blank" rel="noreferrer">{request.branch}</a>
          <p>{!catalog.data ? "正在确认分支状态…" : branches.includes(request.branch) ? "分支已就绪" : "等待创建分支"}</p>
          <small>申请版本：{request.buildName}</small>
          {branches.includes(request.branch) && <button disabled={pending || !!catalog.error} onClick={() => {
            change(); setMode("existing"); setTarget(request.branch); setBuildId(request.buildId);
            setBody(request.body); setTitle("");
          }}>向该分支提交 PR</button>}
        </div>
      </article>)}
    </div>}
  </section>;
}
