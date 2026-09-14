import { useEffect, useRef, useState } from "react";
import type { EvolutionBranchRequest, EvolutionState } from "../evolution-types";
import { ContributionMerge } from "./ContributionMerge";

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
  const [branches, setBranches] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [buildId, setBuildId] = useState(state?.candidate || state?.active || "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<EvolutionBranchRequest | null>(null);
  const attempt = useRef<string | null>(null);
  const inFlight = useRef(false);
  const versions = state?.builds.filter((b) => b.kind === "local" && b.sourceHash && (b.savedAt || b.id === state.active || b.id === state.candidate)) || [];
  const version = versions.find((b) => b.id === buildId);
  const locked = busy || pending;
  const change = () => { attempt.current = null; setReceipt(null); setError(""); };
  /** Purpose: Refresh real upstream targets. Input: none. Output: selectable branches excluding main. */
  const refresh = async () => {
    const result = await onAction("contributionBranches");
    if (Array.isArray(result)) {
      const names = result.filter((name): name is string => typeof name === "string" && !forbidden(name));
      setBranches(names); setTarget((current) => names.includes(current) ? current : "");
    }
  };
  useEffect(() => { void refresh(); }, []);
  /** Purpose: Pin one explicit user intent through retries. Input: form. Output: PR or branch application, never a merge. */
  const submit = async () => {
    if (inFlight.current || locked) return;
    if (!target.trim() || forbidden(target)) { setError("请选择独立的接收分支，不能使用 main 或 submission-base 模板。"); return; }
    if (!version) { setError("请选择有效的本地版本。"); return; }
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
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(false); onBusy(false); }
  };
  return <section aria-label="贡献提交">
    <p>通过自己的 fork 提交，无需主仓库写权限。所有 PR 均由维护者审查，不自动合并。</p>
    <label>提交方式<select aria-label="提交方式" value={mode} disabled={locked} onChange={(e) => { change(); setMode(e.target.value); setTarget(""); }}>
      <option value="existing">向已有分支提交 PR</option>
      <option value="request">申请新建目标分支</option>
    </select></label>
    <label>提交本地版本<select aria-label="提交本地版本" disabled={locked} value={buildId} onChange={(e) => { change(); setBuildId(e.target.value); }}>
      <option value="" disabled>请选择本地版本</option>
      {versions.map((b) => <option key={b.id} value={b.id}>{b.name || `本地版本 · ${b.id}`}</option>)}
    </select></label>
    {version && buildId !== (state?.candidate || state?.active) && <p>提交 PR 前，请先在顶部“选择版本”切换到此版本并准备源码；申请新分支无需切换。</p>}
    {!state?.prepared && mode === "existing" && <button disabled={locked} onClick={() => onAction("prepare")}>准备当前版本源码</button>}
    <p>目标仓库：StDoses72/Cleo-AI-agent。禁止以 main 为目标；最终是否合并到 main，由 owner/collaborator 在 GitHub 决定。</p>
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {mode === "existing" ? <>
        <p>请选择维护者从 submission-base 创建的空接收分支。Cleo 会提交所选版本的完整程序源码，不包含本机配置、对话和运行数据。已有文件的分支不能用于此流程。</p>
        <label>目标分支<select aria-label="目标分支" value={target} disabled={locked} onChange={(e) => { change(); setTarget(e.target.value); }} required>
          <option value="" disabled>请选择目标分支</option>
          {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select></label>
        <button type="button" disabled={locked} onClick={() => void refresh()}>刷新目标分支</button>
        <label>PR 标题<input aria-label="PR 标题" value={title} disabled={locked} onChange={(e) => { change(); setTitle(e.target.value); }} required /></label>
      </> : <>
        <p>这是通过 GitHub Issue 提交的申请，不代表分支已创建。请 owner/collaborator 将 Source 选为 submission-base，按申请名称创建空分支；创建后刷新并单独提交 PR。</p>
        <label>申请分支名称<input aria-label="申请分支名称" value={target} maxLength={200} disabled={locked} onChange={(e) => { change(); setTarget(e.target.value); }} required /></label>
      </>}
      <label>{mode === "existing" ? "PR 说明" : "申请说明"}<textarea aria-label={mode === "existing" ? "PR 说明" : "申请说明"} value={body} disabled={locked} maxLength={20000} onChange={(e) => { change(); setBody(e.target.value); }} required /></label>
      {forbidden(target) && <p role="alert">不允许以 main 或 submission-base 模板为目标分支。</p>}
      {error && <p role="alert">{error}</p>}
      {mode === "existing" && target && version && <ContributionMerge params={{ targetBranch: target, buildId }} busy={locked} onAction={onAction} />}
      <button className="evolution-primary" disabled={locked || !!receipt || !version || !target.trim() || forbidden(target) || !body.trim()
        || (mode === "existing" && (!branches.includes(target) || !title.trim() || !state?.prepared))}>
        {pending ? "正在提交…" : mode === "existing" ? "创建新 PR" : "提交分支申请"}
      </button>
    </form>
    {receipt?.url && <p role="status">申请已提交，目标分支尚待创建。<a href={receipt.url} target="_blank" rel="noreferrer">查看申请</a></p>}
    {Boolean(state?.branchRequests?.length) && <div className="evolution-pr-history" aria-label="目标分支申请">
      <h3>目标分支申请</h3>
      {state?.branchRequests?.filter((request) => request.url).map((request) => <article key={request.id}>
        <div><a href={request.url} target="_blank" rel="noreferrer">{request.branch}</a>
          <p>{request.status === "ready" ? "已确认分支存在；提交前将验证它为空分支" : "申请已提交，尚未确认分支创建"}</p>
          <small>申请版本：{request.buildName}</small>
          <button disabled={locked} onClick={() => onAction("refreshBranchRequest", { id: request.id })}>检查分支是否已创建</button>
          {request.status === "ready" && <button disabled={locked} onClick={() => {
            change(); setMode("existing"); setTarget(request.branch); setBuildId(request.buildId);
            setBranches((current) => [...new Set([...current, request.branch])]); setBody(request.body); setTitle("");
          }}>向该分支提交 PR</button>}
        </div>
      </article>)}
    </div>}
  </section>;
}
