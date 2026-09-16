import { useRef, useState } from "react";
import { RefreshCw, Upload } from "lucide-react";
import type { EvolutionBuild, EvolutionPullRequest, EvolutionState } from "../evolution-types";

interface Props {
  state: EvolutionState | null;
  busy: boolean;
  initialUrl?: string;
  buildId?: string;
  onAction: (action: string, params?: Record<string, unknown>) => void | Promise<unknown>;
  onBusy?: (busy: boolean) => void;
  onStarted?: () => void;
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
export function ReleasePublisher({ state, busy, initialUrl = "", buildId, onAction, onBusy, onStarted }: Props) {
  const history = [...(state?.pullRequests || []), ...(state?.pullRequest ? [state.pullRequest] : [])]
    .filter((pr, index, all) => all.findIndex(item => item.url === pr.url) === index);
  const [url, setUrl] = useState(() => initialUrl || history.find(pr => buildId && pr.buildId === buildId)?.url || "");
  const [tag, setTag] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [result, setResult] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const access = state?.githubAuth?.repositoryAccess;
  const receipt = history.find(pr => pr.url === url);
  const locked = busy || !!pending || Boolean(state?.releaseJob && !["completed", "failed", "cancelled"].includes(state.releaseJob.phase));
  const connected = state?.githubAuth?.status === "connected";
  const denied = access?.status === "checked" && !access.canRelease;
  const validVersion = versionPattern.test(tag.trim()) && !tag.includes("+") && tag.trim().length <= 100;
  const run = async (action: "releasePermission" | "startRelease") => {
    if (inFlight.current || locked) return;
    if (action === "startRelease" && !validVersion) {
      setError("请输入合法版本号，例如 v1.2.3 或 v1.2.3-beta.1。"); return;
    }
    inFlight.current = true; setPending(action); onBusy?.(true); setError("");
    try {
      const value = await onAction(action, action === "startRelease"
        ? { url, tag: tag.trim(), title: title.trim() || tag.trim(), body, prerelease, login: access?.login }
        : undefined);
      if (action === "startRelease") {
        if (!value || typeof value !== "object" || !("id" in value)) throw new Error("未收到发布任务，请重试核对。");
        setResult(true);
        onBusy?.(false);
        onStarted?.();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { inFlight.current = false; setPending(null); onBusy?.(false); }
  };
  return <section className="release-publisher" aria-label="创建 GitHub Release">
    <h3>创建 GitHub Release</h3>
    <p>自动构建各平台安装包，失败时调用当前 harness 修复；校验、上传完成后正式发布。</p>
    <label>PR 对应版本<select aria-label="发布来源 PR" disabled={locked} value={url} onChange={event => {
      setUrl(event.target.value); setResult(false); setError("");
    }}>
      <option value="">请选择 PR 对应版本</option>
      {history.map(pr => <option key={pr.url} value={pr.url}>{sourceLabel(pr, state?.builds || [])} · {pr.merged ? "已合并" : "合并状态待核验"}</option>)}
    </select></label>
    {!history.length && <p role="status">暂无已记录的 PR，请先完成 PR 提交。</p>}
    {receipt && <p>本次发布来源：{sourceLabel(receipt, state?.builds || [])} <a href={url} target="_blank" rel="noreferrer">查看 PR</a></p>}
    <form noValidate onSubmit={event => { event.preventDefault(); void run("startRelease"); }}>
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
      <button className="evolution-primary" disabled={locked || !connected || denied || !receipt || !!result}><Upload size={14} />{pending === "startRelease" ? "正在启动发布…" : "发布"}</button>
    </form>
    <button disabled={locked} onClick={() => void run("releasePermission")}><RefreshCw size={14} />重新检查发布权限</button>
    {pending === "startRelease" && <p role="status">{state?.logs.trim().split("\n").at(-1) || "正在检查发布权限、PR 合并状态及提交源码…"}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <p role="status">发布任务已启动，可关闭此窗口。在进化页面顶部查看构建、修复和发布进度。</p>}
  </section>;
}
