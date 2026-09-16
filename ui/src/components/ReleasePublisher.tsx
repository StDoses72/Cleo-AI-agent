import { useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import type { EvolutionBuild, EvolutionPullRequest, EvolutionState } from "../evolution-types";
import { ReleasePackages } from "./ReleasePackages";

interface ReleaseResult extends Record<string, unknown> {
  releaseUrl: string;
  prerelease: boolean;
  tag: string;
  targetBranch: string;
  commit: string;
  login: string;
}
interface Props {
  state: EvolutionState | null;
  busy: boolean;
  initialUrl?: string;
  buildId?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
}

const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Input: a PR and retained builds. Output: a source label that survives local build pruning. */
function sourceLabel(pr: EvolutionPullRequest, builds: EvolutionBuild[]) {
  const build = builds.find(item => item.id === pr.buildId);
  const name = build?.name || pr.title || (pr.buildId ? `本地版本 ${pr.buildId}` : "PR 合并版本");
  const version = build?.version || build?.baseTag;
  return `PR #${pr.number || pr.url.split("/").at(-1)} · ${name}${version ? ` (${version})` : ""} · ${pr.targetBranch || "目标分支待核验"}`;
}

/** Input: registered PRs and desktop actions. Output: a single-click remote-source release form. */
export function ReleasePublisher({ state, busy, initialUrl = "", buildId, onAction, onBusy }: Props) {
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => all.findIndex(item => item.url === pr.url) === index);
  const [url, setUrl] = useState(() => initialUrl || history.find(pr => buildId && pr.buildId === buildId)?.url || "");
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [result, setResult] = useState<ReleaseResult | null>(null);
  const [packageSource, setPackageSource] = useState<Record<string, unknown> | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const access = state?.githubAuth?.repositoryAccess;
  const receipt = history.find(pr => pr.url === url);
  const locked = busy || !!pending;
  const connected = state?.githubAuth?.status === "connected";
  const denied = access?.status === "checked" && !access.canRelease;
  const validVersion = versionPattern.test(tag.trim()) && tag.trim().length <= 100;
  const run = async (action: "releasePermission" | "publishMergedRelease" | "previewMergedRelease") => {
    if (inFlight.current || locked) return;
    if (action === "publishMergedRelease" && !validVersion) {
      setError("请输入合法版本号，例如 v1.2.3 或 v1.2.3-beta.1。"); return;
    }
    inFlight.current = true; setPending(action); onBusy?.(true); setError("");
    try {
      const value = await onAction(action, action === "publishMergedRelease"
        ? { url, tag: tag.trim(), title: title.trim() || tag.trim(), body, prerelease, login: access?.login }
        : action === "previewMergedRelease" ? { url } : undefined);
      if (action === "publishMergedRelease") {
        if (!value || typeof value !== "object" || !("releaseUrl" in value)) throw new Error("未收到发布结果，请使用相同版本号重试以核对远端状态。");
        setResult(value as ReleaseResult);
      }
      if (action === "previewMergedRelease") {
        if (!value || typeof value !== "object" || !("commit" in value)) throw new Error("未收到来源核验结果，请重试。");
        setPackageSource(value as Record<string, unknown>);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(null); onBusy?.(false); }
  };
  return <section className="release-publisher" aria-label="创建 GitHub Release">
    <h3>创建 GitHub Release</h3>
    <p>仓库：StDoses72/Cleo-AI-agent</p>
    <label>PR 对应版本<select aria-label="发布来源 PR" disabled={locked} value={url} onChange={event => {
      setUrl(event.target.value); setResult(null); setPackageSource(null); setError("");
    }}>
      <option value="">请选择 PR 对应版本</option>
      {history.map(pr => <option key={pr.url} value={pr.url}>{sourceLabel(pr, state?.builds || [])} · {pr.merged ? "已合并" : "合并状态待核验"}</option>)}
    </select></label>
    {!history.length && <p role="status">暂无已记录的 PR，请先完成 PR 提交。</p>}
    {receipt && <p>本次发布来源：{sourceLabel(receipt, state?.builds || [])} <a href={url} target="_blank" rel="noreferrer">查看 PR</a></p>}
    <form noValidate onSubmit={event => { event.preventDefault(); void run("publishMergedRelease"); }}>
      <label>发布版本号<input aria-label="版本标签" value={tag} disabled={locked || !!result} required maxLength={100} placeholder="v1.2.3"
        aria-invalid={!!tag && !validVersion} onChange={event => { setTag(event.target.value); setError(""); }} /></label>
      {(!tag || !validVersion) && <p>请输入版本号，格式为 v1.2.3 或 v1.2.3-beta.1。</p>}
      <label>发布类型<select aria-label="发布类型" value={prerelease ? "pre" : "stable"} disabled={locked || !!result} onChange={event => setPrerelease(event.target.value === "pre")}>
        <option value="stable">正式版（release，默认）</option><option value="pre">预发布版（pre-release）</option>
      </select></label>
      <details><summary>标题与说明（可选）</summary>
      <label>发布标题<input aria-label="发布标题" value={title} disabled={locked || !!result} maxLength={200} placeholder={tag.trim() || "默认使用版本号"} onChange={event => setTitle(event.target.value)} /></label>
      <label>发布说明<textarea aria-label="发布说明" value={body} disabled={locked || !!result} maxLength={20000} onChange={event => setBody(event.target.value)} /></label>
      </details>
      {!connected && <p role="status">请先连接 GitHub。</p>}
      {connected && access && <p role="status">{access.message}</p>}
      <button className="evolution-primary" disabled={locked || !connected || denied || !receipt || !!result}><Upload size={14} />{pending === "publishMergedRelease" ? "正在核验并发布…" : "发布 Release"}</button>
    </form>
    <button disabled={locked} onClick={() => void run("releasePermission")}><RefreshCw size={14} />重新检查发布权限</button>
    {pending === "publishMergedRelease" && <p role="status">{state?.logs.trim().split("\n").at(-1) || "正在检查发布权限、PR 合并状态及提交源码…"}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">{result.prerelease ? "预发布版" : "正式版"} {result.tag} 的 Release 已创建。<a href={result.releaseUrl} target="_blank" rel="noreferrer">查看 GitHub Release</a></p>}
    {result && <p>目标分支：{result.targetBranch} · 发布提交：<code className="release-commit">{result.commit}</code></p>}
    <details><summary>安装包发布状态（可选）</summary>
      {!result && !packageSource && <button disabled={locked || !connected || denied || !receipt} onClick={() => void run("previewMergedRelease")}><RefreshCw size={14} />核验安装包来源</button>}
      {(result || packageSource) && <ReleasePackages key={`${url}:${(result || packageSource)?.commit}`}
        params={result || { ...packageSource, tag: tag.trim(), title: title.trim() || tag.trim(), body, prerelease }}
        disabled={locked || !connected || denied || (result || packageSource)?.login !== access?.login} onAction={onAction} onBusy={onBusy} />}
    </details>
  </section>;
}
